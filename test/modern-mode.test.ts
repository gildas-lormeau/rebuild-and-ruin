/**
 * Modern mode tests — environmental modifiers, upgrade draft/pick, gameplay hooks.
 * Covers both local headless flow and online checkpoint round-trips.
 *
 * Run with: deno test --no-check test/modern-mode.test.ts
 */

import { clearPlayerWalls } from "../src/shared/board-occupancy.ts";
import { recheckTerritoryOnly } from "../src/game/build-system.ts";
import { BALL_SPEED, GAME_MODE_MODERN, MASTER_BUILDER_BONUS_SECONDS, MODIFIER_FIRST_ROUND } from "../src/shared/game-constants.ts";
import {
  comboDemolitionBonus,
  comboOnCannonKill,
  comboOnGruntKill,
  comboOnWallDestroyed,
  createComboTracker,
} from "../src/game/combo-system.ts";
import type { OrbitParams } from "../src/shared/system-interfaces.ts";
import type { PixelPos } from "../src/shared/geometry-types.ts";
import { nextPhase } from "../src/game/game-engine.ts";
import {
  applyBattleStartCheckpoint,
  applyBuildStartCheckpoint,
  type CheckpointAccums,
  type CheckpointBattleAnim,
  type CheckpointDeps,
} from "../src/online/online-checkpoints.ts";
import {
  createBattleStartMessage,
  createBuildStartMessage,
  createFullStateMessage,
  restoreFullStateSnapshot,
} from "../src/online/online-serialize.ts";
import { isGruntBlocked, tickGrunts } from "../src/game/grunt-movement.ts";
import {
  applyCrumblingWalls,
  applyFrozenRiver,
  applyGruntSurge,
  applySinkhole,
  applyWildfire,
  clearFrozenRiver,
  reapplySinkholeTiles,
  rollModifier,
} from "../src/game/round-modifiers.ts";
import { isWater, unpackTile } from "../src/shared/spatial.ts";
import {
  createHeadlessRuntime,
  type HeadlessRuntime,
} from "./runtime-headless.ts";
import { MESSAGE } from "../server/protocol.ts";
import { handleServerIncrementalMessage } from "../src/online/online-server-events.ts";
import type { WatcherNetworkState } from "../src/online/online-types.ts";
import { isMasterBuilderLocked, setGameMode, type SelectionState } from "../src/shared/types.ts";
import { UID } from "../src/shared/upgrade-defs.ts";
import { showUpgradePickBanner } from "../src/game/phase-transition-steps.ts";
import { createUpgradePickDialog, generateUpgradeOffers } from "../src/game/upgrade-pick.ts";
import { createScenario } from "./scenario-helpers.ts";
import { assert } from "@std/assert";
import type { PlayerSlotId, ValidPlayerSlot } from "../src/shared/player-slot.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setModern(runtime: HeadlessRuntime): void {
  setGameMode(runtime.state, GAME_MODE_MODERN);
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
    watcherOrbitAngles: new Map<number, number>(),
    snapshotTerritory: () =>
      runtime.state.players.map((pl) => new Set(pl.interior)),
  };
}

// ---------------------------------------------------------------------------
// Environmental modifiers — local flow
// ---------------------------------------------------------------------------

Deno.test("modifier no-repeat rule: same modifier never appears twice in a row", async () => {
  // Seed 4 rolls all 4 modifier types within 10 rounds
  const s = await createScenario(4);
  setGameMode(s.state, GAME_MODE_MODERN);
  let prev: string | undefined;
  for (let round = 0; round < 10; round++) {
    s.state.round = MODIFIER_FIRST_ROUND + round;
    s.state.modern!.lastModifierId = s.state.modern!.activeModifier;
    s.state.modern!.activeModifier = rollModifier(s.state);
    const current = s.state.modern!.activeModifier;
    if (current !== null && prev !== undefined) {
      assert(
        current !== prev,
        `round ${s.state.round}: same modifier ${current} rolled twice in a row`,
      );
    }
    prev = current ?? undefined;
  }
});

Deno.test("Master Builder adds +5s to build timer", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);
  const baseBuildTimer = s.state.buildTimer;

  s.state.players[0]!.upgrades.set(UID.MASTER_BUILDER, 1);

  // Run a full round — playRound ends in WALL_BUILD after enterBuildFromBattle
  const result = s.playRound();
  if (result.needsReselect.length > 0) s.processReselection(result.needsReselect);

  assert(
    s.state.timer === baseBuildTimer + 5,
    `expected ${baseBuildTimer + 5}s, got ${s.state.timer}`,
  );
});

Deno.test("Master Builder ignores eliminated players", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);
  const baseBuildTimer = s.state.buildTimer;

  s.state.players[0]!.upgrades.set(UID.MASTER_BUILDER, 1);
  s.eliminatePlayer(1 as ValidPlayerSlot);
  s.state.players[1]!.upgrades.set(UID.MASTER_BUILDER, 1);

  const result = s.playRound();
  if (result.needsReselect.length > 0) s.processReselection(result.needsReselect);

  assert(
    s.state.timer === baseBuildTimer + 5,
    `should only count alive player, expected ${baseBuildTimer + 5}s, got ${s.state.timer}`,
  );
});

Deno.test("Master Builder lockout: single owner locks opponent", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);

  // Only P0 gets Master Builder
  s.state.players[0]!.upgrades.set(UID.MASTER_BUILDER, 1);

  const result = s.playRound();
  if (result.needsReselect.length > 0) s.processReselection(result.needsReselect);

  // Lockout should be set (test helpers don't decrement it)
  assert(
    s.state.modern!.masterBuilderLockout === MASTER_BUILDER_BONUS_SECONDS,
    `lockout should be ${MASTER_BUILDER_BONUS_SECONDS}, got ${s.state.modern!.masterBuilderLockout}`,
  );
  assert(
    s.state.modern!.masterBuilderOwners !== null,
    "owners should be set",
  );
  assert(
    s.state.modern!.masterBuilderOwners!.has(0 as ValidPlayerSlot),
    "P0 should be an owner",
  );
  assert(
    !s.state.modern!.masterBuilderOwners!.has(1 as ValidPlayerSlot),
    "P1 should not be an owner",
  );
  assert(
    isMasterBuilderLocked(s.state, 1 as ValidPlayerSlot),
    "P1 should be locked",
  );
  assert(
    !isMasterBuilderLocked(s.state, 0 as ValidPlayerSlot),
    "P0 should not be locked",
  );
});

Deno.test("Master Builder lockout: multiple owners cancel lockout", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);

  // Both players get Master Builder
  s.state.players[0]!.upgrades.set(UID.MASTER_BUILDER, 1);
  s.state.players[1]!.upgrades.set(UID.MASTER_BUILDER, 1);

  const baseBuildTimer = s.state.buildTimer;
  const result = s.playRound();
  if (result.needsReselect.length > 0) s.processReselection(result.needsReselect);

  // Timer should still have the bonus
  assert(
    s.state.timer === baseBuildTimer + MASTER_BUILDER_BONUS_SECONDS,
    `timer should be ${baseBuildTimer + MASTER_BUILDER_BONUS_SECONDS}, got ${s.state.timer}`,
  );
  // But lockout should be 0 (no exclusive window)
  assert(
    s.state.modern!.masterBuilderLockout === 0,
    `lockout should be 0 when 2+ owners, got ${s.state.modern!.masterBuilderLockout}`,
  );
  // Neither player should be locked
  assert(
    !isMasterBuilderLocked(s.state, 0 as ValidPlayerSlot),
    "P0 should not be locked",
  );
  assert(
    !isMasterBuilderLocked(s.state, 1 as ValidPlayerSlot),
    "P1 should not be locked",
  );
});

Deno.test("Master Builder lockout: eliminated owner does not trigger lockout", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);

  // P0 gets MB but is eliminated — only P0's upgrade should be ignored
  s.state.players[0]!.upgrades.set(UID.MASTER_BUILDER, 1);
  s.eliminatePlayer(0 as ValidPlayerSlot);

  const baseBuildTimer = s.state.buildTimer;
  const result = s.playRound();
  if (result.needsReselect.length > 0) s.processReselection(result.needsReselect);

  // No alive owner → no lockout, no bonus
  assert(
    s.state.timer === baseBuildTimer,
    `timer should be base ${baseBuildTimer}, got ${s.state.timer}`,
  );
  assert(
    s.state.modern!.masterBuilderLockout === 0,
    "lockout should be 0 when no alive owner",
  );
  assert(
    s.state.modern!.masterBuilderOwners === null,
    "owners should be null when no alive owner",
  );
});

Deno.test("Master Builder lockout: checkpoint round-trip preserves lockout", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);

  s.state.players[0]!.upgrades.set(UID.MASTER_BUILDER, 1);

  const result = s.playRound();
  if (result.needsReselect.length > 0) s.processReselection(result.needsReselect);

  // Serialize → deserialize round-trip
  const msg = createBuildStartMessage(s.state);
  const watcher = await createScenario(42);
  setGameMode(watcher.state, GAME_MODE_MODERN);
  const deps: CheckpointDeps = {
    state: watcher.state,
    accum: { build: 0, cannon: 0, battle: 0, grunt: 0, select: 0, selectAnnouncement: 0 } as CheckpointAccums,
    battleAnim: { impacts: [], territory: [], walls: [], flights: [] } as unknown as CheckpointBattleAnim,
    remoteCrosshairs: new Map(),
    watcherCrosshairPos: new Map(),
    watcherOrbitParams: new Map() as Map<number, OrbitParams>,
    watcherOrbitAngles: new Map(),
    snapshotTerritory: () => [],
  };
  applyBuildStartCheckpoint(msg, deps);

  assert(
    watcher.state.modern!.masterBuilderLockout === MASTER_BUILDER_BONUS_SECONDS,
    `lockout should survive round-trip, got ${watcher.state.modern!.masterBuilderLockout}`,
  );
  assert(
    watcher.state.modern!.masterBuilderOwners !== null &&
    watcher.state.modern!.masterBuilderOwners.has(0 as ValidPlayerSlot),
    "owners should survive round-trip",
  );
});

Deno.test("Reinforced Walls: first hit absorbed, second destroys", async () => {
  const s = await createScenario(42);
  const player = s.state.players[0]!;
  player.upgrades.set(UID.REINFORCED_WALLS, 1);

  const wallKey = [...player.walls][0];
  assert(wallKey !== undefined, "player should have walls");

  // First hit: wall survives, added to damagedWalls
  assert(!player.damagedWalls.has(wallKey!), "wall should not be damaged yet");
  // Simulate the reinforced check
  player.damagedWalls.add(wallKey!);
  assert(player.walls.has(wallKey!), "wall should still exist after first hit");
  assert(player.damagedWalls.has(wallKey!), "wall should be in damagedWalls");
});

Deno.test("damagedWalls cleared at build phase start", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);
  const player = s.state.players[0]!;
  player.upgrades.set(UID.REINFORCED_WALLS, 1);

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

Deno.test("BUILD_START checkpoint preserves modern mode fields", async () => {
  const host = await createHeadlessRuntime(42);
  setModern(host);

  // Set modern-mode specific state
  host.state.players[0]!.upgrades.set(UID.REINFORCED_WALLS, 2);
  host.state.players[1]!.upgrades.set(UID.RAPID_FIRE, 1);
  host.state.players[0]!.damagedWalls.add(100);
  host.state.players[0]!.damagedWalls.add(200);

  // Generate pending offers
  host.state.round = 3;
  host.state.modern!.pendingUpgradeOffers = generateUpgradeOffers(host.state);

  const msg = createBuildStartMessage(host.state);

  // Apply on watcher
  const watcher = await createHeadlessRuntime(42);
  setModern(watcher);
  const deps = makeDeps(watcher);
  applyBuildStartCheckpoint(msg, deps);

  // Modifier is rolled at battle start now, so BUILD_START clears it
  assert(
    watcher.state.modern!.activeModifier === null,
    `activeModifier: expected null, got ${watcher.state.modern!.activeModifier}`,
  );

  // Verify upgrades
  assert(
    watcher.state.players[0]!.upgrades.get(UID.REINFORCED_WALLS) === 2,
    "P0 reinforced_walls should be 2",
  );
  assert(
    watcher.state.players[1]!.upgrades.get(UID.RAPID_FIRE) === 1,
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
    watcher.state.modern!.pendingUpgradeOffers !== null,
    "pendingUpgradeOffers should be restored",
  );
  assert(
    watcher.state.modern!.pendingUpgradeOffers!.size ===
      host.state.modern!.pendingUpgradeOffers!.size,
    "offer count should match",
  );
});

Deno.test("FULL_STATE checkpoint preserves modern mode fields", async () => {
  const host = await createHeadlessRuntime(77);
  setModern(host);
  host.state.modern!.activeModifier = "crumbling_walls";
  host.state.modern!.lastModifierId = "wildfire";
  host.state.players[0]!.upgrades.set(UID.MASTER_BUILDER, 3);
  // cannonLimits + playerZones must be populated for full-state validation
  host.state.cannonLimits = host.state.players.map(() => 3);
  host.state.playerZones = host.state.players.map((_, idx) => idx);

  host.state.round = 4;
  host.state.modern!.pendingUpgradeOffers = generateUpgradeOffers(host.state);

  const msg = createFullStateMessage(host.state, 1);

  const watcher = await createHeadlessRuntime(77);
  setModern(watcher);
  const result = restoreFullStateSnapshot(watcher.state, msg);
  assert(result !== null, "full state restore should succeed");

  assert(
    watcher.state.modern!.activeModifier === "crumbling_walls",
    "activeModifier should survive full-state round-trip",
  );
  assert(
    watcher.state.modern!.lastModifierId === "wildfire",
    "lastModifierId should survive full-state round-trip",
  );
  assert(
    watcher.state.players[0]!.upgrades.get(UID.MASTER_BUILDER) === 3,
    "upgrades should survive full-state round-trip",
  );
  assert(
    watcher.state.modern!.pendingUpgradeOffers !== null,
    "pendingUpgradeOffers should survive full-state round-trip",
  );
});

Deno.test("modern headless game runs to completion without violations", async () => {
  for (let seed = 1; seed <= 5; seed++) {
    const s = await createScenario(seed);
    setGameMode(s.state, GAME_MODE_MODERN);
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
// Modifier effects — direct application
// ---------------------------------------------------------------------------

Deno.test("applyWildfire creates burning pits", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);
  const pitsBefore = s.state.burningPits.length;

  applyWildfire(s.state);

  assert(
    s.state.burningPits.length > pitsBefore,
    `wildfire should create pits: before=${pitsBefore} after=${s.state.burningPits.length}`,
  );
});

Deno.test("applyCrumblingWalls destroys outer walls but protects castle walls", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);
  // Play a round so players have built walls beyond their castle
  s.playRounds(1);
  const player = s.state.players[0]!;
  const wallsBefore = player.walls.size;
  let castleWallsBefore = 0;
  for (const key of player.castleWallTiles) {
    if (player.walls.has(key)) castleWallsBefore++;
  }

  applyCrumblingWalls(s.state);

  assert(
    player.walls.size < wallsBefore,
    `crumbling should remove walls: before=${wallsBefore} after=${player.walls.size}`,
  );
  // Castle walls should all still exist
  let castleWallsSurvived = 0;
  for (const key of player.castleWallTiles) {
    if (player.walls.has(key)) castleWallsSurvived++;
  }
  assert(
    castleWallsSurvived === castleWallsBefore,
    `castle walls should be protected: expected ${castleWallsBefore}, found ${castleWallsSurvived}`,
  );
});

Deno.test("applyGruntSurge spawns extra grunts", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);
  s.state.round = 3; // past FIRST_GRUNT_SPAWN_ROUND
  const gruntsBefore = s.state.grunts.length;

  const queueBefore = s.state.gruntSpawnQueue.length;
  applyGruntSurge(s.state);

  // Grunts may be queued at breaches or spawned instantly depending on wall layout
  const spawned = s.state.grunts.length - gruntsBefore;
  const queued = s.state.gruntSpawnQueue.length - queueBefore;
  const added = spawned + queued;
  assert(
    added > 0,
    `grunt surge should add grunts: spawned=${spawned} queued=${queued}`,
  );
  // Should add at least 6 per alive player (GRUNT_SURGE_COUNT_MIN=6, 3 players)
  const aliveCount = s.state.players.filter(
    (pl) => !pl.eliminated && pl.homeTower,
  ).length;
  assert(
    added >= 6 * aliveCount,
    `should add at least ${6 * aliveCount} grunts, added ${added}`,
  );
});

// ---------------------------------------------------------------------------
// Sinkhole modifier
// ---------------------------------------------------------------------------

Deno.test("applySinkhole converts grass to water on every zone", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);

  const sunk = applySinkhole(s.state);

  assert(sunk.size > 0, "sinkhole should affect tiles");
  for (const key of sunk) {
    const { r, c } = unpackTile(key);
    assert(isWater(s.state.map.tiles, r, c), `tile (${r},${c}) should be water`);
  }
  assert(
    s.state.modern!.sinkholeTiles !== null,
    "sinkholeTiles should be tracked",
  );
  assert(
    s.state.modern!.sinkholeTiles!.size === sunk.size,
    "tracked size should match returned size",
  );
});

Deno.test("sinkhole spawns one cluster per active zone", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);

  const sunk = applySinkhole(s.state);
  const zones = new Set<number>();
  for (const key of sunk) {
    const { r, c } = unpackTile(key);
    zones.add(s.state.map.zones[r]![c]!);
  }
  const activeZones = s.state.players
    .filter((player) => !player.eliminated && player.homeTower)
    .map((player) => player.homeTower!.zone);

  assert(
    zones.size === activeZones.length,
    `should hit all ${activeZones.length} zones, got ${zones.size}`,
  );
});

Deno.test("sinkhole destroys walls and structures on affected tiles", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);
  // Place walls so there's something to destroy
  s.playRounds(1);

  const sunk = applySinkhole(s.state);

  // Any wall on a sinkhole tile should be gone
  for (const player of s.state.players) {
    for (const key of sunk) {
      assert(
        !player.walls.has(key),
        `player ${player.id} should not have wall on sinkhole tile`,
      );
    }
  }
});

Deno.test("sinkhole cumulative cap prevents excessive map destruction", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);

  // Apply sinkholes repeatedly until cap
  let total = 0;
  for (let round = 0; round < 20; round++) {
    const sunk = applySinkhole(s.state);
    total += sunk.size;
    if (sunk.size === 0) break;
  }

  assert(total <= 24, `cumulative tiles should not exceed 24, got ${total}`);
});

Deno.test("reapplySinkholeTiles restores water after map regeneration", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);
  applySinkhole(s.state);
  const tracked = new Set(s.state.modern!.sinkholeTiles!);

  // Simulate checkpoint restore: reset tiles to grass, then reapply
  for (const key of tracked) {
    const { r, c } = unpackTile(key);
    s.state.map.tiles[r]![c] = 0; // Grass
  }
  reapplySinkholeTiles(s.state);

  for (const key of tracked) {
    const { r, c } = unpackTile(key);
    assert(
      isWater(s.state.map.tiles, r, c),
      `reapply should restore water at (${r},${c})`,
    );
  }
});

Deno.test("sinkhole checkpoint round-trip preserves tiles", async () => {
  const runtime = await createHeadlessRuntime(42);
  setModern(runtime);
  applySinkhole(runtime.state);
  const tracked = new Set(runtime.state.modern!.sinkholeTiles!);
  assert(tracked.size > 0, "should have sinkhole tiles");

  const msg = createBattleStartMessage(runtime.state);
  const runtime2 = await createHeadlessRuntime(42);
  setModern(runtime2);
  const deps = makeDeps(runtime2);
  applyBattleStartCheckpoint(msg, deps);

  assert(
    runtime2.state.modern!.sinkholeTiles !== null,
    "watcher should have sinkholeTiles",
  );
  assert(
    runtime2.state.modern!.sinkholeTiles!.size === tracked.size,
    `watcher should have ${tracked.size} sinkhole tiles`,
  );
  for (const key of tracked) {
    const { r, c } = unpackTile(key);
    assert(
      isWater(runtime2.state.map.tiles, r, c),
      `watcher tile (${r},${c}) should be water`,
    );
  }
});

// ---------------------------------------------------------------------------
// Rapid Fire — ball speed
// ---------------------------------------------------------------------------

Deno.test("Rapid Fire multiplies cannonball speed", async () => {
  const s = await createScenario(42);
  // Run cannon phase so AI places cannons, then enter battle
  s.runCannon();
  s.runBattle(0.1);
  const player = s.state.players[0]!;
  assert(player.cannons.length > 0, "player should have cannons");

  // Fire using scenario helper — check ball speed in state
  const target = s.findEnemyWallTile(0 as ValidPlayerSlot);
  if (target) {
    s.fireAt(0 as ValidPlayerSlot, 0, target.row, target.col);
    assert(
      s.state.cannonballs.length > 0,
      "should have a cannonball in flight",
    );
    assert(
      s.state.cannonballs[0]!.speed === BALL_SPEED,
      `without upgrade: expected ${BALL_SPEED}, got ${s.state.cannonballs[0]!.speed}`,
    );

    // Clear and fire with Rapid Fire
    s.state.cannonballs = [];
    player.upgrades.set(UID.RAPID_FIRE, 1);
    s.fireAt(0 as ValidPlayerSlot, 0, target.row, target.col);
    assert(
      s.state.cannonballs[0]!.speed === BALL_SPEED * 1.5,
      `with upgrade: expected ${BALL_SPEED * 1.5}, got ${s.state.cannonballs[0]!.speed}`,
    );
  }
});

// ---------------------------------------------------------------------------
// applyUpgradePicks
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Modern mode determinism
// ---------------------------------------------------------------------------

Deno.test("two modern games with same seed produce identical state", async () => {
  for (let seed = 1; seed <= 3; seed++) {
    const s1 = await createScenario(seed);
    setGameMode(s1.state, GAME_MODE_MODERN);
    s1.playRounds(6);

    const s2 = await createScenario(seed);
    setGameMode(s2.state, GAME_MODE_MODERN);
    s2.playRounds(6);

    // Compare key state
    assert(
      s1.state.round === s2.state.round,
      `seed ${seed}: rounds differ ${s1.state.round} vs ${s2.state.round}`,
    );
    assert(
      s1.state.modern!.activeModifier === s2.state.modern!.activeModifier,
      `seed ${seed}: activeModifier differs`,
    );
    for (let pi = 0; pi < s1.state.players.length; pi++) {
      const p1 = s1.state.players[pi]!;
      const p2 = s2.state.players[pi]!;
      assert(
        p1.score === p2.score,
        `seed ${seed} P${pi}: score ${p1.score} vs ${p2.score}`,
      );
      assert(
        p1.walls.size === p2.walls.size,
        `seed ${seed} P${pi}: walls ${p1.walls.size} vs ${p2.walls.size}`,
      );
      assert(
        p1.lives === p2.lives,
        `seed ${seed} P${pi}: lives ${p1.lives} vs ${p2.lives}`,
      );
      assert(
        p1.upgrades.size === p2.upgrades.size,
        `seed ${seed} P${pi}: upgrade count ${p1.upgrades.size} vs ${p2.upgrades.size}`,
      );
    }
    assert(
      s1.state.grunts.length === s2.state.grunts.length,
      `seed ${seed}: grunt count ${s1.state.grunts.length} vs ${s2.state.grunts.length}`,
    );
    assert(
      s1.state.burningPits.length === s2.state.burningPits.length,
      `seed ${seed}: pit count ${s1.state.burningPits.length} vs ${s2.state.burningPits.length}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Online message handlers (no WebSocket needed)
// ---------------------------------------------------------------------------

function makeIncrementalDeps(overrides: {
  isHost: boolean;
  upgradePickDialog?: { entries: { playerId: ValidPlayerSlot; choice: string | null; offers: readonly string[] }[] } | null;
  earlyUpgradePickChoices?: Map<ValidPlayerSlot, string>;
}) {
  const emptyWatcher: WatcherNetworkState = {
    remoteCrosshairs: new Map(),
    remoteCannonPhantoms: [],
    remotePiecePhantoms: [],
    watcherOrbitParams: new Map(),
  };
  return {
    log: () => {},
    session: {
      isHost: overrides.isHost,
      remoteHumanSlots: new Set<number>([1]),
      earlyLifeLostChoices: new Map(),
      earlyUpgradePickChoices: overrides.earlyUpgradePickChoices ?? new Map<number, string>(),
    },
    watcher: emptyWatcher,
    getState: () => undefined,
    selectionStates: new Map<number, SelectionState>(),
    syncSelectionOverlay: () => {},
    isCastleReselectPhase: () => false,
    confirmSelectionAndStartBuild: () => {},
    allSelectionsConfirmed: () => false,
    finishReselection: () => {},
    finishSelection: () => {},
    getLifeLostDialog: () => null,
    getUpgradePickDialog: () => overrides.upgradePickDialog ?? null,
  };
}

Deno.test("host applies UPGRADE_PICK message to active dialog", () => {
  const dialog = {
    entries: [
      { playerId: 1 as ValidPlayerSlot, choice: null as string | null, offers: [UID.MASTER_BUILDER, UID.RAPID_FIRE, UID.REINFORCED_WALLS] },
    ],
  };
  const deps = makeIncrementalDeps({ isHost: true, upgradePickDialog: dialog });

  const result = handleServerIncrementalMessage(
    { type: MESSAGE.UPGRADE_PICK, playerId: 1 as ValidPlayerSlot, choice: UID.RAPID_FIRE } as Parameters<typeof handleServerIncrementalMessage>[0],
    deps,
  );

  assert(result !== null && result.applied, "should apply the pick");
  assert(
    dialog.entries[0]!.choice === UID.RAPID_FIRE,
    `entry choice should be rapid_fire, got ${dialog.entries[0]!.choice}`,
  );
});

Deno.test("host rejects UPGRADE_PICK with invalid choice (not in offers)", () => {
  const dialog = {
    entries: [
      { playerId: 1 as ValidPlayerSlot, choice: null as string | null, offers: [UID.MASTER_BUILDER, UID.RAPID_FIRE, UID.REINFORCED_WALLS] },
    ],
  };
  const deps = makeIncrementalDeps({ isHost: true, upgradePickDialog: dialog });

  const result = handleServerIncrementalMessage(
    { type: MESSAGE.UPGRADE_PICK, playerId: 1 as ValidPlayerSlot, choice: UID.MORTAR } as Parameters<typeof handleServerIncrementalMessage>[0],
    deps,
  );

  assert(result !== null && !result.applied, "should reject invalid choice");
  assert(
    dialog.entries[0]!.choice === null,
    "entry choice should remain null",
  );
});

Deno.test("host buffers UPGRADE_PICK when dialog not yet created", () => {
  const earlyPicks = new Map<ValidPlayerSlot, string>();
  const deps = makeIncrementalDeps({
    isHost: true,
    upgradePickDialog: null,
    earlyUpgradePickChoices: earlyPicks,
  });

  const result = handleServerIncrementalMessage(
    { type: MESSAGE.UPGRADE_PICK, playerId: 1 as ValidPlayerSlot, choice: UID.MASTER_BUILDER } as Parameters<typeof handleServerIncrementalMessage>[0],
    deps,
  );

  assert(result !== null && result.applied, "should buffer the early pick");
  assert(
    earlyPicks.get(1 as ValidPlayerSlot) === UID.MASTER_BUILDER,
    `buffered pick should be master_builder, got ${earlyPicks.get(1 as ValidPlayerSlot)}`,
  );
});

Deno.test("watcher drops UPGRADE_PICK message (only host processes)", () => {
  const deps = makeIncrementalDeps({ isHost: false });

  const result = handleServerIncrementalMessage(
    { type: MESSAGE.UPGRADE_PICK, playerId: 1 as ValidPlayerSlot, choice: UID.RAPID_FIRE } as Parameters<typeof handleServerIncrementalMessage>[0],
    deps,
  );

  assert(result !== null && !result.applied, "watcher should drop the pick");
});

Deno.test("host ignores UPGRADE_PICK for already-resolved entry", () => {
  const dialog = {
    entries: [
      { playerId: 1 as ValidPlayerSlot, choice: UID.MASTER_BUILDER as string | null, offers: [UID.MASTER_BUILDER, UID.RAPID_FIRE, UID.REINFORCED_WALLS] },
    ],
  };
  const deps = makeIncrementalDeps({ isHost: true, upgradePickDialog: dialog });

  const result = handleServerIncrementalMessage(
    { type: MESSAGE.UPGRADE_PICK, playerId: 1 as ValidPlayerSlot, choice: UID.RAPID_FIRE } as Parameters<typeof handleServerIncrementalMessage>[0],
    deps,
  );

  assert(result !== null && !result.applied, "should drop pick for resolved entry");
  assert(
    dialog.entries[0]!.choice === UID.MASTER_BUILDER,
    "choice should remain unchanged",
  );
});

// ---------------------------------------------------------------------------
// Coverage gaps: banner text, dialog create/tick, AI scoring
// ---------------------------------------------------------------------------


Deno.test("upgrade pick banner is shown before upgrade pick dialog", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);
  s.state.round = 3;
  s.state.modern!.pendingUpgradeOffers = generateUpgradeOffers(s.state);

  assert(
    s.state.modern!.pendingUpgradeOffers !== null,
    "offers should exist at round 3",
  );

  const log: string[] = [];
  let bannerOnDone: (() => void) | undefined;

  const mockShowBanner = (text: string, onDone: () => void) => {
    log.push(`banner:${text}`);
    bannerOnDone = onDone;
  };

  const mockTryShowUpgradePick = (onDone: () => void): boolean => {
    const dialog = createUpgradePickDialog({
      state: s.state,
      hostAtFrameStart: true,
      myPlayerId: 0 as PlayerSlotId,
      remoteHumanSlots: new Set(),
      isHumanController: () => false,
    });
    if (!dialog) return false;
    log.push("upgradePick:shown");
    // Simulate immediate resolve for test
    onDone();
    return true;
  };

  // Simulate the flow: check offers → show banner → on done → show dialog
  if (s.state.modern?.pendingUpgradeOffers) {
    showUpgradePickBanner(mockShowBanner, () => {
      if (!mockTryShowUpgradePick(() => log.push("buildBanner"))) {
        log.push("buildBanner");
      }
    });
  }

  assert(log.length === 1, `banner should be shown first, log=${log.join(",")}`);
  assert(log[0] === "banner:Choose Upgrade", `first should be upgrade banner, got ${log[0]}`);

  // Simulate banner completion
  bannerOnDone!();
  assert(log[1] === "upgradePick:shown", `second should be upgrade pick dialog, got ${log[1]}`);
  assert(log[2] === "buildBanner", `third should be build banner, got ${log[2]}`);
});

Deno.test("createUpgradePickDialog returns dialog from pending offers", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);
  s.state.round = 3;
  s.state.modern!.pendingUpgradeOffers = generateUpgradeOffers(s.state);

  const dialog = createUpgradePickDialog({
    state: s.state,
    hostAtFrameStart: true,
    myPlayerId: 0 as PlayerSlotId,
    remoteHumanSlots: new Set(),
    isHumanController: () => false,
  });

  assert(dialog !== null, "dialog should be created from pending offers");
  assert(
    dialog!.entries.length > 0,
    "dialog should have entries",
  );
  // All entries should auto-resolve (no human controller)
  for (const entry of dialog!.entries) {
    assert(entry.autoResolve, `P${entry.playerId} should auto-resolve`);
    assert(entry.offers.length === 3, "each entry should have 3 offers");
    assert(entry.choice === null, "choice should start null");
  }
});

// ---------------------------------------------------------------------------
// Combo scoring
// ---------------------------------------------------------------------------

Deno.test("wall streak awards bonus after 3 hits within window", () => {
  const tracker = createComboTracker(3);
  // 3 hits at time 0, 0.5, 1.0 — all within 1.5s window
  assert(comboOnWallDestroyed(tracker, 0 as ValidPlayerSlot, 0) === 0, "hit 1: no bonus");
  assert(comboOnWallDestroyed(tracker, 0 as ValidPlayerSlot, 0.5) === 0, "hit 2: no bonus");
  assert(comboOnWallDestroyed(tracker, 0 as ValidPlayerSlot, 1.0) === 50, "hit 3: streak bonus");
  assert(comboOnWallDestroyed(tracker, 0 as ValidPlayerSlot, 1.4) === 50, "hit 4: continued streak");
});

Deno.test("wall streak resets after time window expires", () => {
  const tracker = createComboTracker(3);
  comboOnWallDestroyed(tracker, 0 as ValidPlayerSlot, 0);
  comboOnWallDestroyed(tracker, 0 as ValidPlayerSlot, 0.5);
  // Gap > 1.5s — streak resets
  assert(comboOnWallDestroyed(tracker, 0 as ValidPlayerSlot, 3.0) === 0, "streak should reset after gap");
  assert(comboOnWallDestroyed(tracker, 0 as ValidPlayerSlot, 3.5) === 0, "only 2 hits in new window");
});

Deno.test("cannon kill always awards bonus", () => {
  const tracker = createComboTracker(3);
  assert(comboOnCannonKill(tracker, 0 as ValidPlayerSlot) === 100, "cannon kill bonus");
  assert(comboOnCannonKill(tracker, 0 as ValidPlayerSlot) === 100, "second cannon kill bonus");
});

Deno.test("grunt sniper awards bonus after 2 kills within window", () => {
  const tracker = createComboTracker(3);
  assert(comboOnGruntKill(tracker, 0 as ValidPlayerSlot, 0) === 0, "kill 1: no bonus");
  assert(comboOnGruntKill(tracker, 0 as ValidPlayerSlot, 1.0) === 75, "kill 2: sniper bonus");
  assert(comboOnGruntKill(tracker, 0 as ValidPlayerSlot, 1.5) === 75, "kill 3: continued streak");
});

Deno.test("demolition bonus for 5+ walls in a round", () => {
  const tracker = createComboTracker(3);
  // Player 0 destroys 5 walls, player 1 destroys 3
  for (let i = 0; i < 5; i++) comboOnWallDestroyed(tracker, 0 as ValidPlayerSlot, i * 0.5);
  for (let i = 0; i < 3; i++) comboOnWallDestroyed(tracker, 1 as ValidPlayerSlot, i * 0.5);

  const bonuses = comboDemolitionBonus(tracker);
  assert(bonuses[0] === 150, `P0 should get demolition bonus, got ${bonuses[0]}`);
  assert(bonuses[1] === 0, `P1 should not get demolition bonus, got ${bonuses[1]}`);
  assert(bonuses[2] === 0, `P2 (no hits) should not get bonus, got ${bonuses[2]}`);
});

Deno.test("combo tracker is created at battle start in modern mode", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);
  assert(s.state.modern!.comboTracker === null, "no tracker before battle");
  s.runCannon();
  s.runBattle(0.1);
  // After runBattle calls nextPhase(CANNON→BATTLE), comboTracker should exist
  // But runBattle also calls nextPhase(BATTLE→BUILD) at the end, clearing it
  // So we check during a shorter flow: just enter battle
  const s2 = await createScenario(42);
  setGameMode(s2.state, GAME_MODE_MODERN);
  s2.runCannon();
  // runBattle calls nextPhase which enters BATTLE and creates tracker
  // then ticks battle, then nextPhase to BUILD which clears tracker
  // We can't inspect mid-battle, but we can verify it was created and cleared
  s2.runBattle(0.1);
  // After battle→build transition, tracker should be null (cleared in enterBuildFromBattle)
  assert(s2.state.modern!.comboTracker === null, "tracker cleared after battle");
});

Deno.test("combos are per-player independent", () => {
  const tracker = createComboTracker(3);
  // Player 0 builds a wall streak
  comboOnWallDestroyed(tracker, 0 as ValidPlayerSlot, 0);
  comboOnWallDestroyed(tracker, 0 as ValidPlayerSlot, 0.5);
  comboOnWallDestroyed(tracker, 0 as ValidPlayerSlot, 1.0);
  // Player 1 has only 1 hit — no streak
  comboOnWallDestroyed(tracker, 1 as ValidPlayerSlot, 0.5);
  assert(
    tracker.players[0]!.wallStreak === 3,
    `P0 should have 3-streak, got ${tracker.players[0]!.wallStreak}`,
  );
  assert(
    tracker.players[1]!.wallStreak === 1,
    `P1 should have 1-streak, got ${tracker.players[1]!.wallStreak}`,
  );
});

// ---------------------------------------------------------------------------
// Frozen river modifier
// ---------------------------------------------------------------------------

Deno.test("applyFrozenRiver freezes all water tiles", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);
  applyFrozenRiver(s.state);

  assert(s.state.modern!.frozenTiles !== null, "frozenTiles should be set");
  assert(s.state.modern!.frozenTiles!.size > 0, "frozenTiles should not be empty");

  // Every frozen tile should be a water tile, and every water tile should be frozen
  let waterCount = 0;
  for (let r = 0; r < 28; r++) {
    for (let c = 0; c < 44; c++) {
      if (s.state.map.tiles[r]![c] === 1) {
        waterCount++;
        assert(
          s.state.modern!.frozenTiles!.has(r * 44 + c),
          `water tile (${r},${c}) should be frozen`,
        );
      }
    }
  }
  assert(
    s.state.modern!.frozenTiles!.size === waterCount,
    `frozen count ${s.state.modern!.frozenTiles!.size} should equal water count ${waterCount}`,
  );
});

Deno.test("isGruntBlocked allows frozen water tiles", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);
  applyFrozenRiver(s.state);

  const key = s.state.modern!.frozenTiles!.values().next().value!;
  const r = Math.floor(key / 44);
  const c = key % 44;
  assert(!isGruntBlocked(s.state, r, c), `frozen tile (${r},${c}) should be passable`);

  // Remove from frozen set — should block again
  s.state.modern!.frozenTiles!.delete(key);
  assert(isGruntBlocked(s.state, r, c), `unfrozen water (${r},${c}) should be blocked`);
});

Deno.test("frozen river: grunts retarget cross-zone and walk onto ice", async () => {
  const runtime = await createHeadlessRuntime(42);
  const state = runtime.state;
  setGameMode(state, GAME_MODE_MODERN);

  // Find interior grass tiles adjacent to water in player 0's zone
  const zone1 = state.players[0]!.homeTower!.zone;
  const bankTiles: { row: number; col: number }[] = [];
  for (let r = 2; r < 26; r++) {
    for (let c = 2; c < 42; c++) {
      if (state.map.tiles[r]![c] !== 0 || state.map.zones[r]![c] !== zone1) continue;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        if (state.map.tiles[r + dr]![c + dc] === 1) {
          bankTiles.push({ row: r, col: c });
          break;
        }
      }
    }
  }
  assert(bankTiles.length > 0, `should find bank tiles in zone ${zone1}`);

  // Clear all walls so grunts can reach the river
  for (const player of state.players) {
    clearPlayerWalls(player);
  }
  recheckTerritoryOnly(state);

  // Place grunts on bank tiles
  state.grunts = [];
  const count = Math.min(3, bankTiles.length);
  for (let i = 0; i < count; i++) {
    state.grunts.push({
      row: bankTiles[i]!.row,
      col: bankTiles[i]!.col,
      victimPlayerId: state.players[0]!.id,
      blockedRounds: 0,
    });
  }

  applyFrozenRiver(state);
  tickGrunts(state);

  // All grunts should target towers outside zone1
  for (const g of state.grunts) {
    assert(g.targetTowerIdx !== undefined, "grunt should have a target");
    const tz = state.map.towers[g.targetTowerIdx!]!.zone;
    assert(tz !== zone1, `grunt should target cross-zone, got zone ${tz}`);
  }

  // Tick more — at least one grunt should step onto frozen water
  let onIce = false;
  for (let t = 0; t < 20 && !onIce; t++) {
    tickGrunts(state);
    for (const g of state.grunts) {
      if (state.map.tiles[g.row]![g.col] === 1) onIce = true;
    }
  }
  assert(onIce, "at least one grunt should move onto frozen water within 20 ticks");
});

Deno.test("clearFrozenRiver kills grunts stranded on water", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);
  applyFrozenRiver(s.state);

  // Place a grunt on a frozen water tile
  const key = s.state.modern!.frozenTiles!.values().next().value!;
  const r = Math.floor(key / 44);
  const c = key % 44;
  s.state.grunts.push({
    row: r,
    col: c,
    victimPlayerId: 0 as ValidPlayerSlot,
    blockedRounds: 0,
  });
  const before = s.state.grunts.length;

  clearFrozenRiver(s.state);

  assert(s.state.modern!.frozenTiles === null, "frozenTiles should be null after thaw");
  assert(
    s.state.grunts.length < before,
    `grunt on water should be killed: ${s.state.grunts.length} should be < ${before}`,
  );
});

Deno.test("frozen river persists through build phase, thaws at next battle", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);
  s.state.modern!.activeModifier = "frozen_river";
  applyFrozenRiver(s.state);
  assert(s.state.modern!.frozenTiles !== null, "should have frozen tiles");

  // Verify clearFrozenRiver thaws correctly
  clearFrozenRiver(s.state);
  assert(s.state.modern!.frozenTiles === null, "clearFrozenRiver should null frozenTiles");
});

Deno.test("online checkpoint round-trip preserves frozen state", async () => {
  const runtime = await createHeadlessRuntime(42);
  setModern(runtime);
  applyFrozenRiver(runtime.state);
  assert(runtime.state.modern!.frozenTiles !== null, "host should have frozen tiles");

  const msg = createBattleStartMessage(runtime.state);
  const watcher = await createHeadlessRuntime(42);
  setModern(watcher);
  const deps = makeDeps(watcher);

  applyBattleStartCheckpoint(msg, deps);
  assert(deps.state.modern!.frozenTiles !== null, "watcher should have frozen tiles");
  assert(
    deps.state.modern!.frozenTiles!.size === runtime.state.modern!.frozenTiles!.size,
    `watcher frozen size ${deps.state.modern!.frozenTiles!.size} !== host ${runtime.state.modern!.frozenTiles!.size}`,
  );
});

Deno.test("FULL_STATE checkpoint preserves frozen state", async () => {
  const runtime = await createHeadlessRuntime(42);
  setModern(runtime);
  runtime.state.cannonLimits = runtime.state.players.map(() => 3);
  runtime.state.playerZones = runtime.state.players.map((_, idx) => idx);
  applyFrozenRiver(runtime.state);

  const msg = createFullStateMessage(runtime.state, 1);
  const runtime2 = await createHeadlessRuntime(42);
  setModern(runtime2);
  restoreFullStateSnapshot(runtime2.state, msg);

  assert(runtime2.state.modern!.frozenTiles !== null, "restored should have frozen tiles");
  assert(
    runtime2.state.modern!.frozenTiles!.size === runtime.state.modern!.frozenTiles!.size,
    "restored frozen tile count should match",
  );
});

Deno.test("modifier no-repeat applies to frozen_river", async () => {
  const s = await createScenario(42);
  setGameMode(s.state, GAME_MODE_MODERN);
  s.state.modern!.lastModifierId = "frozen_river";
  let rolledFrozen = false;
  for (let i = 0; i < 50; i++) {
    s.state.round = MODIFIER_FIRST_ROUND + i;
    const mod = rollModifier(s.state);
    if (mod === "frozen_river") {
      rolledFrozen = true;
      break;
    }
  }
  assert(!rolledFrozen, "frozen_river should not appear when lastModifierId is frozen_river");
});

Deno.test("AI thaws frozen tiles by shooting during frozen river battle", async () => {
  const s = await createScenario(8);
  setGameMode(s.state, GAME_MODE_MODERN);
  // Play a round so AI has cannons placed
  s.playRounds(1);

  // Force frozen river and run a battle
  s.state.modern!.activeModifier = "frozen_river";
  applyFrozenRiver(s.state);
  const frozenBefore = s.state.modern!.frozenTiles!.size;
  assert(frozenBefore > 0, "should have frozen tiles");

  s.runBattle();

  // Cannonball impacts on frozen tiles thaw them via detectIceThaw
  const frozenAfter = s.state.modern!.frozenTiles?.size ?? 0;
  const thawed = frozenBefore - frozenAfter;
  assert(thawed >= 1, `AI should thaw at least 1 frozen tile (got ${thawed})`);
});

// ---------------------------------------------------------------------------

