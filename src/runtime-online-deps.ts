/**
 * Online client dependency wiring.
 *
 * Builds the deps bags consumed by online-server-lifecycle.ts and
 * online-server-events.ts, and dispatches incoming server messages.
 *
 * Does NOT import runtime-online-game.ts — all runtime-dependent values
 * are injected via initDeps() to avoid initialization coupling with the
 * composition root.
 *
 * DI PATTERN: Mutable singletons (session, watcher) are passed directly as
 * Pick<> references — consumers read fields at call time, so values are always
 * current. Runtime-dependent state still uses closures for late binding.
 * - lifecycleDeps / incrementalDeps: built once via initDeps(), reused for session lifetime.
 * - Contrast with runtime-online-game.ts where checkpointDeps are built dynamically
 *   on each call (because checkpoint state changes frequently during play).
 */

import type {
  FullStateMessage,
  InitMessage,
  ServerMessage,
} from "../server/protocol.ts";
import {
  MIGRATION_ANNOUNCEMENT_DURATION,
  type ValidPlayerSlot,
} from "./game-constants.ts";
import { createError, joinError } from "./online-dom.ts";
import type { TransitionContext } from "./online-phase-transitions.ts";
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
import { ctx, devLog } from "./online-stores.ts";
import { PLAYER_NAMES } from "./player-config.ts";
import { promoteToHost } from "./runtime-online-promote.ts";
import type { GameRuntime } from "./runtime-types.ts";
import { isReselectPhase, Mode } from "./types.ts";

// ── Types ──────────────────────────────────────────────────────────
interface DepsInit {
  readonly runtime: GameRuntime;
  readonly initFromServer: (msg: InitMessage) => void;
  readonly restoreFullState: (msg: FullStateMessage) => void;
  readonly showWaitingRoom: (code: string, seed: number) => void;
  readonly transitionCtx: TransitionContext;
}

// ── Late-bound state ───────────────────────────────────────────────
// Pattern shared with runtime-online-promote.ts and runtime-online-ws.ts:
//  1. Declare module-level `let _ref: Type` (no initial value)
//  2. Export `initXxx(value)` that assigns _ref and builds any closures
//  3. Guard with `if (!_ref) throw "called before initXxx()"` in public API
// This avoids circular imports between the composition root (runtime-online-game.ts)
// and domain modules. All three init functions are called once from createOnlineGame().
let _g: DepsInit;
let _lifecycleDeps: ReturnType<typeof buildLifecycleDeps>;
let _incrementalDeps: ReturnType<typeof buildIncrementalDeps>;

/** Bind runtime-dependent values and build deps objects. Called once from
 *  runtime-online-game.ts after the GameRuntime is created. */
export function initDeps(init: DepsInit): void {
  _g = init;
  _lifecycleDeps = buildLifecycleDeps();
  _incrementalDeps = buildIncrementalDeps();
}

export function handleServerMessage(msg: ServerMessage): void {
  if (!_g) throw new Error("handleServerMessage() called before initDeps()");
  devLog(`received: ${msg.type}`);
  if (handleServerLifecycleMessage(msg, _lifecycleDeps)) return;
  const result = handleServerIncrementalMessage(msg, _incrementalDeps);
  if (!result) devLog(`unhandled incremental message: ${msg.type}`);
}

/** Deps for server lifecycle messages (join, start, phase transitions, migration).
 *  Sub-objects group related concerns: session, lobby, ui, game, transitions, migration.
 *  Each sub-builder is a private function below — keeps this composer readable. */
function buildLifecycleDeps() {
  return {
    log: devLog,
    now: () => performance.now(),
    session: ctx.session,
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
    session: ctx.session,
    watcher: ctx.watcher,
    getState: () => _g.runtime.runtimeState.state,
    selectionStates: _g.runtime.selection.getStates(),
    syncSelectionOverlay: () => _g.runtime.selection.syncOverlay(),
    isCastleReselectPhase: () =>
      isReselectPhase(_g.runtime.runtimeState.state.phase),
    confirmSelectionAndStartBuild: (
      playerId: ValidPlayerSlot,
      isReselect: boolean,
    ) => {
      _g.runtime.selection.confirmAndStartBuild(playerId, isReselect);
    },
    allSelectionsConfirmed: () => _g.runtime.selection.allConfirmed(),
    finishReselection: () => _g.runtime.selection.finishReselection(),
    finishSelection: () => _g.runtime.selection.finish(),
    onFirstEnclosure: (pid: ValidPlayerSlot) =>
      _g.runtime.sound.chargeFanfare(pid),
    getLifeLostDialog: () => _g.runtime.lifeLost.get(),
    getUpgradePickDialog: () => _g.runtime.runtimeState.upgradePickDialog,
  };
}

function buildLobbyDeps() {
  return {
    showWaitingRoom: _g.showWaitingRoom,
    get joined() {
      return _g.runtime.runtimeState.lobby.joined;
    },
  };
}

function buildUiDeps() {
  return {
    getLifeLostDialog: () => _g.runtime.lifeLost.get(),
    clearLifeLostDialog: () => {
      _g.runtime.lifeLost.set(null);
    },
    isLifeLostMode: () => _g.runtime.runtimeState.mode === Mode.LIFE_LOST,
    getUpgradePickDialog: () => _g.runtime.runtimeState.upgradePickDialog,
    clearUpgradePickDialog: () => {
      _g.runtime.runtimeState.upgradePickDialog = null;
    },
    isUpgradePickMode: () => _g.runtime.runtimeState.mode === Mode.UPGRADE_PICK,
    setModeToGame: () => {
      _g.runtime.runtimeState.mode = Mode.GAME;
    },
    setAnnouncement: (text: string) => {
      ctx.watcher.migrationText = text;
      ctx.watcher.migrationTimer = MIGRATION_ANNOUNCEMENT_DURATION;
    },
    createErrorEl: createError,
    joinErrorEl: joinError,
  };
}

function buildGameDeps() {
  return {
    getState: () => _g.runtime.runtimeState.state,
    initFromServer: _g.initFromServer,
    enterTowerSelection: () => _g.runtime.selection.enter(),
  };
}

function buildTransitionDeps() {
  return {
    onCastleWalls: (msg: ServerMessage) =>
      handleCastleWallsTransition(msg, _g.transitionCtx),
    onCannonStart: (msg: ServerMessage) =>
      handleCannonStartTransition(msg, _g.transitionCtx),
    onBattleStart: (msg: ServerMessage) =>
      handleBattleStartTransition(msg, _g.transitionCtx),
    onBuildStart: (msg: ServerMessage) =>
      handleBuildStartTransition(msg, _g.transitionCtx),
    onBuildEnd: (msg: ServerMessage) =>
      handleBuildEndTransition(msg, _g.transitionCtx),
    onGameOver: (msg: ServerMessage) =>
      handleGameOverTransition(msg, _g.transitionCtx),
  };
}

function buildMigrationDeps() {
  return {
    playerNames: PLAYER_NAMES,
    promoteToHost,
    restoreFullState: _g.restoreFullState,
  };
}
