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
import {
  AWAY_DISCONNECT_MS,
  createAwayWatchdog,
} from "../src/online/online-away-watchdog.ts";
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
    },
    takeover: {
      isGameLive: () => false,
      beginAsHost: () => {},
      schedule: () => {},
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
  });
  watchdog.onVisibilityChange(true);
  clock.advance(AWAY_DISCONNECT_MS * 2);
  watchdog.onVisibilityChange(false);
  assertEquals(leaves, 0, "a watcher never abandons anything");
});

Deno.test("away watchdog: match starting while hidden is still covered", () => {
  const clock = mockWatchdogTiming();
  let leaves = 0;
  let seated = false;
  const watchdog = createAwayWatchdog({
    timing: clock.timing,
    isSeatedLiveMatch: () => seated,
    leave: () => leaves++,
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
