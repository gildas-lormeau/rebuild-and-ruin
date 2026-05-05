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
 * MULTI-INSTANCE: `createMessageHandler(init)` returns a per-instance
 * `(msg) => Promise<void>` closure that captures its own deps, with no
 * shared module state. Production calls `initDeps(init)` (which delegates
 * to `createMessageHandler` and stores the result), then registers
 * `handleServerMessage` as a `network.onMessage` callback. Tests that
 * need TWO peers in the same process (bidirectional pair) build two
 * independent handlers via `createMessageHandler`.
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
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { PLAYER_NAMES } from "../shared/ui/player-config.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import { createError, joinError } from "./online-dom.ts";
import { handleGameOverTransition } from "./online-phase-transitions.ts";
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
  readonly client: OnlineClient;
}

// ── Late-bound state (production singleton) ───────────────────────
// Production has exactly one runtime + client per process, so a single
// module-level handler is fine. The closure-returning factory below
// supports multi-instance use cases (tests).
let _handler: ((msg: ServerMessage) => Promise<void>) | undefined;

/** Bind runtime-dependent values and build the singleton message
 *  handler. Called once from online-runtime-game.ts. */
export function initDeps(init: DepsInit): void {
  _handler = createMessageHandler(init);
}

export async function handleServerMessage(msg: ServerMessage): Promise<void> {
  if (!_handler)
    throw new Error("handleServerMessage() called before initDeps()");
  await _handler(msg);
}

/** Build a per-instance message handler closure. Each call returns an
 *  independent handler with its own captured deps — no module-level
 *  state, safe to use for multiple runtime+client pairs in the same
 *  process. Production uses this via `initDeps`; tests that need two
 *  peers (bidirectional pair) call it directly. */
export function createMessageHandler(
  init: DepsInit,
): (msg: ServerMessage) => Promise<void> {
  const client = init.client;
  const lifecycleDeps = buildLifecycleDeps(init, client);
  const incrementalDeps = buildIncrementalDeps(init, client);
  return async (msg: ServerMessage): Promise<void> => {
    client.devLog(`received: ${msg.type}`);
    if (await handleServerLifecycleMessage(msg, lifecycleDeps)) return;
    const result = handleServerIncrementalMessage(msg, incrementalDeps);
    if (!result) client.devLog(`unhandled incremental message: ${msg.type}`);
  };
}

/** Deps for server lifecycle messages (join, start, phase transitions, migration).
 *  Sub-objects group related concerns: session, lobby, ui, game, transitions, migration.
 *  Each sub-builder is a private function below — keeps this composer readable. */
function buildLifecycleDeps(
  init: DepsInit,
  client: OnlineClient,
): HandleServerLifecycleDeps {
  return {
    log: client.devLog,
    session: client.ctx.session,
    lobby: buildLobbyDeps(init),
    ui: buildUiDeps(init, client),
    game: buildGameDeps(init),
    transitions: buildTransitionDeps(init),
    migration: buildMigrationDeps(init),
  };
}

/** Deps for incremental in-game messages (placement, cannon, aim, life-lost).
 *  Incremental deps use flat structure (not nested) because each handler accesses
 *  a different subset — nesting would force handlers to destructure multiple levels.
 *  Contrast with buildLifecycleDeps() which uses nested sub-objects because its
 *  consumers (lifecycle handler) always access one sub-group at a time. */
function buildIncrementalDeps(
  init: DepsInit,
  client: OnlineClient,
): HandleServerIncrementalDeps {
  return {
    log: client.devLog,
    session: client.ctx.session,
    presence: client.ctx.presence,
    getState: () => init.runtime.runtimeState.state,
    schedule: (action) =>
      init.runtime.runtimeState.actionSchedule.schedule(action),
    getControllers: () => init.runtime.runtimeState.controllers,
    selectionStates: init.runtime.selection.getStates(),
    syncSelectionOverlay: () => init.runtime.selection.syncOverlay(),
    confirmSelectionAndStartBuild: (
      playerId: ValidPlayerSlot,
      source?: "local" | "network",
      applyAt?: number,
    ) => {
      init.runtime.selection.confirmAndStartBuild(playerId, source, applyAt);
    },
    allSelectionsConfirmed: () => init.runtime.selection.allConfirmed(),
    getLifeLostDialog: () => init.runtime.lifeLost.get(),
    // Only expose the dialog once Mode.UPGRADE_PICK is active — during
    // the banner preview (prepare) the dialog exists for rendering but
    // picks must still be buffered in earlyUpgradePickChoices. The
    // buffered queue is drained inside `tryShow()` immediately after
    // Mode flips, via `onlineDialogDrains.drainUpgradePick`.
    getUpgradePickDialog: () =>
      init.runtime.runtimeState.mode === Mode.UPGRADE_PICK
        ? init.runtime.runtimeState.dialogs.upgradePick
        : null,
  };
}

function buildLobbyDeps(init: DepsInit) {
  return {
    showWaitingRoom: init.showWaitingRoom,
    get joined() {
      return init.runtime.runtimeState.lobby.joined;
    },
  };
}

function buildUiDeps(init: DepsInit, client: OnlineClient) {
  return {
    getLifeLostDialog: () => init.runtime.lifeLost.get(),
    clearLifeLostDialog: () => {
      init.runtime.lifeLost.set(null);
    },
    isLifeLostMode: () => init.runtime.runtimeState.mode === Mode.LIFE_LOST,
    getUpgradePickDialog: () => init.runtime.runtimeState.dialogs.upgradePick,
    clearUpgradePickDialog: () => {
      // Route through the subsystem boundary, matching the phase-transition
      // path (host: `runtime-composition.ts:clearUpgradePickDialog`,
      // watcher: `online-phase-transitions.ts:clearUpgradePickDialog`)
      // and the host-promotion path (`online-runtime-promote.ts`).
      init.runtime.upgradePick.set(null);
    },
    isUpgradePickMode: () =>
      init.runtime.runtimeState.mode === Mode.UPGRADE_PICK,
    setModeToGame: () => {
      setMode(init.runtime.runtimeState, Mode.GAME);
    },
    setAnnouncement: (text: string) => {
      client.ctx.presence.migrationBanner.text = text;
      client.ctx.presence.migrationBanner.timer =
        MIGRATION_ANNOUNCEMENT_DURATION;
    },
    createErrorEl: createError,
    joinErrorEl: joinError,
  };
}

function buildGameDeps(init: DepsInit) {
  return {
    getState: () => init.runtime.runtimeState.state,
    initFromServer: init.initFromServer,
    enterTowerSelection: () => init.runtime.selection.enter(),
  };
}

function buildTransitionDeps(init: DepsInit) {
  return {
    onGameOver: (msg: ServerMessage) =>
      handleGameOverTransition(msg, init.runtime),
  };
}

function buildMigrationDeps(init: DepsInit) {
  return {
    playerNames: PLAYER_NAMES,
    promoteToHost,
    restoreFullState: init.restoreFullState,
  };
}
