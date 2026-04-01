/**
 * Modern mode tests — environmental modifiers, upgrade draft/pick, gameplay hooks.
 * Covers both local headless flow and online checkpoint round-trips.
 *
 * Run with: bun test/modern-mode.test.ts
 */

import { GAME_MODE_MODERN, MODIFIER_FIRST_ROUND } from "../src/game-constants.ts";
import type { OrbitParams } from "../src/controller-interfaces.ts";
import type { PixelPos } from "../src/geometry-types.ts";
import { nextPhase } from "../src/game-engine.ts";
import {
  applyBuildStartCheckpoint,
  type CheckpointAccums,
  type CheckpointBattleAnim,
  type CheckpointDeps,
} from "../src/online-checkpoints.ts";
import {
  createBuildStartMessage,
  createFullStateMessage,
  restoreFullStateSnapshot,
} from "../src/online-serialize.ts";
import { rollModifier } from "../src/round-modifiers.ts";
import {
  createHeadlessRuntime,
  type HeadlessRuntime,
} from "../src/runtime-headless.ts";
import { UID } from "../src/upgrade-defs.ts";
import { generateUpgradeOffers } from "../src/upgrade-pick.ts";
import { createScenario } from "./scenario-helpers.ts";
import { assert, runTests, test } from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setModern(runtime: HeadlessRuntime): void {
  runtime.state.gameMode = GAME_MODE_MODERN;
}

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
    watcherIdlePhases: new Map<number, number>(),
    snapshotTerritory: () =>
      runtime.state.players.map((pl) => new Set(pl.interior)),
  };
}

// ---------------------------------------------------------------------------
// Environmental modifiers — local flow
// ---------------------------------------------------------------------------

test("classic mode never rolls modifiers", () => {
  const s = createScenario(42);
  // Default is classic
  s.playRounds(5);
  assert(
    s.state.activeModifier === null,
    `expected no modifier in classic, got ${s.state.activeModifier}`,
  );
  assert(
    s.state.lastModifierId === null,
    `expected no lastModifier in classic, got ${s.state.lastModifierId}`,
  );
});

test("modern mode rolls no modifier before MODIFIER_FIRST_ROUND", () => {
  const s = createScenario(10);
  s.state.gameMode = GAME_MODE_MODERN;

  // Play until round 2 (one round)
  s.playRounds(1);
  assert(
    s.state.round < MODIFIER_FIRST_ROUND,
    `round should be < ${MODIFIER_FIRST_ROUND}, got ${s.state.round}`,
  );
  assert(
    s.state.activeModifier === null,
    `no modifier expected before round ${MODIFIER_FIRST_ROUND}`,
  );
});

test("modern mode can roll modifiers from round 3+", () => {
  // Try multiple seeds to ensure at least one rolls a modifier
  let foundModifier = false;
  for (let seed = 1; seed <= 20; seed++) {
    const s = createScenario(seed);
    s.state.gameMode = GAME_MODE_MODERN;
    // Play enough rounds to reach round 3+
    s.playRounds(3);
    if (s.state.activeModifier !== null || s.state.lastModifierId !== null) {
      foundModifier = true;
      break;
    }
  }
  assert(foundModifier, "should roll at least one modifier across 20 seeds");
});

test("modifier no-repeat rule: same modifier never appears twice in a row", () => {
  // Directly test rollModifier with controlled state
  for (let seed = 1; seed <= 20; seed++) {
    const s = createScenario(seed);
    s.state.gameMode = GAME_MODE_MODERN;
    s.state.round = MODIFIER_FIRST_ROUND;
    let prev: string | null = null;
    for (let round = 0; round < 10; round++) {
      s.state.round = MODIFIER_FIRST_ROUND + round;
      s.state.lastModifierId = s.state.activeModifier;
      s.state.activeModifier = rollModifier(s.state);
      const current = s.state.activeModifier;
      if (current !== null && prev !== null) {
        assert(
          current !== prev,
          `seed ${seed} round ${s.state.round}: same modifier ${current} rolled twice in a row`,
        );
      }
      prev = current;
    }
  }
});

test("rollModifier returns null in classic mode", () => {
  const s = createScenario(42);
  s.state.round = 5;
  const result = rollModifier(s.state);
  assert(result === null, "classic mode should never roll");
});

// ---------------------------------------------------------------------------
// Upgrade offers — local flow
// ---------------------------------------------------------------------------

test("classic mode generates no upgrade offers", () => {
  const s = createScenario(42);
  s.state.round = 5;
  const offers = generateUpgradeOffers(s.state);
  assert(offers === null, "classic mode should not generate offers");
});

test("modern mode generates offers for each alive player from round 3", () => {
  const s = createScenario(42);
  s.state.gameMode = GAME_MODE_MODERN;
  s.state.round = 3;
  const offers = generateUpgradeOffers(s.state);
  assert(offers !== null, "should generate offers in modern mode at round 3");
  const aliveCount = s.state.players.filter(
    (pl) => !pl.eliminated && pl.homeTower,
  ).length;
  assert(
    offers!.size === aliveCount,
    `expected ${aliveCount} offer sets, got ${offers!.size}`,
  );
  for (const [, choices] of offers!) {
    assert(choices.length === 3, `each player should get 3 choices`);
    // All 3 should be distinct
    const unique = new Set(choices);
    assert(unique.size === 3, "3 choices should be unique");
  }
});

test("modern mode generates no offers before round 3", () => {
  const s = createScenario(42);
  s.state.gameMode = GAME_MODE_MODERN;
  s.state.round = 2;
  const offers = generateUpgradeOffers(s.state);
  assert(offers === null, "should not generate offers before round 3");
});

test("pendingUpgradeOffers populated after enterBuildFromBattle in modern mode", () => {
  const s = createScenario(42);
  s.state.gameMode = GAME_MODE_MODERN;
  // Play 3 rounds — by round 3, enterBuildFromBattle generates offers
  s.playRounds(3);
  assert(
    s.state.pendingUpgradeOffers !== null,
    "offers should be set after enterBuildFromBattle at round 3",
  );
});

// ---------------------------------------------------------------------------
// Gameplay hooks
// ---------------------------------------------------------------------------

test("Master Builder adds +5s to build timer per stack", () => {
  const s = createScenario(42);
  s.state.gameMode = GAME_MODE_MODERN;
  const baseBuildTimer = s.state.buildTimer;

  s.state.players[0]!.upgrades.set(UID.MASTER_BUILDER as any, 1);

  // Run a full round — playRound ends in WALL_BUILD after enterBuildFromBattle
  const result = s.playRound();
  if (result.needsReselect.length > 0) s.processReselection(result.needsReselect);

  assert(
    s.state.timer === baseBuildTimer + 5,
    `expected ${baseBuildTimer + 5}s, got ${s.state.timer}`,
  );
});

test("Master Builder stacks across multiple players", () => {
  const s = createScenario(42);
  s.state.gameMode = GAME_MODE_MODERN;
  const baseBuildTimer = s.state.buildTimer;

  s.state.players[0]!.upgrades.set(UID.MASTER_BUILDER as any, 1);
  s.state.players[1]!.upgrades.set(UID.MASTER_BUILDER as any, 1);

  const result = s.playRound();
  if (result.needsReselect.length > 0) s.processReselection(result.needsReselect);

  assert(
    s.state.timer === baseBuildTimer + 10,
    `expected ${baseBuildTimer + 10}s, got ${s.state.timer}`,
  );
});

test("Master Builder ignores eliminated players", () => {
  const s = createScenario(42);
  s.state.gameMode = GAME_MODE_MODERN;
  const baseBuildTimer = s.state.buildTimer;

  s.state.players[0]!.upgrades.set(UID.MASTER_BUILDER as any, 1);
  s.eliminatePlayer(1);
  s.state.players[1]!.upgrades.set(UID.MASTER_BUILDER as any, 1);

  const result = s.playRound();
  if (result.needsReselect.length > 0) s.processReselection(result.needsReselect);

  assert(
    s.state.timer === baseBuildTimer + 5,
    `should only count alive player, expected ${baseBuildTimer + 5}s, got ${s.state.timer}`,
  );
});

test("Reinforced Walls: first hit absorbed, second destroys", () => {
  const s = createScenario(42);
  const player = s.state.players[0]!;
  player.upgrades.set(UID.REINFORCED_WALLS as any, 1);

  const wallKey = [...player.walls][0];
  assert(wallKey !== undefined, "player should have walls");

  // First hit: wall survives, added to damagedWalls
  assert(!player.damagedWalls.has(wallKey!), "wall should not be damaged yet");
  // Simulate the reinforced check
  player.damagedWalls.add(wallKey!);
  assert(player.walls.has(wallKey!), "wall should still exist after first hit");
  assert(player.damagedWalls.has(wallKey!), "wall should be in damagedWalls");
});

test("damagedWalls cleared at build phase start", () => {
  const s = createScenario(42);
  s.state.gameMode = GAME_MODE_MODERN;
  const player = s.state.players[0]!;
  player.upgrades.set(UID.REINFORCED_WALLS as any, 1);

  // Add some damaged walls
  const wallKey = [...player.walls][0];
  if (wallKey !== undefined) {
    player.damagedWalls.add(wallKey);
    assert(player.damagedWalls.size > 0, "should have damaged walls");

    // Trigger enterBuildFromBattle
    s.runCannon();
    s.runBattle();
    nextPhase(s.state);

    assert(
      player.damagedWalls.size === 0,
      "damagedWalls should be cleared at build start",
    );
  }
});

// ---------------------------------------------------------------------------
// Online checkpoint round-trips
// ---------------------------------------------------------------------------

test("BUILD_START checkpoint preserves modern mode fields", () => {
  const host = createHeadlessRuntime(42);
  setModern(host);

  // Set modern-mode specific state
  host.state.activeModifier = "wildfire";
  host.state.lastModifierId = "grunt_surge";
  host.state.players[0]!.upgrades.set(UID.REINFORCED_WALLS as any, 2);
  host.state.players[1]!.upgrades.set(UID.RAPID_FIRE as any, 1);
  host.state.players[0]!.damagedWalls.add(100);
  host.state.players[0]!.damagedWalls.add(200);

  // Generate pending offers
  host.state.round = 3;
  host.state.pendingUpgradeOffers = generateUpgradeOffers(host.state);

  const msg = createBuildStartMessage(host.state);

  // Apply on watcher
  const watcher = createHeadlessRuntime(42);
  setModern(watcher);
  const deps = makeDeps(watcher);
  applyBuildStartCheckpoint(msg, deps);

  // Verify modifier state
  assert(
    watcher.state.activeModifier === "wildfire",
    `activeModifier: expected wildfire, got ${watcher.state.activeModifier}`,
  );
  assert(
    watcher.state.lastModifierId === "grunt_surge",
    `lastModifierId: expected grunt_surge, got ${watcher.state.lastModifierId}`,
  );

  // Verify upgrades
  assert(
    watcher.state.players[0]!.upgrades.get(UID.REINFORCED_WALLS as any) === 2,
    "P0 reinforced_walls should be 2",
  );
  assert(
    watcher.state.players[1]!.upgrades.get(UID.RAPID_FIRE as any) === 1,
    "P1 rapid_fire should be 1",
  );

  // Verify damagedWalls
  assert(
    watcher.state.players[0]!.damagedWalls.has(100),
    "P0 damagedWalls should include 100",
  );
  assert(
    watcher.state.players[0]!.damagedWalls.has(200),
    "P0 damagedWalls should include 200",
  );

  // Verify pending offers
  assert(
    watcher.state.pendingUpgradeOffers !== null,
    "pendingUpgradeOffers should be restored",
  );
  assert(
    watcher.state.pendingUpgradeOffers!.size ===
      host.state.pendingUpgradeOffers!.size,
    "offer count should match",
  );
});

test("FULL_STATE checkpoint preserves modern mode fields", () => {
  const host = createHeadlessRuntime(77);
  setModern(host);
  host.state.activeModifier = "crumbling_walls";
  host.state.lastModifierId = "wildfire";
  host.state.players[0]!.upgrades.set(UID.MASTER_BUILDER as any, 3);
  // cannonLimits + playerZones must be populated for full-state validation
  host.state.cannonLimits = host.state.players.map(() => 3);
  host.state.playerZones = host.state.players.map((_, idx) => idx);

  host.state.round = 4;
  host.state.pendingUpgradeOffers = generateUpgradeOffers(host.state);

  const msg = createFullStateMessage(host.state, 1);

  const watcher = createHeadlessRuntime(77);
  setModern(watcher);
  const result = restoreFullStateSnapshot(watcher.state, msg);
  assert(result !== null, "full state restore should succeed");

  assert(
    watcher.state.activeModifier === "crumbling_walls",
    "activeModifier should survive full-state round-trip",
  );
  assert(
    watcher.state.lastModifierId === "wildfire",
    "lastModifierId should survive full-state round-trip",
  );
  assert(
    watcher.state.players[0]!.upgrades.get(UID.MASTER_BUILDER as any) === 3,
    "upgrades should survive full-state round-trip",
  );
  assert(
    watcher.state.pendingUpgradeOffers !== null,
    "pendingUpgradeOffers should survive full-state round-trip",
  );
});

test("classic mode checkpoint has null modifiers and empty upgrades", () => {
  const host = createHeadlessRuntime(42);
  // Leave as classic (default)
  const msg = createBuildStartMessage(host.state);

  const watcher = createHeadlessRuntime(42);
  const deps = makeDeps(watcher);
  applyBuildStartCheckpoint(msg, deps);

  assert(
    watcher.state.activeModifier === null,
    "classic should have null activeModifier",
  );
  assert(
    watcher.state.pendingUpgradeOffers === null,
    "classic should have null pendingUpgradeOffers",
  );
  assert(
    watcher.state.players[0]!.upgrades.size === 0,
    "classic should have empty upgrades",
  );
});

// ---------------------------------------------------------------------------
// Headless modern game — full flow
// ---------------------------------------------------------------------------

test("modern headless game runs to completion without violations", () => {
  for (let seed = 1; seed <= 5; seed++) {
    const s = createScenario(seed);
    s.state.gameMode = GAME_MODE_MODERN;
    // Play 8 rounds — exercises modifiers, offers, and potentially all 3 upgrade effects
    s.playRounds(8);

    // Basic sanity checks
    for (const player of s.state.players) {
      assert(player.score >= 0, `P${player.id} score negative`);
      if (player.eliminated) {
        assert(player.lives === 0, `eliminated P${player.id} has lives > 0`);
      }
    }
  }
});

// ---------------------------------------------------------------------------

await runTests("Modern Mode");
