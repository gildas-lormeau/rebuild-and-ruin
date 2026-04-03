/**
 * Checkpoint round-trip tests: serialize game state → apply checkpoint → verify fidelity.
 *
 * These tests catch serialization drift between host and watcher — the #1
 * source of subtle online bugs.
 *
 * Run with: bun test/online-checkpoints.test.ts
 */

import type { OrbitParams } from "../src/controller-interfaces.ts";
import { type ValidPlayerSlot } from "../src/game-constants.ts";
import type { PixelPos } from "../src/geometry-types.ts";
import {
  applyBattleStartCheckpoint,
  applyBuildStartCheckpoint,
  applyCannonStartCheckpoint,
  type CheckpointAccums,
  type CheckpointBattleAnim,
  type CheckpointDeps,
} from "../src/online-checkpoints.ts";
import {
  createBattleStartMessage,
  createBuildStartMessage,
  createCannonStartMessage,
} from "../src/online-serialize.ts";
import {
  createHeadlessRuntime,
  type HeadlessRuntime,
} from "../src/runtime-headless.ts";
import { CannonMode, emptyFreshInterior } from "../src/types.ts";
import { assert, runTests, test } from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshAccums(): CheckpointAccums {
  return { battle: 0, cannon: 0, select: 0, build: 0, grunt: 0 };
}

function freshBattleAnim(): CheckpointBattleAnim {
  return { territory: [], walls: [], flights: [], impacts: [] };
}

function makeDeps(runtime: HeadlessRuntime): CheckpointDeps {
  return {
    state: runtime.state,
    battleAnim: freshBattleAnim(),
    accum: freshAccums(),
    remoteCrosshairs: new Map<number, PixelPos>(),
    watcherCrosshairPos: new Map<number, PixelPos>(),
    watcherOrbitParams: new Map<number, OrbitParams>(),
    watcherOrbitAngles: new Map<number, number>(),
    snapshotTerritory: () =>
      runtime.state.players.map((p) => new Set(p.interior)),
  };
}


function setsEqual(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Cannon-start checkpoint round-trip
// ---------------------------------------------------------------------------

test("cannon-start checkpoint round-trip preserves player state", () => {
  const host = createHeadlessRuntime(42);
  // Host is at CANNON_PLACE — serialize cannon-start message
  const msg = createCannonStartMessage(host.state);

  // Create a second runtime as the "watcher" with same seed
  const watcher = createHeadlessRuntime(42);
  // Mutate watcher state to diverge (simulates stale watcher)
  watcher.state.players[0]!.lives = 0;
  watcher.state.players[0]!.score = 9999;

  const deps = makeDeps(watcher);
  applyCannonStartCheckpoint(msg, deps);

  // Verify watcher state matches host
  for (let i = 0; i < host.state.players.length; i++) {
    const hp = host.state.players[i]!;
    const wp = watcher.state.players[i]!;
    assert(setsEqual(hp.walls, wp.walls), `player ${i} walls mismatch after cannon checkpoint`);
    assert(setsEqual(hp.interior, wp.interior), `player ${i} interior mismatch after cannon checkpoint`);
    assert(hp.lives === wp.lives, `player ${i} lives mismatch: host=${hp.lives}, watcher=${wp.lives}`);
    assert(hp.score === wp.score, `player ${i} score mismatch: host=${hp.score}, watcher=${wp.score}`);
    assert(hp.eliminated === wp.eliminated, `player ${i} eliminated mismatch`);
    assert(hp.cannons.length === wp.cannons.length, `player ${i} cannon count mismatch`);
    for (let c = 0; c < hp.cannons.length; c++) {
      assert(hp.cannons[c]!.row === wp.cannons[c]!.row, `player ${i} cannon ${c} row mismatch`);
      assert(hp.cannons[c]!.col === wp.cannons[c]!.col, `player ${i} cannon ${c} col mismatch`);
      assert(hp.cannons[c]!.hp === wp.cannons[c]!.hp, `player ${i} cannon ${c} hp mismatch`);
      assert(hp.cannons[c]!.mode === wp.cannons[c]!.mode, `player ${i} cannon ${c} mode mismatch`);
    }
  }
});

test("cannon-start checkpoint preserves timer and limits", () => {
  const host = createHeadlessRuntime(42);
  host.state.timer = 12.5;
  host.state.cannonLimits = [3, 5, 2];
  const msg = createCannonStartMessage(host.state);

  const watcher = createHeadlessRuntime(42);
  watcher.state.timer = 0;
  watcher.state.cannonLimits = [0, 0, 0];
  const deps = makeDeps(watcher);
  applyCannonStartCheckpoint(msg, deps);

  assert(watcher.state.timer === 12.5, `timer mismatch: expected 12.5, got ${watcher.state.timer}`);
  assert(watcher.state.cannonLimits[0] === 3, `limits[0] mismatch`);
  assert(watcher.state.cannonLimits[1] === 5, `limits[1] mismatch`);
  assert(watcher.state.cannonLimits[2] === 2, `limits[2] mismatch`);
});

test("cannon-start checkpoint preserves grunts", () => {
  const host = createHeadlessRuntime(42);
  // Add a grunt manually
  host.state.grunts.push({ row: 5, col: 10, victimPlayerId: 0, blockedBattles: 0 });
  const msg = createCannonStartMessage(host.state);

  const watcher = createHeadlessRuntime(42);
  watcher.state.grunts = [];
  const deps = makeDeps(watcher);
  applyCannonStartCheckpoint(msg, deps);

  assert(watcher.state.grunts.length === host.state.grunts.length,
    `grunt count: expected ${host.state.grunts.length}, got ${watcher.state.grunts.length}`);
  const last = watcher.state.grunts[watcher.state.grunts.length - 1]!;
  assert(last.row === 5 && last.col === 10, "injected grunt position lost");
  assert(last.victimPlayerId === 0, "injected grunt victimPlayerId lost");
});

test("cannon-start checkpoint preserves bonus squares and burning pits", () => {
  const host = createHeadlessRuntime(42);
  host.state.bonusSquares = [{ row: 3, col: 4, zone: 1 }];
  host.state.burningPits = [{ row: 7, col: 8, roundsLeft: 2 }];
  const msg = createCannonStartMessage(host.state);

  const watcher = createHeadlessRuntime(42);
  watcher.state.bonusSquares = [];
  watcher.state.burningPits = [];
  const deps = makeDeps(watcher);
  applyCannonStartCheckpoint(msg, deps);

  assert(watcher.state.bonusSquares.length === 1, "bonus square lost");
  assert(watcher.state.bonusSquares[0]!.row === 3, "bonus square row wrong");
  assert(watcher.state.burningPits.length === 1, "burning pit lost");
  assert(watcher.state.burningPits[0]!.roundsLeft === 2, "burning pit roundsLeft wrong");
});

test("cannon-start checkpoint clears watcher crosshairs", () => {
  const watcher = createHeadlessRuntime(42);
  const deps = makeDeps(watcher);
  deps.remoteCrosshairs.set(0, { x: 100, y: 200 });
  deps.watcherCrosshairPos.set(0, { x: 100, y: 200 });
  deps.watcherOrbitParams.set(0, { rx: 10, ry: 10, speed: 1, phaseAngle: 0 } as OrbitParams);
  deps.watcherOrbitAngles.set(0, 5);

  const msg = createCannonStartMessage(watcher.state);
  applyCannonStartCheckpoint(msg, deps);

  assert(deps.remoteCrosshairs.size === 0, "remoteCrosshairs not cleared");
  assert(deps.watcherCrosshairPos.size === 0, "watcherCrosshairPos not cleared");
  assert(deps.watcherOrbitParams.size === 0, "watcherOrbitParams not cleared");
  assert(deps.watcherOrbitAngles.size === 0, "watcherOrbitAngles not cleared");
});

test("cannon-start checkpoint clears cannonballs and impacts", () => {
  const watcher = createHeadlessRuntime(42);
  const deps = makeDeps(watcher);
  // Pollute state
  deps.state.cannonballs = [{ cannonIdx: 0, startX: 0, startY: 0, x: 5, y: 5, targetX: 10, targetY: 10, speed: 1, playerId: 0 as ValidPlayerSlot, scoringPlayerId: 0 as ValidPlayerSlot, incendiary: false }];
  deps.battleAnim.impacts = [{ row: 1, col: 1, age: 0.5 }];

  const msg = createCannonStartMessage(watcher.state);
  applyCannonStartCheckpoint(msg, deps);

  assert(deps.state.cannonballs.length === 0, "cannonballs not cleared");
  assert(deps.battleAnim.impacts.length === 0, "impacts not cleared");
});

// ---------------------------------------------------------------------------
// Battle-start checkpoint round-trip
// ---------------------------------------------------------------------------

test("battle-start checkpoint round-trip preserves player state", () => {
  const host = createHeadlessRuntime(99);
  const msg = createBattleStartMessage(host.state);

  const watcher = createHeadlessRuntime(99);
  watcher.state.players[0]!.score = 9999;
  const deps = makeDeps(watcher);
  applyBattleStartCheckpoint(msg, deps);

  for (let i = 0; i < host.state.players.length; i++) {
    const hp = host.state.players[i]!;
    const wp = watcher.state.players[i]!;
    assert(setsEqual(hp.walls, wp.walls), `battle: player ${i} walls mismatch`);
    assert(hp.lives === wp.lives, `battle: player ${i} lives mismatch`);
    assert(hp.score === wp.score, `battle: player ${i} score mismatch: host=${hp.score} watcher=${wp.score}`);
  }
});

test("battle-start checkpoint snapshots territory and walls for banner", () => {
  const watcher = createHeadlessRuntime(99);
  const deps = makeDeps(watcher);
  deps.battleAnim.territory = [];
  deps.battleAnim.walls = [];

  const msg = createBattleStartMessage(watcher.state);
  applyBattleStartCheckpoint(msg, deps);

  // snapshotTerritory and snapshotAllWalls should have been called
  assert(deps.battleAnim.territory.length > 0, "territory snapshot not taken");
  assert(deps.battleAnim.walls.length > 0, "walls snapshot not taken");
});

test("battle-start checkpoint preserves captured cannons", () => {
  const host = createHeadlessRuntime(99);
  // Manually set up a captured cannon
  const victim = host.state.players[1]!;
  if (victim.cannons.length > 0) {
    host.state.capturedCannons = [{
      cannon: victim.cannons[0]!,
      cannonIdx: 0,
      victimId: 1 as ValidPlayerSlot,
      capturerId: 0 as ValidPlayerSlot,
    }];
  }
  const msg = createBattleStartMessage(host.state);

  const watcher = createHeadlessRuntime(99);
  watcher.state.capturedCannons = [];
  const deps = makeDeps(watcher);
  applyBattleStartCheckpoint(msg, deps);

  if (host.state.capturedCannons.length > 0) {
    assert(watcher.state.capturedCannons.length === 1,
      `expected 1 captured cannon, got ${watcher.state.capturedCannons.length}`);
    assert(watcher.state.capturedCannons[0]!.victimId === 1, "captured cannon victimId wrong");
    assert(watcher.state.capturedCannons[0]!.capturerId === 0, "captured cannon capturerId wrong");
  }
});

test("battle-start checkpoint sets crosshairs to home tower positions", () => {
  const watcher = createHeadlessRuntime(99);
  const deps = makeDeps(watcher);

  const msg = createBattleStartMessage(watcher.state);
  applyBattleStartCheckpoint(msg, deps);

  // Non-eliminated players with home towers should get crosshair positions
  for (const player of watcher.state.players) {
    if (player.eliminated || !player.homeTower) continue;
    assert(deps.watcherCrosshairPos.has(player.id),
      `player ${player.id} should have crosshair pos after battle checkpoint`);
  }
});

// ---------------------------------------------------------------------------
// Build-start checkpoint round-trip
// ---------------------------------------------------------------------------

test("build-start checkpoint round-trip preserves round and timer", () => {
  const host = createHeadlessRuntime(77);
  host.state.round = 5;
  host.state.timer = 20;
  const msg = createBuildStartMessage(host.state);

  const watcher = createHeadlessRuntime(77);
  watcher.state.round = 1;
  watcher.state.timer = 0;
  const deps = makeDeps(watcher);
  applyBuildStartCheckpoint(msg, deps);

  assert(watcher.state.round === 5, `round: expected 5, got ${watcher.state.round}`);
  assert(watcher.state.timer === 20, `timer: expected 20, got ${watcher.state.timer}`);
});

test("build-start checkpoint resets grunt accumulator", () => {
  const watcher = createHeadlessRuntime(77);
  const deps = makeDeps(watcher);
  deps.accum.grunt = 99;

  const msg = createBuildStartMessage(watcher.state);
  applyBuildStartCheckpoint(msg, deps);

  assert(deps.accum.grunt === 0, `grunt accum should be reset to 0, got ${deps.accum.grunt}`);
});

test("build-start checkpoint preserves house alive status", () => {
  const host = createHeadlessRuntime(77);
  // Kill some houses on host
  host.state.map.houses[0]!.alive = false;
  host.state.map.houses[2]!.alive = false;
  const msg = createBuildStartMessage(host.state);

  const watcher = createHeadlessRuntime(77);
  const deps = makeDeps(watcher);
  applyBuildStartCheckpoint(msg, deps);

  // Positions come from seed (identical), alive status comes from checkpoint
  assert(!watcher.state.map.houses[0]!.alive, "house 0 should be dead");
  assert(watcher.state.map.houses[1]!.alive, "house 1 should be alive");
  assert(!watcher.state.map.houses[2]!.alive, "house 2 should be dead");
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("checkpoint handles eliminated players correctly", () => {
  const host = createHeadlessRuntime(42);
  host.state.players[1]!.eliminated = true;
  host.state.players[1]!.lives = 0;
  (host.state.players[1]!.walls as Set<number>).clear();
  host.state.players[1]!.interior = emptyFreshInterior();
  const msg = createCannonStartMessage(host.state);

  const watcher = createHeadlessRuntime(42);
  const deps = makeDeps(watcher);
  applyCannonStartCheckpoint(msg, deps);

  assert(watcher.state.players[1]!.eliminated === true, "eliminated flag not preserved");
  assert(watcher.state.players[1]!.lives === 0, "eliminated player lives not preserved");
  assert(watcher.state.players[1]!.walls.size === 0, "eliminated player walls should be empty");
});

test("checkpoint preserves cannon modes (normal, super, balloon)", () => {
  const host = createHeadlessRuntime(42);
  const p = host.state.players[0]!;
  // Replace cannons with known modes
  p.cannons = [
    { row: 5, col: 5, hp: 3, mode: CannonMode.NORMAL, facing: 0 },
    { row: 7, col: 7, hp: 3, mode: CannonMode.SUPER, facing: 1 },
    { row: 9, col: 9, hp: 3, mode: CannonMode.BALLOON, facing: 2 },
  ];
  const msg = createCannonStartMessage(host.state);

  const watcher = createHeadlessRuntime(42);
  const deps = makeDeps(watcher);
  applyCannonStartCheckpoint(msg, deps);

  const wp = watcher.state.players[0]!;
  assert(wp.cannons.length === 3, `expected 3 cannons, got ${wp.cannons.length}`);
  assert(wp.cannons[0]!.mode === CannonMode.NORMAL, `cannon 0 mode: expected NORMAL, got ${wp.cannons[0]!.mode}`);
  assert(wp.cannons[1]!.mode === CannonMode.SUPER, `cannon 1 mode: expected SUPER, got ${wp.cannons[1]!.mode}`);
  assert(wp.cannons[2]!.mode === CannonMode.BALLOON, `cannon 2 mode: expected BALLOON, got ${wp.cannons[2]!.mode}`);
});

test("checkpoint preserves towerAlive array", () => {
  const host = createHeadlessRuntime(42);
  // Kill a tower
  if (host.state.towerAlive.length > 1) {
    host.state.towerAlive[1] = false;
  }
  const msg = createCannonStartMessage(host.state);

  const watcher = createHeadlessRuntime(42);
  const deps = makeDeps(watcher);
  applyCannonStartCheckpoint(msg, deps);

  for (let i = 0; i < host.state.towerAlive.length; i++) {
    assert(watcher.state.towerAlive[i] === host.state.towerAlive[i],
      `towerAlive[${i}]: expected ${host.state.towerAlive[i]}, got ${watcher.state.towerAlive[i]}`);
  }
});

await runTests("Online checkpoint round-trip");
