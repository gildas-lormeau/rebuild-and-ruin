/**
 * Online subsystem unit tests — fast, pure-logic tests for online infrastructure.
 *
 * Covers: DedupChannel, host-migration sequence, FULL_STATE accumulator
 * resync contract.
 *
 * Run with: deno test --no-check test/online-unit.test.ts
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { MESSAGE, type FullStateMessage, type ServerMessage } from "../src/protocol/protocol.ts";
import { createDedupChannel } from "../src/shared/core/phantom-types.ts";
import { createActionSchedule } from "../src/shared/core/action-schedule.ts";
import {
  AWAY_DISCONNECT_MS,
  createAwayWatchdog,
} from "../src/online/online-away-watchdog.ts";
import { isSeatReclaimable } from "../src/online/online-rejoin.ts";
import {
  type SeatReclaimDeps,
  scheduleSeatReclaim,
} from "../src/online/online-seat-reclaim.ts";
import {
  type SeatTakeoverDeps,
  scheduleSeatTakeover,
} from "../src/online/online-seat-takeover.ts";
import { adoptDialogEntryToAi } from "../src/runtime/dialogs/dialog-tick.ts";
import { createLifeLostDialogState } from "../src/runtime/dialogs/life-lost-core.ts";
import type { PlayerController } from "../src/shared/core/system-interfaces.ts";
import { LifeLostChoice } from "../src/shared/ui/interaction-types.ts";
import { handleServerLifecycleMessage } from "../src/online/online-server-lifecycle.ts";
import { syncAccumulatorsFromTimer } from "../src/online/online-host-promotion.ts";
import type { MutableAccums } from "../src/runtime/timer-accums.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import {
  type GameMode,
  MODIFIER_REVEAL_TIMER,
  SELECT_ANNOUNCEMENT_DURATION,
  SELECT_TIMER,
} from "../src/shared/core/game-constants.ts";
import type { GameState } from "../src/shared/core/types.ts";
import type { PlayerId, ValidPlayerId } from "../src/shared/core/player-slot.ts";

interface ReclaimHarness {
  deps: SeatReclaimDeps;
  session: {
    occupiedSlots: Set<ValidPlayerId>;
    remotePlayerSlots: Set<ValidPlayerId>;
    myPlayerId: PlayerId;
  };
  lobbyJoined: boolean[];
  ownerInstalls: ValidPlayerId[];
  drain: (toTick: number) => void;
}

const RECLAIM_TICK = 10;
const TAKEOVER_TICK = 12;

Deno.test("DedupChannel.shouldSend returns false on duplicate", () => {
  const ch = createDedupChannel();
  ch.shouldSend(0 as ValidPlayerId, "5,3,normal");
  assert(ch.shouldSend(0 as ValidPlayerId, "5,3,normal") === false, "duplicate should return false");
});

Deno.test("DedupChannel.shouldSend tracks players independently", () => {
  const ch = createDedupChannel();
  ch.shouldSend(0 as ValidPlayerId, "5,3,normal");
  assert(ch.shouldSend(1 as ValidPlayerId, "5,3,normal") === true, "different player same key should return true");
  assert(ch.shouldSend(0 as ValidPlayerId, "5,3,normal") === false, "player 0 unchanged should return false");
});

Deno.test("DedupChannel.shouldSend updates stored key on change", () => {
  const ch = createDedupChannel();
  ch.shouldSend(0 as ValidPlayerId, "first");
  ch.shouldSend(0 as ValidPlayerId, "second");
  assert(ch.shouldSend(0 as ValidPlayerId, "second") === false, "stored key should be 'second' after change");
  assert(ch.shouldSend(0 as ValidPlayerId, "first") === true, "reverting to 'first' should be a change");
});

Deno.test("lifecycle drops stale full_state after host migration", () => {
  let migrationSeq = 0;
  let applyCalls = 0;

  const deps = {
    log: () => {},
    now: () => 0,
    session: {
      isHost: false,
      myPlayerId: 0 as PlayerId,
      get hostMigrationSeq() { return migrationSeq; },
      set hostMigrationSeq(seq: number) { migrationSeq = seq; },
      roomWaitTimerSec: 0,
      roomMaxRounds: 0,
      roomCannonMaxHp: 3,
      roomGameMode: "classic" as GameMode,
      lobbyStartTime: 0,
      occupiedSlots: new Set<ValidPlayerId>(),
      remotePlayerSlots: new Set<ValidPlayerId>(),
      pendingSeatTakeovers: new Map<ValidPlayerId, number | null>(),
      pendingResyncRequests: new Map<ValidPlayerId, number>(),
      myRejoinToken: null as string | null,
    },
    takeover: {
      isGameLive: () => false,
      beginAsHost: () => {},
      schedule: () => {},
    },
    reclaim: {
      schedule: () => {},
      onReclaimRequest: () => {},
      onResyncRequest: () => {},
    },
    rejoin: {
      // false → FULL_STATE exercises the migration dedup path below.
      isAwaitingResync: () => false,
      adoptResync: async () => {},
      abort: () => {},
    },
    lobby: {
      showWaitingRoom: () => {},
      joined: [] as boolean[],
    },
    ui: {
      setAnnouncement: () => {},
      createErrorEl: { textContent: "" } as HTMLElement,
      joinErrorEl: { textContent: "" } as HTMLElement,
    },
    game: {
      getState: () => ({}) as unknown as GameState,
      initFromServer: async () => {},
      enterTowerSelection: () => {},
    },
    transitions: {
      onCastleWalls: () => {},
      onCannonStart: () => {},
      onBattleStart: () => {},
      onBuildStart: () => {},
      onBuildEnd: () => {},
      onGameOver: () => {},
    },
    migration: {
      playerNames: ["P1", "P2", "P3"],
      promoteToHost: () => {},
      restoreFullState: () => {
        applyCalls++;
      },
    },
  };

  // Migration event moves sequence from 0 -> 1.
  handleServerLifecycleMessage(
    {
      type: MESSAGE.HOST_LEFT,
      newHostPlayerId: 1,
      disconnectedPlayerId: 0,
    } as ServerMessage,
    deps,
  );
  assert(migrationSeq === 1, `expected migrationSeq=1, got ${migrationSeq}`);

  // Stale full state (seq 0) must be ignored.
  handleServerLifecycleMessage(makeFullState(0), deps);
  assertEquals(applyCalls, 0, `expected stale full_state to be ignored, calls=${applyCalls}`);

  // Current sequence should apply.
  handleServerLifecycleMessage(makeFullState(1), deps);
  assertEquals(applyCalls, 1, `expected current full_state to apply once, calls=${applyCalls}`);

  // Newer sequence should apply and advance sequence.
  handleServerLifecycleMessage(makeFullState(2), deps);
  assertEquals(applyCalls, 2, `expected newer full_state to apply, calls=${applyCalls}`);
  assertEquals(migrationSeq, 2, `expected migrationSeq to advance to 2, got ${migrationSeq}`);
});

function makeFullState(migrationSeq: number): FullStateMessage {
  return {
    type: MESSAGE.FULL_STATE,
    migrationSeq,
    phase: "BATTLE",
    round: 3,
    timer: 10,
    battleCountdown: 0,
    maxRounds: 5,
    shotsFired: 2,
    rngState: 123,
    simTick: 0,
    players: [],
    grunts: [],
    gruntSpawnSeq: 0,
    houses: [],
    bonusSquares: [],
    towerAlive: [],
    burningPits: [],
    cannonLimits: [],
    cannonPlaceDone: [],
    playerZones: [],
    towerPendingRevive: [],
    capturedCannons: [],
    cannonballs: [],
    gameMode: "classic",
    activeModifier: null,
    activeModifierChangedTiles: [],
    lastModifierId: null,
    frozenTiles: null,
    sinkholeTiles: null,
    exposedRiverbedTiles: null,
  };
}

Deno.test("syncAccumulatorsFromTimer: MODIFIER_REVEAL recomputes elapsed from state.timer", () => {
  const accum = garbageAccums();
  const state = {
    phase: Phase.MODIFIER_REVEAL,
    timer: 0.8,
  } as unknown as GameState;
  syncAccumulatorsFromTimer(state, accum);
  assertAlmostEquals(
    accum.modifierReveal,
    MODIFIER_REVEAL_TIMER - 0.8,
    1e-9,
    "reveal elapsed must be recomputed so the next tick continues from the checkpointed timer",
  );
});

Deno.test("syncAccumulatorsFromTimer: stale modifierReveal is zeroed outside MODIFIER_REVEAL", () => {
  const accum = garbageAccums();
  const state = { phase: Phase.BATTLE, timer: 12 } as unknown as GameState;
  syncAccumulatorsFromTimer(state, accum);
  assertEquals(
    accum.modifierReveal,
    0,
    "a peer jumped out of a mid-flight reveal must not carry stale elapsed into the next reveal",
  );
});

Deno.test("syncAccumulatorsFromTimer: CASTLE_SELECT recomputes the selection countdown", () => {
  const accum = garbageAccums();
  const state = {
    phase: Phase.CASTLE_SELECT,
    timer: 10,
  } as unknown as GameState;
  syncAccumulatorsFromTimer(state, accum);
  assertAlmostEquals(
    accum.select,
    SELECT_TIMER - 10,
    1e-9,
    "mid-reselect restore must not restart the selection countdown from full",
  );
});

Deno.test("syncAccumulatorsFromTimer: CASTLE_SELECT consumes the announcement window", () => {
  const accum = garbageAccums();
  const state = {
    phase: Phase.CASTLE_SELECT,
    timer: 10,
  } as unknown as GameState;
  syncAccumulatorsFromTimer(state, accum);
  assertEquals(
    accum.selectAnnouncement,
    SELECT_ANNOUNCEMENT_DURATION,
    "a FULL_STATE boundary inside CASTLE_SELECT must consume the " +
      "announcement uniformly — the host's window progress is not " +
      "serialized, so 'over' is the only pose every peer can share",
  );
});

Deno.test("syncAccumulatorsFromTimer: preserves grunt and selectAnnouncement (not derivable from state.timer)", () => {
  const accum = garbageAccums();
  const state = {
    phase: Phase.CANNON_PLACE,
    timer: 5,
    cannonPlaceTimer: 20,
  } as unknown as GameState;
  syncAccumulatorsFromTimer(state, accum);
  assertAlmostEquals(
    accum.grunt,
    0.4,
    1e-9,
    "grunt interval clock must survive — zeroing it desyncs grunt steps between the promoted host and watchers",
  );
  assertAlmostEquals(
    accum.selectAnnouncement,
    7,
    1e-9,
    "announcement consumed-flag must survive — zeroing it replays the select announcement on one peer only",
  );
});

/** Accums holding deliberately-wrong values so every assertion proves the
 *  sync actually wrote (or deliberately preserved) the field. */
function garbageAccums(): MutableAccums {
  return {
    battle: 9,
    cannon: 9,
    select: 9,
    selectAnnouncement: 7,
    build: 9,
    grunt: 0.4,
    modifierReveal: 1.5,
  };
}

Deno.test("away watchdog: seated peer hidden past the threshold leaves once", () => {
  const clock = mockWatchdogTiming();
  let leaves = 0;
  const watchdog = createAwayWatchdog({
    timing: clock.timing,
    isSeatedLiveMatch: () => leaves === 0,
    leave: () => leaves++,
    rejoin: () => {},
  });
  watchdog.onVisibilityChange(true);
  clock.advance(AWAY_DISCONNECT_MS - 1);
  assertEquals(leaves, 0, "must not leave before the threshold");
  clock.advance(1);
  assertEquals(leaves, 1, "must leave at the threshold while still hidden");
  watchdog.onVisibilityChange(false);
  assertEquals(leaves, 1, "unhide after the leave must not double-fire");
});

Deno.test("away watchdog: returning before the threshold cancels the leave", () => {
  const clock = mockWatchdogTiming();
  let leaves = 0;
  const watchdog = createAwayWatchdog({
    timing: clock.timing,
    isSeatedLiveMatch: () => true,
    leave: () => leaves++,
    rejoin: () => {},
  });
  watchdog.onVisibilityChange(true);
  clock.advance(AWAY_DISCONNECT_MS / 2);
  watchdog.onVisibilityChange(false);
  clock.advance(AWAY_DISCONNECT_MS * 2);
  assertEquals(leaves, 0, "a cancelled away timer must never fire");
});

Deno.test("away watchdog: suspended timer is backstopped at unhide", () => {
  const clock = mockWatchdogTiming();
  let leaves = 0;
  const watchdog = createAwayWatchdog({
    timing: clock.timing,
    isSeatedLiveMatch: () => true,
    leave: () => leaves++,
    rejoin: () => {},
  });
  watchdog.onVisibilityChange(true);
  // JS suspended for the whole hide — the armed timeout never ran.
  clock.advanceSuspended(AWAY_DISCONNECT_MS + 1_000);
  assertEquals(leaves, 0, "nothing fires while suspended");
  watchdog.onVisibilityChange(false);
  assertEquals(leaves, 1, "unhide must backstop the suspended timer");
});

Deno.test("away watchdog: watchers are exempt", () => {
  const clock = mockWatchdogTiming();
  let leaves = 0;
  const watchdog = createAwayWatchdog({
    timing: clock.timing,
    isSeatedLiveMatch: () => false,
    leave: () => leaves++,
    rejoin: () => {},
  });
  watchdog.onVisibilityChange(true);
  clock.advance(AWAY_DISCONNECT_MS * 2);
  watchdog.onVisibilityChange(false);
  assertEquals(leaves, 0, "a watcher never abandons anything");
});

Deno.test("seat reclaim: non-owner seat re-enters remotePlayerSlots at the stamped tick", () => {
  const seat = 1 as ValidPlayerId;
  const h = makeReclaimHarness(0); // this peer owns slot 0, not the reclaimed seat
  scheduleSeatReclaim(h.deps, seat, RECLAIM_TICK);

  h.drain(RECLAIM_TICK - 1);
  assert(!h.session.occupiedSlots.has(seat), "must not flip before the stamp");

  h.drain(RECLAIM_TICK);
  assert(h.session.occupiedSlots.has(seat), "seat re-occupied at the stamp");
  assert(
    h.session.remotePlayerSlots.has(seat),
    "non-owner seat must become wire-driven (remotePlayerSlots)",
  );
  assertEquals(h.lobbyJoined[seat], true, "lobby.joined re-set");
  assertEquals(h.ownerInstalls, [], "non-owner must not install a controller");
});

Deno.test("seat reclaim: owner seat stays local and installs the human controller", () => {
  const seat = 2 as ValidPlayerId;
  const h = makeReclaimHarness(seat); // this peer IS the returning owner
  scheduleSeatReclaim(h.deps, seat, RECLAIM_TICK);
  h.drain(RECLAIM_TICK);

  assert(h.session.occupiedSlots.has(seat), "owner seat re-occupied");
  assert(
    !h.session.remotePlayerSlots.has(seat),
    "owner seat must stay local (out of remotePlayerSlots) so the tick loop drives it",
  );
  assertEquals(h.ownerInstalls, [seat], "owner installs its human controller once");
});

Deno.test("seat reclaim: re-applying on an already-seated slot is a no-op", () => {
  const seat = 2 as ValidPlayerId;
  const h = makeReclaimHarness(seat);
  scheduleSeatReclaim(h.deps, seat, RECLAIM_TICK);
  scheduleSeatReclaim(h.deps, seat, RECLAIM_TICK); // duplicate stamp (e.g. re-issued on migration)
  h.drain(RECLAIM_TICK);
  assertEquals(
    h.ownerInstalls,
    [seat],
    "idempotent: the controller installs exactly once across duplicate stamps",
  );
});

Deno.test("seat reclaim: preserves remotePlayerSlots ⊆ occupiedSlots", () => {
  const seat = 1 as ValidPlayerId;
  const h = makeReclaimHarness(0);
  scheduleSeatReclaim(h.deps, seat, RECLAIM_TICK);
  h.drain(RECLAIM_TICK);
  for (const pid of h.session.remotePlayerSlots) {
    assert(
      h.session.occupiedSlots.has(pid),
      `invariant violated: ${pid} in remotePlayerSlots but not occupiedSlots`,
    );
  }
});

/** Host-side reclaim eligibility gate (online-rejoin.ts). The seat at index
 *  1 is AI-held (absent from occupiedSlots); index 0 is still human-held. */
Deno.test("isSeatReclaimable: AI-held seat with a live owner is reclaimable", () => {
  const state = {
    players: [{ eliminated: false }, { eliminated: false }],
  } as unknown as GameState;
  const occupied = new Set<ValidPlayerId>([0 as ValidPlayerId]); // seat 1 was taken over
  assertEquals(isSeatReclaimable(state, occupied, 1 as ValidPlayerId), true);
});

Deno.test("isSeatReclaimable: a still-occupied (human-held) seat is not reclaimable", () => {
  const state = {
    players: [{ eliminated: false }, { eliminated: false }],
  } as unknown as GameState;
  const occupied = new Set<ValidPlayerId>([0 as ValidPlayerId, 1 as ValidPlayerId]);
  assertEquals(isSeatReclaimable(state, occupied, 1 as ValidPlayerId), false);
});

Deno.test("isSeatReclaimable: an eliminated owner stays a watcher (not reclaimable)", () => {
  const state = {
    players: [{ eliminated: false }, { eliminated: true }],
  } as unknown as GameState;
  const occupied = new Set<ValidPlayerId>([0 as ValidPlayerId]);
  assertEquals(isSeatReclaimable(state, occupied, 1 as ValidPlayerId), false);
});

/** Build a reclaim deps over a real action schedule. `myPlayerId` decides
 *  whether the seat reclaim treats this peer as the owner. The seat starts
 *  AI-held: absent from both slot sets (takeover cleared it). */
function makeReclaimHarness(myPlayerId: number): ReclaimHarness {
  const schedule = createActionSchedule<GameState>();
  const session = {
    occupiedSlots: new Set<ValidPlayerId>(),
    remotePlayerSlots: new Set<ValidPlayerId>(),
    myPlayerId: myPlayerId as PlayerId,
  };
  const lobbyJoined = [false, false, false];
  const ownerInstalls: ValidPlayerId[] = [];
  const deps: SeatReclaimDeps = {
    session,
    getLobbyJoined: () => lobbyJoined,
    schedule: schedule.schedule,
    installOwnerController: (pid) => ownerInstalls.push(pid),
    log: () => {},
  };
  const state = { simTick: 0 } as unknown as GameState;
  return {
    deps,
    session,
    lobbyJoined,
    ownerInstalls,
    drain: (toTick) => {
      state.simTick = toTick;
      schedule.drainUpTo(toTick, state);
    },
  };
}

// A seat taken over WHILE a life-lost / upgrade-pick dialog is open used to
// stall to the max-timer ABANDON: the entry's `autoResolve` was frozen to
// the departed human, so the takeover AI never resolved it and the seat was
// eliminated instead of played. The fix flips the entry to AI-resolved at
// the takeover tick (`adoptDialogSeat`).
Deno.test("adoptDialogEntryToAi: flips a frozen-human entry so the takeover AI plays it", () => {
  const seat = 1 as ValidPlayerId;
  const dialog = createLifeLostDialogState({
    needsReselect: [seat],
    eliminated: [],
    state: {
      players: [{ lives: 3 }, { lives: 2 }, { lives: 1 }],
    } as unknown as GameState,
    // Frozen as a remote human: shouldAutoResolve = !needsLocalInput && !remote.
    remotePlayerSlots: new Set<ValidPlayerId>([seat]),
    needsLocalInput: () => false,
  });
  const entry = dialog.entries[0]!;
  assertEquals(entry.autoResolve, false, "precondition: frozen as a remote-human entry");

  adoptDialogEntryToAi(
    dialog.entries,
    seat,
    (candidate) => candidate.choice === LifeLostChoice.PENDING,
  );
  assertEquals(entry.autoResolve, true, "adopted: the entry now AI auto-resolves");
  assertEquals(entry.autoTimer, 0, "auto-timer reset so the AI waits its full delay");
});

Deno.test("seat takeover: an open dialog seat is adopted to AI at the stamped tick", () => {
  const seat = 1 as ValidPlayerId;
  const schedule = createActionSchedule<GameState>();
  const session = {
    remotePlayerSlots: new Set<ValidPlayerId>([seat]),
    occupiedSlots: new Set<ValidPlayerId>([seat]),
    pendingSeatTakeovers: new Map<ValidPlayerId, number | null>(),
  };
  const lobbyJoined = [false, true, false];
  const adopted: ValidPlayerId[] = [];
  const aiCtrl = { kind: "ai", reset: () => {} } as unknown as PlayerController;
  const state = {
    simTick: 0,
    // A dialog-adjacent phase so `primeAiControllerForPhase` only calls reset().
    phase: Phase.MODIFIER_REVEAL,
    players: [{ eliminated: false }, { eliminated: false }, { eliminated: false }],
  } as unknown as GameState;
  const deps: SeatTakeoverDeps = {
    session,
    getLobbyJoined: () => lobbyJoined,
    schedule: schedule.schedule,
    getControllers: () => [aiCtrl, aiCtrl, aiCtrl],
    adoptDialogSeat: (pid) => adopted.push(pid),
    log: () => {},
  };

  scheduleSeatTakeover(deps, seat, TAKEOVER_TICK);

  state.simTick = TAKEOVER_TICK - 1;
  schedule.drainUpTo(TAKEOVER_TICK - 1, state);
  assertEquals(adopted, [], "must not adopt before the stamped tick");

  state.simTick = TAKEOVER_TICK;
  schedule.drainUpTo(TAKEOVER_TICK, state);
  assertEquals(adopted, [seat], "the taken-over seat's open dialog is adopted at the stamp");
});

Deno.test("away watchdog: match starting while hidden is still covered", () => {
  const clock = mockWatchdogTiming();
  let leaves = 0;
  let seated = false;
  const watchdog = createAwayWatchdog({
    timing: clock.timing,
    isSeatedLiveMatch: () => seated,
    leave: () => leaves++,
    rejoin: () => {},
  });
  // Hidden in the waiting room; the host starts the match over the socket.
  watchdog.onVisibilityChange(true);
  clock.advance(1_000);
  seated = true;
  clock.advance(AWAY_DISCONNECT_MS);
  assertEquals(
    leaves,
    1,
    "seatedness is decided at fire time, not capture-at-hide",
  );
});

Deno.test("away watchdog: tab-return after an away-leave auto-rejoins once", () => {
  const clock = mockWatchdogTiming();
  let leaves = 0;
  let rejoins = 0;
  let seated = true;
  const watchdog = createAwayWatchdog({
    timing: clock.timing,
    // disconnectAway flips Mode.STOPPED → no longer seated-live, which is
    // what stops a double-leave and re-arms for the next match.
    isSeatedLiveMatch: () => seated && leaves === 0,
    leave: () => {
      leaves++;
      seated = false;
    },
    rejoin: () => rejoins++,
  });
  watchdog.onVisibilityChange(true);
  clock.advance(AWAY_DISCONNECT_MS); // timer fires → abandon the seat
  assertEquals(leaves, 1, "abandons the seat at the threshold");
  assertEquals(rejoins, 0, "no rejoin while still hidden");
  watchdog.onVisibilityChange(false);
  assertEquals(rejoins, 1, "return after an away-leave rejoins exactly once");

  // A second hide+return with no intervening leave must NOT rejoin again.
  watchdog.onVisibilityChange(true);
  clock.advance(AWAY_DISCONNECT_MS / 2);
  watchdog.onVisibilityChange(false);
  assertEquals(rejoins, 1, "a clean return never rejoins");
});

/** Manual clock + timeout registry. `advance` models a hidden tab whose
 *  timers still run (throttled but delivered); `advanceSuspended` models
 *  suspended JS (mobile background) where nothing fires until return. */
function mockWatchdogTiming() {
  let now = 0;
  let nextHandle = 1;
  const timeouts = new Map<number, { fn: () => void; at: number }>();
  return {
    timing: {
      now: () => now,
      setTimeout: (fn: () => void, ms: number): number => {
        const handle = nextHandle++;
        timeouts.set(handle, { fn, at: now + ms });
        return handle;
      },
      clearTimeout: (handle: number): void => {
        timeouts.delete(handle);
      },
    },
    advance(ms: number): void {
      now += ms;
      for (const [handle, entry] of [...timeouts]) {
        if (entry.at <= now) {
          timeouts.delete(handle);
          entry.fn();
        }
      }
    },
    advanceSuspended(ms: number): void {
      now += ms;
    },
  };
}
