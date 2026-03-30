/**
 * Server message handling and dependency-object builders for online play.
 *
 * Builds the deps bags consumed by online-server-lifecycle.ts and
 * online-server-events.ts, and dispatches incoming server messages.
 */

import type { ServerMessage } from "../server/protocol.ts";
import { applyImpactEvent } from "./battle-system.ts";
import { applyPiecePlacement, canPlacePieceOffsets } from "./build-system.ts";
import {
  applyCannonPlacement,
  cannonSlotCost,
  cannonSlotsUsed,
  canPlaceCannon,
} from "./cannon-system.ts";
import { MIGRATION_ANNOUNCEMENT_DURATION } from "./game-constants.ts";
import { markPlayerReselected } from "./game-engine.ts";
import { GRID_COLS } from "./grid.ts";
import { promoteToHost } from "./online-client-promote.ts";
import {
  applyFullState,
  initFromServer,
  runtime,
  showWaitingRoom,
  transitionCtx,
} from "./online-client-runtime.ts";
import { devLog, session, watcher } from "./online-client-stores.ts";
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
import { toCannonMode } from "./online-types.ts";
import { PLAYER_NAMES } from "./player-config.ts";
import {
  type GameState,
  isReselectPhase,
  LifeLostChoice,
  Mode,
} from "./types.ts";

// These deps objects are built once and reused for the session lifetime.
// CRITICAL: All mutable state must be accessed via closures (arrow functions that
// re-read the current value), NOT captured values. This is because session state
// changes at runtime (e.g. isHost flips during host migration, myPlayerId changes
// on slot selection). A captured value would go stale silently.
//   CORRECT:   isHost: () => session.isHost          // re-reads current value
//   WRONG:     isHost: session.isHost                 // captured at build time, stale after migration
// When adding new fields, always wrap mutable state in a closure.
const lifecycleDeps = buildLifecycleDeps();
const incrementalDeps = buildIncrementalDeps();

export function handleServerMessage(msg: ServerMessage): void {
  devLog(`received: ${msg.type}`);
  if (handleServerLifecycleMessage(msg, lifecycleDeps)) return;
  handleServerIncrementalMessage(msg, incrementalDeps);
}

/** Deps for server lifecycle messages (join, start, phase transitions, migration).
 *  Sub-objects group related concerns: session, lobby, ui, game, transitions, migration. */
function buildLifecycleDeps() {
  return {
    log: devLog,
    now: () => performance.now(),

    // ── Session identity & migration tracking ──
    session: {
      isHost: () => session.isHost,
      getMyPlayerId: () => session.myPlayerId,
      setMyPlayerId: (pid: number) => {
        session.myPlayerId = pid;
      },
      /** Host migration sequence counter — incremented each time a new host takes over.
       *  Watchers compare their local seq against incoming checkpoint seq to detect
       *  stale state: if checkpoint.seq > local.seq, the watcher missed a migration
       *  and should request full-state recovery. The host includes this in FULL_STATE
       *  messages so recovering watchers can sync up. */
      getHostMigrationSeq: () => session.hostMigrationSeq,
      setHostMigrationSeq: (seq: number) => {
        session.hostMigrationSeq = seq;
      },
      bumpHostMigrationSeq: () => {
        session.hostMigrationSeq++;
      },
    },

    // ── Lobby UI & slot management ──
    lobby: {
      setWaitTimer: (lobbyWaitTimer: number) => {
        session.lobbyWaitTimer = lobbyWaitTimer;
      },
      setRoomSettings: (battleLength: number, cannonMaxHp: number) => {
        session.roomBattleLength = battleLength;
        session.roomCannonMaxHp = cannonMaxHp;
      },
      showWaitingRoom,
      setStartTime: (timestamp: number) => {
        session.lobbyStartTime = timestamp;
      },
      joined: runtime.runtimeState.lobby.joined,
      occupiedSlots: session.occupiedSlots,
      remoteHumanSlots: session.remoteHumanSlots,
    },

    // ── UI state access (life-lost dialog, mode, announcements) ──
    ui: {
      getLifeLostDialog: () => runtime.lifeLost.get(),
      clearLifeLostDialog: () => {
        runtime.lifeLost.set(null);
      },
      isLifeLostMode: () => runtime.runtimeState.mode === Mode.LIFE_LOST,
      setGameMode: () => {
        runtime.runtimeState.mode = Mode.GAME;
      },
      setAnnouncement: (text: string) => {
        watcher.migrationText = text;
        watcher.migrationTimer = MIGRATION_ANNOUNCEMENT_DURATION;
      },
      createErrorEl: document.getElementById("create-error")!,
      joinErrorEl: document.getElementById("join-error")!,
    },

    // ── Game state & initialization ──
    game: {
      getState: () => runtime.runtimeState.state,
      initFromServer,
      enterTowerSelection: () => runtime.selection.enter(),
    },

    // ── Phase transition handlers (watcher-side) ──
    transitions: {
      onCastleWalls: (msg: ServerMessage) =>
        handleCastleWallsTransition(msg, transitionCtx),
      onCannonStart: (msg: ServerMessage) =>
        handleCannonStartTransition(msg, transitionCtx),
      onBattleStart: (msg: ServerMessage) =>
        handleBattleStartTransition(msg, transitionCtx),
      onBuildStart: (msg: ServerMessage) =>
        handleBuildStartTransition(msg, transitionCtx),
      onBuildEnd: (msg: ServerMessage) =>
        handleBuildEndTransition(msg, transitionCtx),
      onGameOver: (msg: ServerMessage) =>
        handleGameOverTransition(msg, transitionCtx),
    },

    // ── Host migration & full-state recovery ──
    migration: {
      playerNames: PLAYER_NAMES,
      promoteToHost,
      applyFullState,
    },
  };
}

/** Deps for incremental in-game messages (placement, cannon, aim, life-lost).
 *  Flat structure — groups are implicit by naming (selection*, cannon*, phantom*, lifeLost*). */
function buildIncrementalDeps() {
  return {
    log: devLog,
    isHost: () => session.isHost,
    getState: () => runtime.runtimeState.state,
    remoteHumanSlots: session.remoteHumanSlots,
    selectionStates: runtime.selection.getStates(),
    syncSelectionOverlay: () => runtime.selection.syncOverlay(),
    isCastleReselectPhase: () =>
      isReselectPhase(runtime.runtimeState.state.phase),
    onRemotePlayerReselected: (playerId: number) => {
      markPlayerReselected(runtime.runtimeState.state, playerId);
      runtime.runtimeState.reselectionPids.push(playerId);
    },
    confirmSelectionAndStartBuild: (playerId: number, isReselect: boolean) => {
      runtime.selection.confirm(playerId, isReselect);
    },
    allSelectionsConfirmed: () => runtime.selection.allConfirmed(),
    finishReselection: () => runtime.selection.finishReselection(),
    finishSelection: () => runtime.selection.finish(),
    applyPiecePlacement,
    onFirstEnclosure: (pid: number) => runtime.sound.chargeFanfare(pid),
    canApplyPiecePlacement: (
      state: GameState,
      playerId: number,
      offsets: readonly [number, number][],
      row: number,
      col: number,
    ) => canPlacePieceOffsets(state, playerId, offsets, row, col),
    applyCannonPlacement: (
      state: GameState,
      playerId: number,
      row: number,
      col: number,
      mode: string,
    ) => {
      applyCannonPlacement(
        state.players[playerId]!,
        row,
        col,
        toCannonMode(mode),
        state,
      );
    },
    canApplyCannonPlacement: (
      state: GameState,
      playerId: number,
      row: number,
      col: number,
      mode: string,
    ) => {
      const player = state.players[playerId];
      if (!player) return false;
      const maxCannons = state.cannonLimits[playerId] ?? 0;
      const normalizedMode = toCannonMode(mode);
      if (cannonSlotsUsed(player) + cannonSlotCost(normalizedMode) > maxCannons)
        return false;
      return canPlaceCannon(player, row, col, normalizedMode, state);
    },
    applyImpactEvent,
    gridCols: GRID_COLS,
    remoteCrosshairs: watcher.remoteCrosshairs,
    watcherOrbitParams: watcher.orbitParams,
    getRemotePiecePhantoms: () => watcher.remotePiecePhantoms,
    setRemotePiecePhantoms: (value: typeof watcher.remotePiecePhantoms) => {
      watcher.remotePiecePhantoms = value;
    },
    getRemoteCannonPhantoms: () => watcher.remoteCannonPhantoms,
    setRemoteCannonPhantoms: (value: typeof watcher.remoteCannonPhantoms) => {
      watcher.remoteCannonPhantoms = value;
    },
    getLifeLostDialog: () => runtime.lifeLost.get(),
    queueEarlyLifeLostChoice: (playerId: number, choice: LifeLostChoice) => {
      session.earlyLifeLostChoices.set(playerId, choice);
    },
  };
}
