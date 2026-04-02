/**
 * Watcher (non-host) state and tick logic for online play.
 *
 * Groups watcher-specific mutable state and provides the per-frame tick
 * functions that online-client.ts wires into the game runtime.
 */

import { MESSAGE } from "../server/protocol.ts";
import { aimCannons, nextReadyCombined } from "./battle-system.ts";
import {
  CROSSHAIR_SPEED,
  isHuman,
  type PlayerController,
} from "./controller-interfaces.ts";
import type { PixelPos } from "./geometry-types.ts";
import { tickGrunts } from "./grunt-movement.ts";
import type { DedupMaps, OnlineSession } from "./online-session.ts";
import {
  clearWatcherPhaseTimer,
  interpolateToward,
  type WatcherNetworkState,
  type WatcherTimingState,
} from "./online-types.ts";
import {
  tickWatcherBattlePhase,
  tickWatcherBuildPhantomsPhase,
  tickWatcherCannonPhantomsPhase,
  tickWatcherTimers,
} from "./online-watcher-battle.ts";
import type { FrameData } from "./render-types.ts";
import { type TimerAccums, tickGruntsIfDue } from "./tick-context.ts";
import { type BattleAnimState, type GameState, Phase } from "./types.ts";

export interface WatcherState extends WatcherNetworkState {
  timing: WatcherTimingState;
  /** Interpolated visual positions shown to the watcher (smoothed toward remoteCrosshairs). */
  crosshairPos: Map<number, PixelPos>;
  idlePhases: Map<number, number>;
  migrationTimer: number;
  migrationText: string;
}

export interface WatcherTickContext {
  getState: () => GameState;
  getFrame: () => FrameData;
  getAccum: () => TimerAccums;
  getBattleAnim: () => BattleAnimState;
  getControllers: () => PlayerController[];
  session: Pick<OnlineSession, "onlinePlayerId">;
  dedup: Pick<DedupMaps, "cannonPhantom" | "piecePhantom">;
  send: (msg: { type: string; [key: string]: unknown }) => void;
  logThrottled: (key: string, msg: string) => void;
  maybeSendAimUpdate: (x: number, y: number) => void;
  render: () => void;
  now: () => number;
}

export function createWatcherState(): WatcherState {
  return {
    timing: {
      phaseStartTime: 0,
      phaseDuration: 0,
      countdownStartTime: 0,
      countdownDuration: 0,
    },
    remoteCrosshairs: new Map(),
    remoteCannonPhantoms: [],
    crosshairPos: new Map(),
    idlePhases: new Map(),
    orbitParams: new Map(),
    remotePiecePhantoms: [],
    migrationTimer: 0,
    migrationText: "",
  };
}

/** Full reset — clears all watcher state. Used when joining a new game or full-state recovery. */
export function resetWatcherState(watcherState: WatcherState): void {
  watcherState.remoteCrosshairs.clear();
  watcherState.remoteCannonPhantoms = [];
  watcherState.remotePiecePhantoms = [];
  watcherState.crosshairPos.clear();
  watcherState.idlePhases.clear();
  watcherState.orbitParams.clear();
  clearWatcherPhaseTimer(watcherState.timing);
  watcherState.timing.countdownStartTime = 0;
  watcherState.timing.countdownDuration = 0;
  watcherState.migrationTimer = 0;
  watcherState.migrationText = "";
}

/**
 * Partial reset for host promotion. Clears timing and AI-driven state
 * but keeps remoteCrosshairs/phantoms/crosshairPos — the new host still
 * uses those for remote human players via extendCrosshairs.
 */
export function resetWatcherTimingForHostPromotion(
  watcherState: WatcherState,
): void {
  clearWatcherPhaseTimer(watcherState.timing);
  watcherState.timing.countdownStartTime = 0;
  watcherState.timing.countdownDuration = 0;
  watcherState.idlePhases.clear();
  watcherState.orbitParams.clear();
}

/** Tick the migration announcement timer. Two announcement channels exist:
 *  1. frame.announcement — general-purpose, set directly (reconnection, countdown).
 *     Cleared each frame by clearFrameData(). Used by runtime-online-ws.ts for
 *     "Reconnecting..." / "Disconnected" and by battle countdown.
 *  2. watcherState.migrationText — persists across frames, copied into frame.announcement here.
 *     Used only for host-migration announcements that must survive frame clears.
 *  This function bridges channel 2→1 without overwriting existing game announcements. */
export function tickMigrationAnnouncement(
  watcherState: WatcherState,
  frame: { announcement?: string },
  dt: number,
): void {
  if (watcherState.migrationTimer <= 0) return;
  watcherState.migrationTimer -= dt;
  if (watcherState.migrationTimer > 0) {
    // Don't overwrite game announcements (e.g., Ready/Aim/Fire countdown)
    if (!frame.announcement) {
      frame.announcement = watcherState.migrationText;
    }
  } else {
    watcherState.migrationTimer = 0;
    watcherState.migrationText = "";
  }
}

export function tickWatcher(
  watcherState: WatcherState,
  dt: number,
  transitionCtx: WatcherTickContext,
): void {
  const state = transitionCtx.getState();
  const frame = transitionCtx.getFrame();
  const accum = transitionCtx.getAccum();

  tickWatcherTimers(state, frame, watcherState.timing, transitionCtx.now);

  const onlinePlayerId = transitionCtx.session.onlinePlayerId;
  const localController = getLocalController(
    state,
    transitionCtx.getControllers(),
    onlinePlayerId,
  );

  if (state.phase === Phase.BATTLE) {
    tickWatcherBattlePhase({
      state,
      frame,
      battleAnim: transitionCtx.getBattleAnim(),
      dt,
      onlinePlayerId,
      localController,
      remoteCrosshairs: watcherState.remoteCrosshairs,
      watcherCrosshairPos: watcherState.crosshairPos,
      watcherIdlePhases: watcherState.idlePhases,
      watcherOrbitParams: watcherState.orbitParams,
      crosshairSpeed: CROSSHAIR_SPEED,
      logThrottled: transitionCtx.logThrottled,
      interpolateToward,
      nextReadyCombined,
      maybeSendAimUpdate: transitionCtx.maybeSendAimUpdate,
      aimCannons,
    });
  } else if (state.phase === Phase.CANNON_PLACE) {
    tickWatcherCannonPhantomsPhase({
      state,
      frame,
      dt,
      onlinePlayerId,
      localController,
      remoteCannonPhantoms: watcherState.remoteCannonPhantoms,
      lastSentCannonPhantom: transitionCtx.dedup.cannonPhantom,
      sendOpponentCannonPhantom: (msg) => {
        transitionCtx.send({ type: MESSAGE.OPPONENT_CANNON_PHANTOM, ...msg });
      },
    });
  } else if (state.phase === Phase.WALL_BUILD) {
    tickWatcherBuildPhantomsPhase({
      state,
      frame,
      dt,
      localController,
      remotePiecePhantoms: watcherState.remotePiecePhantoms,
      lastSentPiecePhantom: transitionCtx.dedup.piecePhantom,
      sendOpponentPiecePhantom: (msg) => {
        transitionCtx.send({ type: MESSAGE.OPPONENT_PHANTOM, ...msg });
      },
    });
  }

  // Grunt movement during build phase (deterministic — runs locally)
  if (state.phase === Phase.WALL_BUILD) {
    tickGruntsIfDue(accum, dt, state, tickGrunts);
  }

  transitionCtx.render();
}

/** Get the local player's controller, or null if eliminated/spectator. */
function getLocalController(
  state: GameState,
  controllers: readonly PlayerController[],
  onlinePlayerId: number,
): PlayerController | null {
  if (onlinePlayerId < 0 || state.players[onlinePlayerId]?.eliminated)
    return null;
  const ctrl = controllers[onlinePlayerId];
  return ctrl && isHuman(ctrl) ? ctrl : null;
}
