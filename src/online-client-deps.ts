/**
 * Server message handling and dependency-object builders for online play.
 *
 * Builds the deps bags consumed by online-server-lifecycle.ts and
 * online-server-events.ts, and dispatches incoming server messages.
 */

import type { ServerMessage } from "../server/protocol.ts";
import { applyImpactEvent } from "./battle-system.ts";
import { applyPiecePlacement, canPlacePieceOffsets } from "./build-system.ts";
import { applyCannonPlacement, cannonSlotCost, cannonSlotsUsed, canPlaceCannon } from "./cannon-system.ts";
import { markPlayerReselected } from "./game-engine.ts";
import { GRID_COLS } from "./grid.ts";
import { LifeLostChoice } from "./life-lost.ts";
import { promoteToHost } from "./online-client-promote.ts";
import {
  applyFullState,
  initFromServer,
  runtime,
  showWaitingRoom,
  transitionCtx,
} from "./online-client-runtime.ts";
import { log, session, watcher } from "./online-client-stores.ts";
import {
  handleBattleStartTransition,
  handleBuildEndTransition,
  handleBuildStartTransition,
  handleCannonStartTransition,
  handleCastleWallsTransition,
  handleGameOverTransition,
} from "./online-phase-transitions.ts";
import { handleServerIncrementalMessage } from "./online-server-events.ts";
import { handleServerLifecycleMessage } from "./online-server-lifecycle.ts";
import { PLAYER_NAMES } from "./player-config.ts";
import {
  CannonMode,
  type GameState,
  isReselectPhase,
  MIGRATION_ANNOUNCEMENT_DURATION,
  Mode,
} from "./types.ts";

export function handleServerMessage(msg: ServerMessage): void {
  log(`received: ${msg.type}`);
  if (handleServerLifecycleMessage(msg, buildLifecycleDeps())) return;
  handleServerIncrementalMessage(msg, buildIncrementalDeps());
}

function buildLifecycleDeps() {
  return {
    log,
    isHost: session.isHost,
    getState: () => runtime.rs.state,
    getLifeLostDialog: () => runtime.lifeLost.get(),
    clearLifeLostDialog: () => { runtime.lifeLost.set(null); },
    isLifeLostMode: () => runtime.rs.mode === Mode.LIFE_LOST,
    setGameMode: () => { runtime.rs.mode = Mode.GAME; },
    setLobbyWaitTimer: (s: number) => { session.lobbyWaitTimer = s; },
    setRoomSettings: (bl: number, hp: number) => { session.roomBattleLength = bl; session.roomCannonMaxHp = hp; },
    showWaitingRoom,
    setLobbyStartTime: (t: number) => { session.lobbyStartTime = t; },
    now: () => performance.now(),
    lobbyJoined: runtime.rs.lobby.joined,
    occupiedSlots: session.occupiedSlots,
    remoteHumanSlots: session.remoteHumanSlots,
    getMyPlayerId: () => session.myPlayerId,
    setMyPlayerId: (pid: number) => { session.myPlayerId = pid; },
    createErrorEl: document.getElementById("create-error")!,
    joinErrorEl: document.getElementById("join-error")!,
    initFromServer,
    enterTowerSelection: () => runtime.selection.enter(),
    onCastleWalls: (msg: ServerMessage) => handleCastleWallsTransition(msg, transitionCtx),
    onCannonStart: (msg: ServerMessage) => handleCannonStartTransition(msg, transitionCtx),
    onBattleStart: (msg: ServerMessage) => handleBattleStartTransition(msg, transitionCtx),
    onBuildStart: (msg: ServerMessage) => handleBuildStartTransition(msg, transitionCtx),
    onBuildEnd: (msg: ServerMessage) => handleBuildEndTransition(msg, transitionCtx),
    onGameOver: (msg: ServerMessage) => handleGameOverTransition(msg, transitionCtx),
    setAnnouncement: (text: string) => {
      watcher.migrationText = text;
      watcher.migrationTimer = MIGRATION_ANNOUNCEMENT_DURATION;
    },
    getHostMigrationSeq: () => session.hostMigrationSeq,
    setHostMigrationSeq: (seq: number) => { session.hostMigrationSeq = seq; },
    bumpHostMigrationSeq: () => { session.hostMigrationSeq++; },
    playerNames: PLAYER_NAMES,
    promoteToHost,
    applyFullState,
  };
}

function buildIncrementalDeps() {
  return {
    log,
    isHost: session.isHost,
    getState: () => runtime.rs.state,
    remoteHumanSlots: session.remoteHumanSlots,
    selectionStates: runtime.selection.getStates(),
    syncSelectionOverlay: () => runtime.selection.syncOverlay(),
    isCastleReselectPhase: () => isReselectPhase(runtime.rs.state.phase),
    onRemotePlayerReselected: (playerId: number) => {
      markPlayerReselected(runtime.rs.state, playerId);
      runtime.rs.reselectionPids.push(playerId);
    },
    confirmSelectionForPlayer: (playerId: number, isReselect: boolean) => {
      runtime.selection.confirm(playerId, isReselect);
    },
    allSelectionsConfirmed: () => runtime.selection.allConfirmed(),
    finishReselection: () => runtime.selection.finishReselection(),
    finishSelection: () => runtime.selection.finish(),
    applyPiecePlacement,
    canApplyPiecePlacement: (state: GameState, playerId: number, offsets: readonly [number, number][], row: number, col: number) =>
      canPlacePieceOffsets(state, playerId, offsets, row, col),
    applyCannonPlacement: (state: GameState, playerId: number, row: number, col: number, mode: string) => {
      applyCannonPlacement(state.players[playerId]!, row, col, mode as CannonMode, state);
    },
    canApplyCannonPlacement: (state: GameState, playerId: number, row: number, col: number, mode: string) => {
      const player = state.players[playerId];
      if (!player) return false;
      const maxCannons = state.cannonLimits[playerId] ?? 0;
      const normalizedMode = mode as CannonMode;
      if (cannonSlotsUsed(player) + cannonSlotCost(normalizedMode) > maxCannons) return false;
      return canPlaceCannon(player, row, col, normalizedMode, state);
    },
    applyImpactEvent,
    gridCols: GRID_COLS,
    remoteCrosshairs: watcher.remoteCrosshairs,
    watcherOrbitParams: watcher.orbitParams,
    getRemotePiecePhantoms: () => watcher.remotePiecePhantoms,
    setRemotePiecePhantoms: (value: typeof watcher.remotePiecePhantoms) => { watcher.remotePiecePhantoms = value; },
    getRemoteCannonPhantoms: () => watcher.remoteCannonPhantoms,
    setRemoteCannonPhantoms: (value: typeof watcher.remoteCannonPhantoms) => { watcher.remoteCannonPhantoms = value; },
    getLifeLostDialog: () => runtime.lifeLost.get(),
    queueEarlyLifeLostChoice: (playerId: number, choice: LifeLostChoice) => {
      session.earlyLifeLostChoices.set(playerId, choice);
    },
  };
}
