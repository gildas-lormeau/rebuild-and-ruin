import {
  aimCannons,
  canBuildThisFrame,
  tickGrunts as moveGrunts,
  nextReadyCombined,
} from "../game/index.ts";
import { MESSAGE } from "../protocol/protocol.ts";
import {
  type TimerAccums,
  tickGruntsIfDue,
  type WatcherTimingState,
} from "../runtime/runtime-tick-context.ts";
import type { BattleAnimState } from "../shared/core/battle-types.ts";
import { FID } from "../shared/core/feature-defs.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { PixelPos } from "../shared/core/geometry-types.ts";
import {
  isActivePlayer,
  type PlayerSlotId,
} from "../shared/core/player-slot.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import {
  isHuman,
  type PlayerController,
} from "../shared/core/system-interfaces.ts";
import { type GameState, hasFeature } from "../shared/core/types.ts";
import type { FrameData } from "../shared/ui/overlay-types.ts";
import type { DedupMaps, OnlineSession } from "./online-session.ts";
import {
  clearWatcherPhaseTimer,
  interpolateToward,
  type WatcherNetworkState,
} from "./online-types.ts";
import {
  tickWatcherBattlePhase,
  tickWatcherBuildPhantomsPhase,
  tickWatcherCannonPhantomsPhase,
  tickWatcherTimers,
} from "./online-watcher-battle.ts";

export interface WatcherState extends WatcherNetworkState {
  timing: WatcherTimingState;
  /** Interpolated visual positions shown to the watcher (smoothed toward remoteCrosshairs). */
  watcherCrosshairPos: Map<number, PixelPos>;
  watcherOrbitAngles: Map<number, number>;
  hostMigrationTimer: number;
  hostMigrationText: string;
}

export interface WatcherTickContext {
  getState: () => GameState;
  getFrame: () => FrameData;
  getAccum: () => TimerAccums;
  getBattleAnim: () => BattleAnimState;
  getControllers: () => PlayerController[];
  session: Pick<OnlineSession, "myPlayerId">;
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
    watcherCrosshairPos: new Map(),
    watcherOrbitAngles: new Map(),
    watcherOrbitParams: new Map(),
    remotePiecePhantoms: [],
    hostMigrationTimer: 0,
    hostMigrationText: "",
  };
}

/** Full reset — clears all watcher state. Used when joining a new game or full-state recovery. */
export function resetWatcherState(watcherState: WatcherState): void {
  watcherState.remoteCrosshairs.clear();
  watcherState.remoteCannonPhantoms = [];
  watcherState.remotePiecePhantoms = [];
  watcherState.watcherCrosshairPos.clear();
  watcherState.watcherOrbitAngles.clear();
  watcherState.watcherOrbitParams.clear();
  clearWatcherPhaseTimer(watcherState.timing);
  watcherState.timing.countdownStartTime = 0;
  watcherState.timing.countdownDuration = 0;
  watcherState.hostMigrationTimer = 0;
  watcherState.hostMigrationText = "";
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
  watcherState.watcherOrbitAngles.clear();
  watcherState.watcherOrbitParams.clear();
}

/** Tick the migration announcement timer. Two announcement channels exist:
 *  1. frame.announcement — general-purpose, set directly (reconnection, countdown).
 *     Cleared each frame by clearFrameData(). Used by online-runtime-ws.ts for
 *     "Reconnecting..." / "Disconnected" and by battle countdown.
 *  2. watcherState.hostMigrationText — persists across frames, copied into frame.announcement here.
 *     Used only for host-migration announcements that must survive frame clears.
 *  This function bridges channel 2→1 without overwriting existing game announcements. */
export function tickMigrationAnnouncement(
  watcherState: WatcherState,
  frame: { announcement?: string },
  dt: number,
): void {
  if (watcherState.hostMigrationTimer <= 0) return;
  watcherState.hostMigrationTimer -= dt;
  if (watcherState.hostMigrationTimer > 0) {
    // Don't overwrite game announcements (e.g., Ready/Aim/Fire countdown)
    if (!frame.announcement) {
      frame.announcement = watcherState.hostMigrationText;
    }
  } else {
    watcherState.hostMigrationTimer = 0;
    watcherState.hostMigrationText = "";
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

  const myPlayerId = transitionCtx.session.myPlayerId;
  const localController = getLocalController(
    state,
    transitionCtx.getControllers(),
    myPlayerId,
  );

  if (state.phase === Phase.BATTLE) {
    tickWatcherBattlePhase({
      state,
      frame,
      battleAnim: transitionCtx.getBattleAnim(),
      dt,
      myPlayerId,
      localController,
      remoteCrosshairs: watcherState.remoteCrosshairs,
      watcherCrosshairPos: watcherState.watcherCrosshairPos,
      watcherOrbitAngles: watcherState.watcherOrbitAngles,
      watcherOrbitParams: watcherState.watcherOrbitParams,
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
      myPlayerId,
      localController,
      remoteCannonPhantoms: watcherState.remoteCannonPhantoms,
      lastSentCannonPhantom: transitionCtx.dedup.cannonPhantom,
      sendOpponentCannonPhantom: (msg) => {
        transitionCtx.send({ type: MESSAGE.OPPONENT_CANNON_PHANTOM, ...msg });
      },
    });
  } else if (state.phase === Phase.WALL_BUILD) {
    // Decrement Master Builder lockout (mirrors host-phase-ticks.ts)
    if (
      hasFeature(state, FID.UPGRADES) &&
      state.modern!.masterBuilderLockout > 0
    ) {
      state.modern!.masterBuilderLockout = Math.max(
        0,
        state.modern!.masterBuilderLockout - dt,
      );
    }
    // Gate local controller during lockout — pass null so buildTick is skipped
    const effectiveLocal =
      localController && !canBuildThisFrame(state, localController.playerId)
        ? null
        : localController;
    tickWatcherBuildPhantomsPhase({
      state,
      frame,
      dt,
      localController: effectiveLocal,
      remotePiecePhantoms: watcherState.remotePiecePhantoms,
      lastSentPiecePhantom: transitionCtx.dedup.piecePhantom,
      sendOpponentPiecePhantom: (msg) => {
        transitionCtx.send({ type: MESSAGE.OPPONENT_PHANTOM, ...msg });
      },
    });
  }

  // Grunt movement during build phase (deterministic — runs locally)
  if (state.phase === Phase.WALL_BUILD) {
    tickGruntsIfDue(accum, dt, state, (gameState) => {
      moveGrunts(gameState);
    });
  }

  transitionCtx.render();
}

/** Get the local player's controller, or null if eliminated/spectator. */
function getLocalController(
  state: GameState,
  controllers: readonly PlayerController[],
  myPlayerId: PlayerSlotId,
): PlayerController | null {
  if (
    !isActivePlayer(myPlayerId) ||
    isPlayerEliminated(state.players[myPlayerId])
  )
    return null;
  const ctrl = controllers[myPlayerId];
  return ctrl && isHuman(ctrl) ? ctrl : null;
}
