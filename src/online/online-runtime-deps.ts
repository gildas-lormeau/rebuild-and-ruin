/**
 * Online client dependency wiring.
 *
 * Builds the deps bags consumed by online-server-lifecycle.ts and
 * online-server-events.ts, and dispatches incoming server messages.
 *
 * Does NOT import online-runtime-game.ts — all runtime-dependent values
 * are injected via initDeps() to avoid initialization coupling with the
 * composition root.
 *
 * DI PATTERN: Mutable singletons (session, watcher) are passed directly as
 * Pick<> references — consumers read fields at call time, so values are always
 * current. Runtime-dependent state still uses closures for late binding.
 * - lifecycleDeps / incrementalDeps: built once via initDeps(), reused for session lifetime.
 * - Contrast with online-runtime-game.ts where checkpointDeps are built dynamically
 *   on each call (because checkpoint state changes frequently during play).
 *
 * ORDERING INVARIANT — initDeps() is the last of three init calls from
 * online-runtime-game.ts:initOnlineRuntime(). The required order is:
 *    1. initWs (online-runtime-ws.ts)
 *    2. initPromote (online-runtime-promote.ts)
 *    3. initDeps (this file)
 * Calling handleServerMessage() before initDeps() throws. Do not reorder the
 * call sequence in initOnlineRuntime without updating all three modules.
 */

import type {
  FullStateMessage,
  InitMessage,
  ServerMessage,
} from "../protocol/protocol.ts";
import { setMode } from "../runtime/runtime-state.ts";
import type { GameRuntime } from "../runtime/runtime-types.ts";
import { MIGRATION_ANNOUNCEMENT_DURATION } from "../shared/core/game-constants.ts";
import { isReselectPhase } from "../shared/core/game-phase.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { PLAYER_NAMES } from "../shared/ui/player-config.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import { createError, joinError } from "./online-dom.ts";
import {
  handleBattleStartTransition,
  handleBuildEndTransition,
  handleBuildStartTransition,
  handleCannonStartTransition,
  handleGameOverTransition,
  type WatcherDeps,
} from "./online-phase-transitions.ts";
import { promoteToHost } from "./online-runtime-promote.ts";
import {
  type HandleServerIncrementalDeps,
  handleServerIncrementalMessage,
} from "./online-server-events.ts";
import {
  type HandleServerLifecycleDeps,
  handleServerLifecycleMessage,
} from "./online-server-lifecycle.ts";
import type { OnlineClient } from "./online-stores.ts";

// ── Types ──────────────────────────────────────────────────────────
interface DepsInit {
  readonly runtime: GameRuntime;
  readonly initFromServer: (msg: InitMessage) => Promise<void>;
  readonly restoreFullState: (msg: FullStateMessage) => void;
  readonly showWaitingRoom: (code: string, seed: number) => void;
  readonly watcherDeps: WatcherDeps;
  readonly client: OnlineClient;
}

// ── Late-bound state ───────────────────────────────────────────────
// Pattern shared with online-runtime-promote.ts and online-runtime-ws.ts:
//  1. Declare module-level `let _ref: Type` (no initial value)
//  2. Export `initXxx(value)` that assigns _ref and builds any closures
//  3. Guard with `if (!_ref) throw "called before initXxx()"` in public API
// This avoids circular imports between the composition root (online-runtime-game.ts)
// and domain modules. All three init functions are called once from createOnlineGame().
let _depsInit: DepsInit;
let _client: OnlineClient;
let _lifecycleDeps: HandleServerLifecycleDeps;
let _incrementalDeps: HandleServerIncrementalDeps;

/** Bind runtime-dependent values and build deps objects. Called once from
 *  online-runtime-game.ts after the GameRuntime is created. */
export function initDeps(init: DepsInit): void {
  _depsInit = init;
  _client = init.client;
  _lifecycleDeps = buildLifecycleDeps();
  _incrementalDeps = buildIncrementalDeps();
}

export async function handleServerMessage(msg: ServerMessage): Promise<void> {
  if (!_depsInit)
    throw new Error("handleServerMessage() called before initDeps()");
  _client.devLog(`received: ${msg.type}`);
  if (await handleServerLifecycleMessage(msg, _lifecycleDeps)) return;
  const result = handleServerIncrementalMessage(msg, _incrementalDeps);
  if (!result) _client.devLog(`unhandled incremental message: ${msg.type}`);
}

/** Deps for server lifecycle messages (join, start, phase transitions, migration).
 *  Sub-objects group related concerns: session, lobby, ui, game, transitions, migration.
 *  Each sub-builder is a private function below — keeps this composer readable. */
function buildLifecycleDeps() {
  return {
    log: _client.devLog,
    session: _client.ctx.session,
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
    log: _client.devLog,
    session: _client.ctx.session,
    watcher: _client.ctx.watcher,
    getState: () => _depsInit.runtime.runtimeState.state,
    selectionStates: _depsInit.runtime.selection.getStates(),
    syncSelectionOverlay: () => _depsInit.runtime.selection.syncOverlay(),
    isCastleReselectPhase: () =>
      isReselectPhase(_depsInit.runtime.runtimeState.state.phase),
    confirmSelectionAndStartBuild: (
      playerId: ValidPlayerSlot,
      isReselect: boolean,
      source?: "local" | "network",
    ) => {
      _depsInit.runtime.selection.confirmAndStartBuild(
        playerId,
        isReselect,
        source,
      );
    },
    allSelectionsConfirmed: () => _depsInit.runtime.selection.allConfirmed(),
    finishReselection: () => _depsInit.runtime.selection.finishReselection(),
    finishSelection: () => _depsInit.runtime.selection.finish(),
    onFirstEnclosure: (_pid: ValidPlayerSlot) => {},
    getLifeLostDialog: () => _depsInit.runtime.lifeLost.get(),
    // Only expose the dialog once Mode.UPGRADE_PICK is active — during the
    // banner preview (prepare) the dialog exists for rendering but picks
    // should still be buffered in earlyUpgradePickChoices.
    getUpgradePickDialog: () =>
      _depsInit.runtime.runtimeState.mode === Mode.UPGRADE_PICK
        ? _depsInit.runtime.runtimeState.dialogs.upgradePick
        : null,
  };
}

function buildLobbyDeps() {
  return {
    showWaitingRoom: _depsInit.showWaitingRoom,
    get joined() {
      return _depsInit.runtime.runtimeState.lobby.joined;
    },
  };
}

function buildUiDeps() {
  return {
    getLifeLostDialog: () => _depsInit.runtime.lifeLost.get(),
    clearLifeLostDialog: () => {
      _depsInit.runtime.lifeLost.set(null);
    },
    isLifeLostMode: () =>
      _depsInit.runtime.runtimeState.mode === Mode.LIFE_LOST,
    getUpgradePickDialog: () =>
      _depsInit.runtime.runtimeState.dialogs.upgradePick,
    clearUpgradePickDialog: () => {
      // Route through the subsystem boundary, matching the phase-transition
      // path (host: `runtime-composition.ts:clearUpgradePickDialog`,
      // watcher: `online-phase-transitions.ts:clearUpgradePickDialog`)
      // and the host-promotion path (`online-runtime-promote.ts`).
      _depsInit.runtime.upgradePick.set(null);
    },
    isUpgradePickMode: () =>
      _depsInit.runtime.runtimeState.mode === Mode.UPGRADE_PICK,
    setModeToGame: () => {
      setMode(_depsInit.runtime.runtimeState, Mode.GAME);
    },
    setAnnouncement: (text: string) => {
      _client.ctx.watcher.hostMigrationText = text;
      _client.ctx.watcher.hostMigrationTimer = MIGRATION_ANNOUNCEMENT_DURATION;
    },
    createErrorEl: createError,
    joinErrorEl: joinError,
  };
}

function buildGameDeps() {
  return {
    getState: () => _depsInit.runtime.runtimeState.state,
    initFromServer: _depsInit.initFromServer,
    enterTowerSelection: () => _depsInit.runtime.selection.enter(),
  };
}

function buildTransitionDeps() {
  return {
    onCannonStart: (msg: ServerMessage) =>
      handleCannonStartTransition(msg, _depsInit.watcherDeps),
    onBattleStart: (msg: ServerMessage) =>
      handleBattleStartTransition(msg, _depsInit.watcherDeps),
    onBuildStart: (msg: ServerMessage) =>
      handleBuildStartTransition(msg, _depsInit.watcherDeps),
    onBuildEnd: (msg: ServerMessage) =>
      handleBuildEndTransition(msg, _depsInit.watcherDeps),
    onGameOver: (msg: ServerMessage) =>
      handleGameOverTransition(msg, _depsInit.watcherDeps),
  };
}

function buildMigrationDeps() {
  return {
    playerNames: PLAYER_NAMES,
    promoteToHost,
    restoreFullState: _depsInit.restoreFullState,
  };
}
