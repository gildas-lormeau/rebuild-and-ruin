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
import type {
  CannonPhantom,
  PiecePhantom,
} from "../shared/core/phantom-types.ts";
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
  /** Sink for the runtime's `remotePhantoms.piecePhantoms` slot.
   *  Forwarded into `tickWatcherBuildPhantomsPhase` so render + touch
   *  read remote piece phantoms from the runtime slot. */
  setRemotePiecePhantoms: (phantoms: readonly PiecePhantom[]) => void;
  /** Sink for the runtime's `remotePhantoms.cannonPhantoms` slot.
   *  Forwarded into `tickWatcherCannonPhantomsPhase` so render + touch
   *  read remote cannon phantoms from the runtime slot. */
  setRemoteCannonPhantoms: (phantoms: readonly CannonPhantom[]) => void;
  /** Fires when the watcher-side `MODIFIER_REVEAL` phase timer expires.
   *  The caller binds this to `enter-battle` dispatch — `tickWatcher`
   *  stays phase-agnostic and doesn't import phase-machine types (that
   *  would be an upward layer reach from systems into assembly). Host
   *  and watcher both run their own timer and dispatch independently,
   *  so no network message is exchanged for this edge. */
  onModifierRevealExpired: () => void;
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
  clearWatcherPhaseTimer(watcherState.timing);
  watcherState.timing.countdownStartTime = 0;
  watcherState.timing.countdownDuration = 0;
  watcherState.hostMigrationTimer = 0;
  watcherState.hostMigrationText = "";
}

/**
 * Partial reset for host promotion. Clears timing
 * but keeps remoteCrosshairs/phantoms/crosshairPos — the new host still
 * uses those for remote human players via extendCrosshairs.
 */
export function resetWatcherTimingForHostPromotion(
  watcherState: WatcherState,
): void {
  clearWatcherPhaseTimer(watcherState.timing);
  watcherState.timing.countdownStartTime = 0;
  watcherState.timing.countdownDuration = 0;
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

  tickWatcherTimers(
    state,
    frame,
    watcherState.timing,
    transitionCtx.now,
    accum,
    dt,
  );

  const myPlayerId = transitionCtx.session.myPlayerId;
  const localController = getLocalController(
    state,
    transitionCtx.getControllers(),
    myPlayerId,
  );

  switch (state.phase) {
    case Phase.BATTLE:
      tickWatcherBattlePhase({
        state,
        frame,
        battleAnim: transitionCtx.getBattleAnim(),
        dt,
        myPlayerId,
        localController,
        remoteCrosshairs: watcherState.remoteCrosshairs,
        watcherCrosshairPos: watcherState.watcherCrosshairPos,
        logThrottled: transitionCtx.logThrottled,
        interpolateToward,
        nextReadyCombined,
        maybeSendAimUpdate: transitionCtx.maybeSendAimUpdate,
        aimCannons,
      });
      break;
    case Phase.MODIFIER_REVEAL:
      // MODIFIER_REVEAL is a deterministic-duration timed phase. Both
      // sides decrement `state.timer` independently (host via
      // `tickModifierRevealPhase`, watcher via `tickWatcherTimers`
      // synthesizing from wall clock). When it expires, the watcher
      // dispatches `enter-battle` locally — no network message is
      // exchanged, the transition runs against the state already
      // mirrored here.
      if (state.timer <= 0) {
        transitionCtx.onModifierRevealExpired();
      }
      break;
    case Phase.CANNON_PLACE:
      tickWatcherCannonPhantomsPhase({
        state,
        dt,
        myPlayerId,
        localController,
        remoteCannonPhantoms: watcherState.remoteCannonPhantoms,
        lastSentCannonPhantom: transitionCtx.dedup.cannonPhantom,
        sendOpponentCannonPhantom: (msg) => {
          transitionCtx.send({
            type: MESSAGE.OPPONENT_CANNON_PHANTOM,
            ...msg,
          });
        },
        setRemoteCannonPhantoms: transitionCtx.setRemoteCannonPhantoms,
      });
      break;
    case Phase.WALL_BUILD: {
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
        dt,
        localController: effectiveLocal,
        remotePiecePhantoms: watcherState.remotePiecePhantoms,
        lastSentPiecePhantom: transitionCtx.dedup.piecePhantom,
        sendOpponentPiecePhantom: (msg) => {
          transitionCtx.send({ type: MESSAGE.OPPONENT_PHANTOM, ...msg });
        },
        setRemotePiecePhantoms: transitionCtx.setRemotePiecePhantoms,
      });
      break;
    }
    case Phase.CASTLE_SELECT:
    case Phase.CASTLE_RESELECT:
    case Phase.UPGRADE_PICK:
      // Watcher sits in a non-GAME mode for these phases (selection /
      // upgrade-pick dialog). AI selection on the watcher is driven by
      // `runtime-selection.ts` `tickSelection`'s non-host branch
      // (Mode.SELECTION); tickWatcher (which only fires from Mode.GAME
      // via `tickGame`) doesn't need to do anything here.
      break;
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
