/**
 * Watcher (non-host) state and tick logic for online play.
 *
 * Groups watcher-specific mutable state and provides the per-frame tick
 * functions that online-client.ts wires into the game runtime.
 */

import { MSG, type ServerMessage } from "../server/protocol.ts";
import {
  aimCannons,
  nextReadyCombined,
} from "./battle-system.ts";
import { isHuman } from "./controller-factory.ts";
import {
  CROSSHAIR_SPEED,
  type OrbitParams,
  type PlayerController,
} from "./controller-interfaces.ts";
import type { BattleAnimState, FrameData, TimerAccums } from "./game-ui-types.ts";
import type { PixelPos } from "./geometry-types.ts";
import { TILE_SIZE } from "./grid.ts";
import { tickGrunts } from "./grunt-system.ts";
import type { CheckpointDeps } from "./online-checkpoints.ts";
import {
  applyBattleStartCheckpoint,
  applyBuildStartCheckpoint,
  applyCannonStartCheckpoint,
} from "./online-checkpoints.ts";
import { type CannonPhantom, interpolateToward, type PiecePhantom, type WatcherTimingState } from "./online-types.ts";
import {
  tickWatcherBattlePhase,
  tickWatcherBuildPhantomsPhase,
  tickWatcherCannonPhantomsPhase,
  tickWatcherTimers,
} from "./online-watcher-battle.ts";
import { type GameState, Phase } from "./types.ts";

interface WatcherState {
  timing: WatcherTimingState;
  remoteCrosshairs: Map<number, PixelPos>;
  remoteCannonPhantoms: CannonPhantom[];
  crosshairPos: Map<number, PixelPos>;
  idlePhases: Map<number, number>;
  orbitParams: Map<number, OrbitParams>;
  remotePiecePhantoms: PiecePhantom[];
  migrationTimer: number;
  migrationText: string;
}

export interface WatcherTickContext {
  getState: () => GameState;
  getFrame: () => FrameData;
  getAccum: () => TimerAccums;
  getBattleAnim: () => BattleAnimState;
  getControllers: () => PlayerController[];
  getMyPlayerId: () => number;
  lastSentCannonPhantom: Map<number, string>;
  lastSentPiecePhantom: Map<number, string>;
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

export function resetWatcherState(ws: WatcherState): void {
  ws.remoteCrosshairs.clear();
  ws.remoteCannonPhantoms = [];
  ws.remotePiecePhantoms = [];
  ws.crosshairPos.clear();
  ws.idlePhases.clear();
  ws.orbitParams.clear();
  ws.timing.phaseStartTime = 0;
  ws.timing.phaseDuration = 0;
  ws.timing.countdownStartTime = 0;
  ws.timing.countdownDuration = 0;
}

export function tickMigrationAnnouncement(
  ws: WatcherState,
  frame: { announcement?: string },
  dt: number,
): void {
  if (ws.migrationTimer <= 0) return;
  ws.migrationTimer -= dt;
  if (ws.migrationTimer > 0) {
    // Don't overwrite game announcements (e.g., Ready/Aim/Fire countdown)
    if (!frame.announcement) {
      frame.announcement = ws.migrationText;
    }
  } else {
    ws.migrationTimer = 0;
    ws.migrationText = "";
  }
}

export function tickWatcher(
  ws: WatcherState,
  dt: number,
  ctx: WatcherTickContext,
): void {
  const state = ctx.getState();
  const frame = ctx.getFrame();
  const accum = ctx.getAccum();

  tickWatcherTimers(state, frame, ws.timing, ctx.now);

  const myPlayerId = ctx.getMyPlayerId();
  const myHuman = getLocalHuman(state, ctx.getControllers(), myPlayerId);

  if (state.phase === Phase.BATTLE) {
    tickWatcherBattlePhase({
      state,
      frame,
      battleAnim: ctx.getBattleAnim(),
      dt,
      myPlayerId,
      myHuman,
      remoteCrosshairs: ws.remoteCrosshairs,
      watcherCrosshairPos: ws.crosshairPos,
      watcherIdlePhases: ws.idlePhases,
      watcherOrbitParams: ws.orbitParams,
      crosshairSpeed: CROSSHAIR_SPEED,
      tileSize: TILE_SIZE,
      logThrottled: ctx.logThrottled,
      interpolateToward,
      nextReadyCombined,
      maybeSendAimUpdate: ctx.maybeSendAimUpdate,
      aimCannons,
    });
  } else if (state.phase === Phase.CANNON_PLACE) {
    tickWatcherCannonPhantomsPhase({
      state,
      frame,
      dt,
      myPlayerId,
      myHuman,
      remoteCannonPhantoms: ws.remoteCannonPhantoms,
      lastSentCannonPhantom: ctx.lastSentCannonPhantom,
      sendOpponentCannonPhantom: (msg) => {
        ctx.send({ type: MSG.OPPONENT_CANNON_PHANTOM, ...msg });
      },
    });
  } else if (state.phase === Phase.WALL_BUILD) {
    tickWatcherBuildPhantomsPhase({
      state,
      frame,
      dt,
      myHuman,
      remotePiecePhantoms: ws.remotePiecePhantoms,
      lastSentPiecePhantom: ctx.lastSentPiecePhantom,
      sendOpponentPiecePhantom: (msg) => {
        ctx.send({ type: MSG.OPPONENT_PHANTOM, ...msg });
      },
    });
  }

  // Grunt movement during build phase (deterministic — runs locally)
  if (state.phase === Phase.WALL_BUILD) {
    accum.grunt += dt;
    if (accum.grunt >= 1.0) {
      accum.grunt -= 1.0;
      tickGrunts(state);
    }
  }

  ctx.render();
}

export function applyCannonStartData(
  ws: WatcherState,
  msg: ServerMessage,
  state: GameState,
  battleAnim: BattleAnimState,
  accum: TimerAccums,
  snapshotTerritory: () => Set<number>[],
): void {
  applyCannonStartCheckpoint(
    msg,
    buildCheckpointDeps(ws, state, battleAnim, accum, snapshotTerritory),
  );
}

export function applyBattleStartData(
  ws: WatcherState,
  msg: ServerMessage,
  state: GameState,
  battleAnim: BattleAnimState,
  accum: TimerAccums,
  snapshotTerritory: () => Set<number>[],
): void {
  applyBattleStartCheckpoint(
    msg,
    buildCheckpointDeps(ws, state, battleAnim, accum, snapshotTerritory),
  );
}

export function applyBuildStartData(
  ws: WatcherState,
  msg: ServerMessage,
  state: GameState,
  battleAnim: BattleAnimState,
  accum: TimerAccums,
  snapshotTerritory: () => Set<number>[],
): void {
  applyBuildStartCheckpoint(
    msg,
    buildCheckpointDeps(ws, state, battleAnim, accum, snapshotTerritory),
  );
}

/** Get the local human controller, or null if eliminated/watcher. */
function getLocalHuman(
  state: GameState,
  controllers: PlayerController[],
  myPlayerId: number,
): PlayerController | null {
  if (myPlayerId < 0 || state.players[myPlayerId]?.eliminated) return null;
  const ctrl = controllers[myPlayerId];
  return ctrl && isHuman(ctrl) ? ctrl : null;
}

function buildCheckpointDeps(
  ws: WatcherState,
  state: GameState,
  battleAnim: BattleAnimState,
  accum: TimerAccums,
  snapshotTerritory: () => Set<number>[],
): CheckpointDeps {
  return {
    state,
    battleAnim,
    accum,
    remoteCrosshairs: ws.remoteCrosshairs,
    watcherCrosshairPos: ws.crosshairPos,
    watcherOrbitParams: ws.orbitParams,
    watcherIdlePhases: ws.idlePhases,
    snapshotTerritory,
  };
}
