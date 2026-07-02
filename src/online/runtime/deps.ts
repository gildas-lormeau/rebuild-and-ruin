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
import type { TowerIdx } from "../../shared/core/geometry-types.ts";
import {
  SPECTATOR_SLOT,
  type ValidPlayerId,
} from "../../shared/core/player-slot.ts";
import { PLAYER_NAMES } from "../../shared/ui/player-config.ts";
import { Mode } from "../../shared/ui/ui-mode.ts";
import { createError, joinError } from "../online-dom.ts";
import { handleGameOverTransition } from "../online-phase-transitions.ts";
import { isSeatReclaimable } from "../online-rejoin.ts";
import {
  type SeatReclaimDeps,
  scheduleSeatReclaim,
} from "../online-seat-reclaim.ts";
import {
  clearSeatSlots,
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
import { rollbackRejoinSession } from "../online-session.ts";
import type { OnlineClient } from "../online-stores.ts";
import { promoteToHost } from "./promote.ts";

// ── Types ──────────────────────────────────────────────────────────
interface DepsInit {
  readonly runtime: GameRuntime;
  readonly initFromServer: (msg: InitMessage) => Promise<void>;
  readonly restoreFullState: (msg: FullStateMessage) => void;
  readonly showWaitingRoom: (code: string, seed: number) => void;
  readonly client: OnlineClient;
  /** Notified once per stale wire stamp (the cross-peer fork condition — see
   *  `warnIfStaleWireStamp`). Production wires this to the lag detector
   *  (`online-lag-detector.ts`) so a sustained burst disconnects the peer
   *  instead of letting it play a forked board. Optional: omitted by the
   *  bidirectional test harness, where the tripwire stays log-only. */
  readonly onStaleStamp?: () => void;
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
    reclaim: buildReclaimDeps(init, client),
    rejoin: buildRejoinDeps(init, client),
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
    adoptDialogSeat: (playerId) => init.runtime.adoptDialogSeat(playerId),
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

/** Lockstep seat-RECLAIM hooks — the give-back inverse of the takeover
 *  deps above (see online-seat-reclaim.ts + online-rejoin.ts). Wired into
 *  production by step 3c-2: a tab-return REJOIN_ROOM (online-away-watchdog.ts
 *  `rejoin`) leads the rejoiner to send REQUEST_SEAT_RECLAIM, the host stamps a
 *  SEAT_RECLAIM via `onReclaimRequest`, and every peer schedules the flip. */
function buildReclaimDeps(init: DepsInit, client: OnlineClient) {
  const session = client.ctx.session;
  const reclaimDeps: SeatReclaimDeps = {
    session,
    getLobbyJoined: () => init.runtime.runtimeState.lobby.joined,
    schedule: (action) =>
      init.runtime.runtimeState.actionSchedule.schedule(action),
    // Owner-only AI→human swap at the SEAT_RECLAIM apply: the runtime's
    // synchronous `installLocalHumanController` (a real HumanController, idle
    // until its local input drives it).
    installOwnerController: (playerId) =>
      init.runtime.installLocalHumanController(playerId),
    log: client.devLog,
  };
  return {
    schedule: (playerId: ValidPlayerId, applyAt: number) =>
      scheduleSeatReclaim(reclaimDeps, playerId, applyAt),
    onReclaimRequest: (playerId: ValidPlayerId) => {
      const state = init.runtime.runtimeState.state;
      if (!isSeatReclaimable(state, session.occupiedSlots, playerId)) {
        client.devLog(
          `reclaim denied for P${playerId}: seat not AI-held or owner eliminated`,
        );
        return;
      }
      const applyAt = state.simTick + DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS;
      scheduleSeatReclaim(reclaimDeps, playerId, applyAt);
      client.send({ type: MESSAGE.SEAT_RECLAIM, playerId, applyAt });
    },
    onResyncRequest: (forPlayerId: ValidPlayerId) => {
      // DEFER, do NOT serialize now (online-resync-defer.ts): park the
      // deferred room-wide resync at `requestTick + SAFETY`. By that tick every
      // human action stamped applyAt <= snapshotTick that was in flight before
      // the rejoiner joined is drained into the snapshot — serialized now, those
      // (broadcast pre-connect, applied post-snapshot) would be missed →
      // fork. The per-frame host poll fires it once simTick reaches the tick.
      const fireAtTick =
        init.runtime.runtimeState.state.simTick +
        DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS;
      session.pendingResyncRequests.set(forPlayerId, fireAtTick);
    },
  };
}

/** Rejoiner-side adoption of the host's first ROOM-WIDE resync broadcast.
 *  Active in production via step 3c-2: the tab-return path sets
 *  `awaitingRejoinResync`, so the first FULL_STATE is adopted here. */
function buildRejoinDeps(init: DepsInit, client: OnlineClient) {
  const session = client.ctx.session;
  return {
    isAwaitingResync: () => session.awaitingRejoinResync,
    adoptResync: (msg: FullStateMessage): Promise<void> => {
      // Adopt the host's ROOM-WIDE resync broadcast through the SAME path
      // every other peer uses for a migration (`applyFullStateToRunningRuntime`
      // via init.restoreFullState): keep the spectator-boot mirror/AI
      // controllers (same seed → same personalities as the host) and reprime
      // them, replaying the host's post-serialize draws → identical state.rng
      // cursor on every peer. (applyMidGameCheckpoint would rebuild the AI on a
      // PRIVATE rng stream, diverging from the host's live shared-stream AI.)
      init.restoreFullState(msg);
      session.hostMigrationSeq = msg.migrationSeq ?? session.hostMigrationSeq;
      session.awaitingRejoinResync = false;
      // Claim the seat back. It is AI-held (taken over while away); our stale
      // `occupiedSlots` still lists it — the spectator-boot kept it there for
      // the bootstrap identity draws, but left there `applySeatReclaim`'s
      // idempotency guard (`occupiedSlots.has`) would no-op the owner swap.
      // Clear it, adopt the seat identity, then request the give-back.
      const seat = session.awaitingRejoinSeat;
      if (seat >= 0) {
        clearSeatSlots(
          session,
          init.runtime.runtimeState.lobby.joined,
          seat as ValidPlayerId,
        );
        session.myPlayerId = seat;
        session.awaitingRejoinSeat = SPECTATOR_SLOT;
        client.send({
          type: MESSAGE.REQUEST_SEAT_RECLAIM,
          playerId: seat as ValidPlayerId,
        });
      }
      return Promise.resolve();
    },
    // Server rejected the rejoin (ROOM_ERROR): roll back on THIS instance's
    // session — not ws.ts's production singleton — so the per-instance test
    // harness rolls back its own session too.
    abort: () => {
      rollbackRejoinSession(session);
    },
  };
}

function buildIncrementalDeps(
  init: DepsInit,
  client: OnlineClient,
): HandleServerIncrementalDeps {
  return {
    log: client.devLog,
    session: client.ctx.session,
    presence: client.ctx.presence,
    getState: () => init.runtime.runtimeState.state,
    schedule: (action) => {
      warnIfStaleWireStamp(
        init,
        client.devLog,
        action.applyAt,
        action.playerId,
      );
      init.runtime.runtimeState.actionSchedule.schedule(action);
    },
    getControllers: () => init.runtime.runtimeState.controllers,
    selectionStates: init.runtime.selection.getStates(),
    syncSelectionOverlay: () => init.runtime.selection.syncOverlay(),
    confirmSelectionAndStartBuild: (
      playerId: ValidPlayerId,
      source?: "local" | "network",
      applyAt?: number,
      towerIdx?: TowerIdx,
    ) => {
      // Tower confirms reach the schedule through the selection subsystem
      // rather than `schedule` above — same tripwire, same rationale.
      if (applyAt !== undefined) {
        warnIfStaleWireStamp(init, client.devLog, applyAt, playerId);
      }
      init.runtime.selection.confirmAndStartBuild(
        playerId,
        source,
        applyAt,
        towerIdx,
      );
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

/** Deps for incremental in-game messages (placement, cannon, aim, life-lost).
 *  Incremental deps use flat structure (not nested) because each handler accesses
 *  a different subset — nesting would force handlers to destructure multiple levels.
 *  Contrast with buildLifecycleDeps() which uses nested sub-objects because its
 *  consumers (lifecycle handler) always access one sub-group at a time. */
/** Loud tripwire for the lockstep invariant. A wire stamp at or before
 *  this peer's current simTick drains immediately — the originator applied
 *  the action at `applyAt` but this peer applies it later, so the match is
 *  forking. With debt banking + stamp correction + quarantine in place
 *  (main-loop.ts / state.ts), this should never fire; if it does, a freeze
 *  cause slipped past the recovery machinery and we want the evidence, not
 *  silence. Detection only — the action is still scheduled (dropping it
 *  forks differently, since the originator already queued its own apply). */
function warnIfStaleWireStamp(
  init: DepsInit,
  log: (msg: string) => void,
  applyAt: number,
  playerId: number,
): void {
  const { state } = init.runtime.runtimeState;
  if (applyAt > state.simTick) return;
  const msg =
    `[lockstep] STALE wire stamp from P${playerId}: applyAt=${applyAt} <= ` +
    `simTick=${state.simTick} — peers are applying this action at ` +
    `different ticks (cross-peer fork)`;
  console.error(msg);
  log(msg);
  init.onStaleStamp?.();
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
    isStopped: () => init.runtime.runtimeState.mode === Mode.STOPPED,
    initFromServer: init.initFromServer,
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
