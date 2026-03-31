/**
 * Online client dependency wiring.
 *
 * Builds the deps bags consumed by online-server-lifecycle.ts and
 * online-server-events.ts, and dispatches incoming server messages.
 *
 * DI PATTERN: Mutable singletons (session, watcher) are passed directly as
 * Pick<> references — consumers read fields at call time, so values are always
 * current. Runtime-dependent state still uses closures for late binding.
 * - lifecycleDeps / incrementalDeps: built once at module load, reused for session lifetime.
 * - Contrast with runtime-online-game.ts where checkpointDeps are built dynamically
 *   on each call (because checkpoint state changes frequently during play).
 */

import type { ServerMessage } from "../server/protocol.ts";
import { MIGRATION_ANNOUNCEMENT_DURATION } from "./game-constants.ts";
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
  initFromServer,
  restoreFullState,
  runtime,
  showWaitingRoom,
  transitionCtx,
} from "./runtime-online-game.ts";
import { promoteToHost } from "./runtime-online-promote.ts";
import { devLog, session, watcher } from "./runtime-online-stores.ts";
import { isReselectPhase, Mode } from "./types.ts";

/**
 * Dependency injection pattern for online client:
 *
 * Closures (getState, isCastleReselectPhase):
 *   Use for state that changes frequently during a tick or between ticks.
 *   The closure re-reads the value on each call, ensuring freshness.
 *
 * Direct references (session, watcher):
 *   Use for mutable singletons that persist across the entire online session.
 *   The reference itself doesn't change, but the object's fields may (e.g., session.isHost).
 *
 * Pick<Type, fields>:
 *   Use to restrict surface area — only expose fields the handler actually needs.
 *   Include volatile fields (isHost, myPlayerId) so they're always fresh via the reference.
 *
 * When adding a new handler: prefer closures for derived/computed state, direct refs for singletons.
 *
 * These deps objects are built once and reused for the session lifetime.
 */
const lifecycleDeps = buildLifecycleDeps();
const incrementalDeps = buildIncrementalDeps();

export function handleServerMessage(msg: ServerMessage): void {
  devLog(`received: ${msg.type}`);
  if (handleServerLifecycleMessage(msg, lifecycleDeps)) return;
  const result = handleServerIncrementalMessage(msg, incrementalDeps);
  if (!result) devLog(`unhandled incremental message: ${msg.type}`);
}

/** Deps for server lifecycle messages (join, start, phase transitions, migration).
 *  Sub-objects group related concerns: session, lobby, ui, game, transitions, migration.
 *  Each sub-builder is a private function below — keeps this composer readable. */
function buildLifecycleDeps() {
  return {
    log: devLog,
    now: () => performance.now(),
    session,
    lobby: buildLobbyDeps(),
    ui: buildUiDeps(),
    game: buildGameDeps(),
    transitions: buildTransitionDeps(),
    migration: buildMigrationDeps(),
  };
}

/** Deps for incremental in-game messages (placement, cannon, aim, life-lost).
 *  Incremental deps use flat structure (not nested) because each handler accesses
 *  a different subset — nesting would force handlers to destructure multiple levels.
 *  Contrast with buildLifecycleDeps() which uses nested sub-objects because its
 *  consumers (lifecycle handler) always access one sub-group at a time. */
function buildIncrementalDeps() {
  return {
    log: devLog,
    session,
    watcher,
    getState: () => runtime.runtimeState.state,
    selectionStates: runtime.selection.getStates(),
    syncSelectionOverlay: () => runtime.selection.syncOverlay(),
    isCastleReselectPhase: () =>
      isReselectPhase(runtime.runtimeState.state.phase),
    confirmSelectionAndStartBuild: (playerId: number, isReselect: boolean) => {
      runtime.selection.confirmAndStartBuild(playerId, isReselect);
    },
    allSelectionsConfirmed: () => runtime.selection.allConfirmed(),
    finishReselection: () => runtime.selection.finishReselection(),
    finishSelection: () => runtime.selection.finish(),
    onFirstEnclosure: (pid: number) => runtime.sound.chargeFanfare(pid),
    getLifeLostDialog: () => runtime.lifeLost.get(),
  };
}

function buildLobbyDeps() {
  return {
    showWaitingRoom,
    joined: runtime.runtimeState.lobby.joined,
  };
}

function buildUiDeps() {
  return {
    getLifeLostDialog: () => runtime.lifeLost.get(),
    clearLifeLostDialog: () => {
      runtime.lifeLost.set(null);
    },
    isLifeLostMode: () => runtime.runtimeState.mode === Mode.LIFE_LOST,
    setModeToGame: () => {
      runtime.runtimeState.mode = Mode.GAME;
    },
    setAnnouncement: (text: string) => {
      watcher.migrationText = text;
      watcher.migrationTimer = MIGRATION_ANNOUNCEMENT_DURATION;
    },
    createErrorEl: document.getElementById("create-error")!,
    joinErrorEl: document.getElementById("join-error")!,
  };
}

function buildGameDeps() {
  return {
    getState: () => runtime.runtimeState.state,
    initFromServer,
    enterTowerSelection: () => runtime.selection.enter(),
  };
}

function buildTransitionDeps() {
  return {
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
  };
}

function buildMigrationDeps() {
  return {
    playerNames: PLAYER_NAMES,
    promoteToHost,
    restoreFullState,
  };
}
