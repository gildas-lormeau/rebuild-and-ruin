/**
 * Full-state round-trip tests: createFullStateMessage → restoreFullStateSnapshot.
 *
 * This is the most complex serialization path, used during host migration.
 * Covers players, grunts, cannonballs, captured cannons, balloon hits,
 * RNG state, towerPendingRevive, houses, and balloon flights.
 *
 * Run with: bun test/online-full-state.test.ts
 */

import type { ValidPlayerSlot } from "../src/game-constants.ts";
import {
  restoreFullStateSnapshot,
  createFullStateMessage,
} from "../src/online-serialize.ts";
import {
  createHeadlessRuntime,
  type HeadlessRuntime,
} from "../src/runtime-headless.ts";
import { CannonMode, emptyFreshInterior, Phase } from "../src/types.ts";
import { assert, runTests, test } from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setsEqual(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** Headless runtime starts with empty cannonLimits/playerZones.
 *  Full-state validation requires these to match player count. */
function initForFullState(rt: HeadlessRuntime): void {
  if (rt.state.cannonLimits.length === 0) {
    rt.state.cannonLimits = rt.state.players.map(() => 3);
  }
  if (rt.state.playerZones.length === 0) {
    rt.state.playerZones = rt.zones;
  }
}

/** Create a pair of initialized runtimes for full-state round-trip testing. */
function createPair(seed: number): { host: HeadlessRuntime; watcher: HeadlessRuntime } {
  const host = createHeadlessRuntime(seed);
  initForFullState(host);
  const watcher = createHeadlessRuntime(seed);
  initForFullState(watcher);
  return { host, watcher };
}

// ---------------------------------------------------------------------------
// Basic round-trip
// ---------------------------------------------------------------------------

test("full-state round-trip preserves phase, round, timer, maxRounds", () => {
  const { host, watcher } = createPair(42);
  host.state.round = 4;
  host.state.timer = 8.5;
  host.state.battleCountdown = 3;
  host.state.maxRounds = 7;
  host.state.shotsFired = 12;

  const msg = createFullStateMessage(host.state, 1);
  watcher.state.round = 1;
  watcher.state.timer = 0;
  watcher.state.battleCountdown = 0;

  const result = restoreFullStateSnapshot(watcher.state, msg);
  assert(result !== null, "restoreFullStateSnapshot should succeed");
  assert(watcher.state.phase === host.state.phase, `phase mismatch: expected ${Phase[host.state.phase]}, got ${Phase[watcher.state.phase]}`);
  assert(watcher.state.round === 4, `round: expected 4, got ${watcher.state.round}`);
  assert(watcher.state.timer === 8.5, `timer: expected 8.5, got ${watcher.state.timer}`);
  assert(watcher.state.battleCountdown === 3, `battleCountdown: expected 3, got ${watcher.state.battleCountdown}`);
  assert(watcher.state.maxRounds === 7, `maxRounds: expected 7, got ${watcher.state.maxRounds}`);
  assert(watcher.state.shotsFired === 12, `shotsFired: expected 12, got ${watcher.state.shotsFired}`);
});

test("full-state round-trip preserves player walls, interior, lives, score", () => {
  const { host, watcher } = createPair(42);
  host.state.players[0]!.score = 500;
  host.state.players[0]!.lives = 2;

  const msg = createFullStateMessage(host.state, 1);
  watcher.state.players[0]!.score = 0;
  watcher.state.players[0]!.lives = 3;

  restoreFullStateSnapshot(watcher.state, msg);

  for (let i = 0; i < host.state.players.length; i++) {
    const hp = host.state.players[i]!;
    const wp = watcher.state.players[i]!;
    assert(setsEqual(hp.walls, wp.walls), `player ${i} walls mismatch`);
    assert(setsEqual(hp.interior, wp.interior), `player ${i} interior mismatch`);
    assert(hp.lives === wp.lives, `player ${i} lives: expected ${hp.lives}, got ${wp.lives}`);
    assert(hp.score === wp.score, `player ${i} score: expected ${hp.score}, got ${wp.score}`);
    assert(hp.eliminated === wp.eliminated, `player ${i} eliminated mismatch`);
  }
});

test("full-state round-trip preserves cannons with modes and facings", () => {
  const { host, watcher } = createPair(42);
  const p = host.state.players[0]!;
  p.cannons = [
    { row: 5, col: 5, hp: 3, mode: CannonMode.NORMAL, facing: 0 },
    { row: 7, col: 7, hp: 2, mode: CannonMode.SUPER, facing: 3 },
    { row: 9, col: 9, hp: 1, mode: CannonMode.BALLOON, facing: 5 },
  ];

  const msg = createFullStateMessage(host.state, 1);
  restoreFullStateSnapshot(watcher.state, msg);

  const wp = watcher.state.players[0]!;
  assert(wp.cannons.length === 3, `expected 3 cannons, got ${wp.cannons.length}`);
  for (let c = 0; c < 3; c++) {
    assert(wp.cannons[c]!.row === p.cannons[c]!.row, `cannon ${c} row mismatch`);
    assert(wp.cannons[c]!.col === p.cannons[c]!.col, `cannon ${c} col mismatch`);
    assert(wp.cannons[c]!.hp === p.cannons[c]!.hp, `cannon ${c} hp mismatch`);
    assert(wp.cannons[c]!.mode === p.cannons[c]!.mode, `cannon ${c} mode: expected ${p.cannons[c]!.mode}, got ${wp.cannons[c]!.mode}`);
    assert(wp.cannons[c]!.facing === p.cannons[c]!.facing, `cannon ${c} facing mismatch`);
  }
});

test("full-state round-trip preserves grunts", () => {
  const { host, watcher } = createPair(42);
  host.state.grunts = [
    { row: 10, col: 15, defendingPlayerId: 0, targetTowerIdx: 1, attackTimer: 0.5, blockedBattles: 1, wallAttack: true, facing: 2 },
    { row: 20, col: 25, defendingPlayerId: 1, blockedBattles: 0 },
  ];

  const msg = createFullStateMessage(host.state, 1);
  watcher.state.grunts = [];
  restoreFullStateSnapshot(watcher.state, msg);

  assert(watcher.state.grunts.length === 2, `expected 2 grunts, got ${watcher.state.grunts.length}`);
  assert(watcher.state.grunts[0]!.row === 10, "grunt 0 row");
  assert(watcher.state.grunts[0]!.targetTowerIdx === 1, "grunt 0 targetTowerIdx");
  assert(watcher.state.grunts[0]!.wallAttack === true, "grunt 0 wallAttack");
  assert(watcher.state.grunts[1]!.defendingPlayerId === 1, "grunt 1 defendingPlayerId");
});

// ---------------------------------------------------------------------------
// RNG state
// ---------------------------------------------------------------------------

test("full-state round-trip preserves RNG state", () => {
  const { host, watcher } = createPair(42);
  // Advance RNG a few times so state diverges from initial seed
  for (let i = 0; i < 10; i++) host.state.rng.int(0, 100);
  const hostRngState = host.state.rng.getState();

  const msg = createFullStateMessage(host.state, 1);
  restoreFullStateSnapshot(watcher.state, msg);

  assert(watcher.state.rng.getState() === hostRngState,
    `RNG state: expected ${hostRngState}, got ${watcher.state.rng.getState()}`);

  // Verify determinism: both should produce the same next values
  const hostNext = host.state.rng.int(0, 1000);
  const watcherNext = watcher.state.rng.int(0, 1000);
  assert(hostNext === watcherNext,
    `RNG determinism broken: host=${hostNext}, watcher=${watcherNext}`);
});

// ---------------------------------------------------------------------------
// cannonLimits, playerZones, activePlayer, towerPendingRevive
// ---------------------------------------------------------------------------

test("full-state round-trip preserves cannonLimits and playerZones", () => {
  const { host, watcher } = createPair(42);
  host.state.cannonLimits = [5, 3, 7];
  host.state.playerZones = [1, 2, 3];
  host.state.activePlayer = 2;

  const msg = createFullStateMessage(host.state, 1);
  restoreFullStateSnapshot(watcher.state, msg);

  for (let i = 0; i < 3; i++) {
    assert(watcher.state.cannonLimits[i] === host.state.cannonLimits[i],
      `cannonLimits[${i}]: expected ${host.state.cannonLimits[i]}, got ${watcher.state.cannonLimits[i]}`);
    assert(watcher.state.playerZones[i] === host.state.playerZones[i],
      `playerZones[${i}]: expected ${host.state.playerZones[i]}, got ${watcher.state.playerZones[i]}`);
  }
  assert(watcher.state.activePlayer === 2, `activePlayer: expected 2, got ${watcher.state.activePlayer}`);
});

test("full-state round-trip preserves towerPendingRevive", () => {
  const { host, watcher } = createPair(42);
  const towerCount = host.state.map.towers.length;
  if (towerCount >= 2) {
    host.state.towerPendingRevive = new Set([0, 1]);
  }

  const msg = createFullStateMessage(host.state, 1);
  watcher.state.towerPendingRevive = new Set();
  restoreFullStateSnapshot(watcher.state, msg);

  assert(setsEqual(watcher.state.towerPendingRevive, host.state.towerPendingRevive),
    `towerPendingRevive mismatch: expected ${[...host.state.towerPendingRevive]}, got ${[...watcher.state.towerPendingRevive]}`);
});

// ---------------------------------------------------------------------------
// towerAlive, burningPits, bonusSquares, houses
// ---------------------------------------------------------------------------

test("full-state round-trip preserves towerAlive", () => {
  const { host, watcher } = createPair(42);
  if (host.state.towerAlive.length > 1) {
    host.state.towerAlive[1] = false;
  }

  const msg = createFullStateMessage(host.state, 1);
  restoreFullStateSnapshot(watcher.state, msg);

  for (let i = 0; i < host.state.towerAlive.length; i++) {
    assert(watcher.state.towerAlive[i] === host.state.towerAlive[i],
      `towerAlive[${i}]: expected ${host.state.towerAlive[i]}, got ${watcher.state.towerAlive[i]}`);
  }
});

test("full-state round-trip preserves burningPits and bonusSquares", () => {
  const { host, watcher } = createPair(42);
  host.state.burningPits = [{ row: 3, col: 4, roundsLeft: 2 }];
  host.state.bonusSquares = [{ row: 8, col: 9, zone: 1 }];

  const msg = createFullStateMessage(host.state, 1);
  watcher.state.burningPits = [];
  watcher.state.bonusSquares = [];
  restoreFullStateSnapshot(watcher.state, msg);

  assert(watcher.state.burningPits.length === 1, "burningPits lost");
  assert(watcher.state.burningPits[0]!.row === 3, "burningPit row");
  assert(watcher.state.burningPits[0]!.roundsLeft === 2, "burningPit roundsLeft");
  assert(watcher.state.bonusSquares.length === 1, "bonusSquares lost");
  assert(watcher.state.bonusSquares[0]!.row === 8, "bonusSquare row");
  assert(watcher.state.bonusSquares[0]!.zone === 1, "bonusSquare zone");
});

test("full-state round-trip preserves house alive status", () => {
  const { host, watcher } = createPair(42);
  // Kill some houses
  for (let i = 0; i < host.state.map.houses.length && i < 2; i++) {
    host.state.map.houses[i]!.alive = false;
  }

  const msg = createFullStateMessage(host.state, 1);
  restoreFullStateSnapshot(watcher.state, msg);

  for (let i = 0; i < host.state.map.houses.length; i++) {
    assert(watcher.state.map.houses[i]!.alive === host.state.map.houses[i]!.alive,
      `house[${i}].alive: expected ${host.state.map.houses[i]!.alive}, got ${watcher.state.map.houses[i]!.alive}`);
  }
});

// ---------------------------------------------------------------------------
// Cannonballs
// ---------------------------------------------------------------------------

test("full-state round-trip preserves cannonballs", () => {
  const { host, watcher } = createPair(42);
  const p0 = host.state.players[0]!;
  if (p0.cannons.length > 0) {
    host.state.cannonballs = [{
      cannonIdx: 0,
      startX: 100, startY: 200,
      x: 150, y: 250,
      targetX: 300, targetY: 400,
      speed: 5,
      playerId: 0 as ValidPlayerSlot,
      scoringPlayerId: 0 as ValidPlayerSlot,
      incendiary: false,
    }, {
      cannonIdx: 0,
      startX: 110, startY: 210,
      x: 160, y: 260,
      targetX: 310, targetY: 410,
      speed: 5,
      playerId: 0 as ValidPlayerSlot,
      scoringPlayerId: 0 as ValidPlayerSlot,
      incendiary: true,
    }];

    const msg = createFullStateMessage(host.state, 1);
    watcher.state.cannonballs = [];
    restoreFullStateSnapshot(watcher.state, msg);

    assert(watcher.state.cannonballs.length === 2, `expected 2 cannonballs, got ${watcher.state.cannonballs.length}`);
    const b0 = watcher.state.cannonballs[0]!;
    assert(b0.startX === 100, "ball 0 startX");
    assert(b0.x === 150, "ball 0 x");
    assert(b0.targetX === 300, "ball 0 targetX");
    assert(b0.speed === 5, "ball 0 speed");
    assert(b0.incendiary === false, "ball 0 incendiary");
    const b1 = watcher.state.cannonballs[1]!;
    assert(b1.incendiary === true, "ball 1 incendiary");
  }
});

test("full-state drops cannonballs with stale cannon references", () => {
  const { host, watcher } = createPair(42);
  // Add a cannonball referencing a non-existent cannon index
  host.state.cannonballs = [{
    cannonIdx: 99, // doesn't exist
    startX: 0, startY: 0, x: 0, y: 0,
    targetX: 100, targetY: 100,
    speed: 5, playerId: 0 as ValidPlayerSlot, scoringPlayerId: 0 as ValidPlayerSlot, incendiary: false,
  }];

  const msg = createFullStateMessage(host.state, 1);
  restoreFullStateSnapshot(watcher.state, msg);

  assert(watcher.state.cannonballs.length === 0,
    `stale cannonball should be dropped, got ${watcher.state.cannonballs.length}`);
});

// ---------------------------------------------------------------------------
// Captured cannons
// ---------------------------------------------------------------------------

test("full-state round-trip preserves captured cannons", () => {
  const { host, watcher } = createPair(42);
  const victim = host.state.players[1]!;
  if (victim.cannons.length > 0) {
    host.state.capturedCannons = [{
      cannon: victim.cannons[0]!,
      cannonIdx: 0,
      victimId: 1 as ValidPlayerSlot,
      capturerId: 0 as ValidPlayerSlot,
    }];

    const msg = createFullStateMessage(host.state, 1);
    watcher.state.capturedCannons = [];
    restoreFullStateSnapshot(watcher.state, msg);

    assert(watcher.state.capturedCannons.length === 1,
      `expected 1 captured cannon, got ${watcher.state.capturedCannons.length}`);
    assert(watcher.state.capturedCannons[0]!.victimId === 1, "captured cannon victimId");
    assert(watcher.state.capturedCannons[0]!.capturerId === 0, "captured cannon capturerId");
    assert(watcher.state.capturedCannons[0]!.cannonIdx === 0, "captured cannon cannonIdx");
  }
});

// ---------------------------------------------------------------------------
// Balloon hits
// ---------------------------------------------------------------------------

test("full-state round-trip preserves balloon hits", () => {
  const { host, watcher } = createPair(42);
  const p1 = host.state.players[1]!;
  if (p1.cannons.length > 0) {
    const cannon = p1.cannons[0]!;
    host.state.balloonHits.set(cannon, { count: 2, capturerIds: [0] });

    const msg = createFullStateMessage(host.state, 1);
    watcher.state.balloonHits = new Map();
    restoreFullStateSnapshot(watcher.state, msg);

    assert(watcher.state.balloonHits.size === 1, `expected 1 balloon hit, got ${watcher.state.balloonHits.size}`);
    const wp1 = watcher.state.players[1]!;
    const restoredCannon = wp1.cannons[0]!;
    const hit = watcher.state.balloonHits.get(restoredCannon);
    assert(hit !== undefined, "balloon hit not restored for watcher cannon");
    assert(hit!.count === 2, `balloon hit count: expected 2, got ${hit!.count}`);
    assert(hit!.capturerIds[0] === 0, "balloon hit capturerId");
  }
});

// ---------------------------------------------------------------------------
// Balloon flights
// ---------------------------------------------------------------------------

test("full-state round-trip preserves balloon flights", () => {
  const { host, watcher } = createPair(42);
  const flights = [
    { flight: { startX: 10, startY: 20, endX: 100, endY: 200 }, progress: 0.5 },
    { flight: { startX: 30, startY: 40, endX: 300, endY: 400 }, progress: 0.25 },
  ];

  const msg = createFullStateMessage(host.state, 1, flights);
  const result = restoreFullStateSnapshot(watcher.state, msg);

  assert(result !== null, "should succeed");
  assert(result!.balloonFlights !== undefined, "balloonFlights should be present");
  assert(result!.balloonFlights!.length === 2, `expected 2 flights, got ${result!.balloonFlights!.length}`);
  assert(result!.balloonFlights![0]!.flight.startX === 10, "flight 0 startX");
  assert(result!.balloonFlights![0]!.progress === 0.5, "flight 0 progress");
  assert(result!.balloonFlights![1]!.flight.endY === 400, "flight 1 endY");
  assert(result!.balloonFlights![1]!.progress === 0.25, "flight 1 progress");
});

test("full-state without flights returns undefined balloonFlights", () => {
  const { host, watcher } = createPair(42);
  const msg = createFullStateMessage(host.state, 1);
  const result = restoreFullStateSnapshot(watcher.state, msg);

  assert(result !== null, "should succeed");
  assert(result!.balloonFlights === undefined, "balloonFlights should be undefined when no flights");
});

// ---------------------------------------------------------------------------
// Validation — rejected messages (use createPair for valid base, then corrupt)
// ---------------------------------------------------------------------------

test("full-state rejects invalid phase string", () => {
  const { host, watcher } = createPair(42);
  const msg = createFullStateMessage(host.state, 1);
  msg.phase = "INVALID_PHASE";

  const result = restoreFullStateSnapshot(watcher.state, msg);
  assert(result === null, "should reject invalid phase");
});

test("full-state rejects mismatched player count", () => {
  const { host, watcher } = createPair(42);
  const msg = createFullStateMessage(host.state, 1);
  msg.players = msg.players.slice(0, 1);

  const result = restoreFullStateSnapshot(watcher.state, msg);
  assert(result === null, "should reject mismatched player count");
});

test("full-state rejects non-finite rngState", () => {
  const { host, watcher } = createPair(42);
  const msg = createFullStateMessage(host.state, 1);
  msg.rngState = NaN;

  const result = restoreFullStateSnapshot(watcher.state, msg);
  assert(result === null, "should reject NaN rngState");
});

test("full-state rejects out-of-bounds grunt position", () => {
  const { host, watcher } = createPair(42);
  const msg = createFullStateMessage(host.state, 1);
  msg.grunts.push({ row: -1, col: 0, defendingPlayerId: 0 });

  const result = restoreFullStateSnapshot(watcher.state, msg);
  assert(result === null, "should reject negative grunt row");
});

test("full-state rejects mismatched towerAlive length", () => {
  const { host, watcher } = createPair(42);
  const msg = createFullStateMessage(host.state, 1);
  msg.towerAlive = [true]; // wrong length

  const result = restoreFullStateSnapshot(watcher.state, msg);
  assert(result === null, "should reject mismatched towerAlive length");
});

// ---------------------------------------------------------------------------
// Eliminated player edge case
// ---------------------------------------------------------------------------

test("full-state round-trip preserves eliminated player state", () => {
  const { host, watcher } = createPair(42);
  host.state.players[1]!.eliminated = true;
  host.state.players[1]!.lives = 0;
  (host.state.players[1]!.walls as Set<number>).clear();
  host.state.players[1]!.interior = emptyFreshInterior();
  host.state.players[1]!.cannons = [];

  const msg = createFullStateMessage(host.state, 1);
  restoreFullStateSnapshot(watcher.state, msg);

  const wp = watcher.state.players[1]!;
  assert(wp.eliminated === true, "eliminated not preserved");
  assert(wp.lives === 0, "lives not preserved");
  assert(wp.walls.size === 0, "walls should be empty");
  assert(wp.interior.size === 0, "interior should be empty");
  assert(wp.cannons.length === 0, "cannons should be empty");
});

await runTests("Online full-state round-trip");
