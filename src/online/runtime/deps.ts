/**
 * Online client dependency wiring — builds lifecycle/incremental deps bags
 * and dispatches incoming server messages. Runtime values are injected via
 * `initDeps()` (last of the three `initOnlineRuntime` init calls, after
 * `initWs` + `initPromote`); `handleServerMessage()` throws if called first.
 * `createMessageHandler(init)` returns a per-instance closure with no shared
 * module state, so tests can drive two peers in one process.
 */

import type {
  FullStateMessage,
  InitMessage,
  ServerMessage,
} from "../../protocol/protocol.ts";
import { MESSAGE } from "../../protocol/protocol.ts";
import type { GameRuntime } from "../../runtime/handle.ts";
import { isSessionLive } from "../../runtime/state.ts";
import { DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS } from "../../shared/core/action-schedule.ts";
import { MIGRATION_ANNOUNCEMENT_DURATION } from "../../shared/core/game-constants.ts";
import type { ValidPlayerId } from "../../shared/core/player-slot.ts";
import { PLAYER_NAMES } from "../../shared/ui/player-config.ts";
import { Mode } from "../../shared/ui/ui-mode.ts";
import { createError, joinError } from "../online-dom.ts";
import { handleGameOverTransition } from "../online-phase-transitions.ts";
import {
  type SeatTakeoverDeps,
  scheduleSeatTakeover,
} from "../online-seat-takeover.ts";
import {
  type HandleServerIncrementalDeps,
  handleServerIncrementalMessage,
} from "../online-server-events.ts";
import {
  type HandleServerLifecycleDeps,
  handleServerLifecycleMessage,
} from "../online-server-lifecycle.ts";
import type { OnlineClient } from "../online-stores.ts";
import { promoteToHost } from "./promote.ts";

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
 *  handler. Called once from online/runtime/game.ts. */
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
    ui: buildUiDeps(client),
    game: buildGameDeps(init),
    transitions: buildTransitionDeps(init),
    migration: buildMigrationDeps(init),
    takeover: buildTakeoverDeps(init, client),
  };
}

/** Lockstep seat-takeover hooks for the lifecycle handler. The same
 *  `SeatTakeoverDeps` shape is rebuilt by the promoted host's pending
 *  flush in promote.ts — both must wire the LIVE session/lobby/schedule
 *  so the flip lands on the structures the runtime reads per tick. */
function buildTakeoverDeps(init: DepsInit, client: OnlineClient) {
  const seatDeps: SeatTakeoverDeps = {
    session: client.ctx.session,
    getLobbyJoined: () => init.runtime.runtimeState.lobby.joined,
    schedule: (action) =>
      init.runtime.runtimeState.actionSchedule.schedule(action),
    getControllers: () => init.runtime.runtimeState.controllers,
    log: client.devLog,
  };
  return {
    isGameLive: () => isSessionLive(init.runtime.runtimeState),
    beginAsHost: (playerId: ValidPlayerId) => {
      const applyAt =
        init.runtime.runtimeState.state.simTick +
        DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS;
      scheduleSeatTakeover(seatDeps, playerId, applyAt);
      client.send({ type: MESSAGE.SEAT_TAKEOVER, playerId, applyAt });
    },
    schedule: (playerId: ValidPlayerId, applyAt: number) =>
      scheduleSeatTakeover(seatDeps, playerId, applyAt),
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
      playerId: ValidPlayerId,
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

function buildUiDeps(client: OnlineClient) {
  return {
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
