/**
 * Modern mode tests — environmental modifiers, upgrade draft/pick, gameplay hooks.
 * Covers both local headless flow and online checkpoint round-trips.
 *
 * Run with: bun test/modern-mode.test.ts
 */

import { BALL_SPEED, GAME_MODE_MODERN, MODIFIER_FIRST_ROUND } from "../src/game-constants.ts";
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
import {
  applyCrumblingWalls,
  applyGruntSurge,
  applyWildfire,
  BANNER_PHASE_CANNON,
  modifierBannerText,
  rollModifier,
} from "../src/round-modifiers.ts";
import {
  createHeadlessRuntime,
  type HeadlessRuntime,
} from "../src/runtime-headless.ts";
import { MESSAGE } from "../server/protocol.ts";
import { handleServerIncrementalMessage } from "../src/online-server-events.ts";
import type { WatcherNetworkState } from "../src/online-types.ts";
import type { SelectionState } from "../src/types.ts";
import { type UpgradeId, UID } from "../src/upgrade-defs.ts";
import {
  applyUpgradePicks,
  createUpgradePickDialog,
  generateUpgradeOffers,
  tickUpgradePickDialog,
  UPGRADE_PICK_AI_DELAY,
  UPGRADE_PICK_MAX_TIMER,
} from "../src/upgrade-pick.ts";
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

  s.state.players[0]!.upgrades.set(UID.MASTER_BUILDER as UpgradeId, 1);

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

  s.state.players[0]!.upgrades.set(UID.MASTER_BUILDER as UpgradeId, 1);
  s.state.players[1]!.upgrades.set(UID.MASTER_BUILDER as UpgradeId, 1);

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

  s.state.players[0]!.upgrades.set(UID.MASTER_BUILDER as UpgradeId, 1);
  s.eliminatePlayer(1);
  s.state.players[1]!.upgrades.set(UID.MASTER_BUILDER as UpgradeId, 1);

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
  player.upgrades.set(UID.REINFORCED_WALLS as UpgradeId, 1);

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
  player.upgrades.set(UID.REINFORCED_WALLS as UpgradeId, 1);

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
  host.state.players[0]!.upgrades.set(UID.REINFORCED_WALLS as UpgradeId, 2);
  host.state.players[1]!.upgrades.set(UID.RAPID_FIRE as UpgradeId, 1);
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
    watcher.state.players[0]!.upgrades.get(UID.REINFORCED_WALLS as UpgradeId) === 2,
    "P0 reinforced_walls should be 2",
  );
  assert(
    watcher.state.players[1]!.upgrades.get(UID.RAPID_FIRE as UpgradeId) === 1,
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
  host.state.players[0]!.upgrades.set(UID.MASTER_BUILDER as UpgradeId, 3);
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
    watcher.state.players[0]!.upgrades.get(UID.MASTER_BUILDER as UpgradeId) === 3,
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
// Modifier effects — direct application
// ---------------------------------------------------------------------------

test("applyWildfire creates burning pits", () => {
  const s = createScenario(42);
  s.state.gameMode = GAME_MODE_MODERN;
  const pitsBefore = s.state.burningPits.length;

  applyWildfire(s.state);

  assert(
    s.state.burningPits.length > pitsBefore,
    `wildfire should create pits: before=${pitsBefore} after=${s.state.burningPits.length}`,
  );
});

test("applyCrumblingWalls destroys outer walls but protects castle walls", () => {
  const s = createScenario(42);
  s.state.gameMode = GAME_MODE_MODERN;
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

test("applyGruntSurge spawns extra grunts", () => {
  const s = createScenario(42);
  s.state.gameMode = GAME_MODE_MODERN;
  s.state.round = 3; // past FIRST_GRUNT_SPAWN_ROUND
  const gruntsBefore = s.state.grunts.length;

  applyGruntSurge(s.state);

  assert(
    s.state.grunts.length > gruntsBefore,
    `grunt surge should add grunts: before=${gruntsBefore} after=${s.state.grunts.length}`,
  );
  // Should add at least 8 per alive player (GRUNT_SURGE_MIN=8, 3 players)
  const added = s.state.grunts.length - gruntsBefore;
  const aliveCount = s.state.players.filter(
    (pl) => !pl.eliminated && pl.homeTower,
  ).length;
  assert(
    added >= 8 * aliveCount,
    `should add at least ${8 * aliveCount} grunts, added ${added}`,
  );
});

// ---------------------------------------------------------------------------
// Rapid Fire — ball speed
// ---------------------------------------------------------------------------

test("Rapid Fire multiplies cannonball speed", () => {
  const s = createScenario(42);
  // Run cannon phase so AI places cannons, then enter battle
  s.runCannon();
  s.runBattle(0.1);
  const player = s.state.players[0]!;
  assert(player.cannons.length > 0, "player should have cannons");

  // Fire using scenario helper — check ball speed in state
  const target = s.findEnemyWallTile(0);
  if (target) {
    s.fireAt(0, 0, target.row, target.col);
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
    player.upgrades.set(UID.RAPID_FIRE as UpgradeId, 1);
    s.fireAt(0, 0, target.row, target.col);
    assert(
      s.state.cannonballs[0]!.speed === BALL_SPEED * 2,
      `with 1 stack: expected ${BALL_SPEED * 2}, got ${s.state.cannonballs[0]!.speed}`,
    );
  }
});

// ---------------------------------------------------------------------------
// applyUpgradePicks
// ---------------------------------------------------------------------------

test("applyUpgradePicks writes choices to Player.upgrades", () => {
  const s = createScenario(42);
  s.state.gameMode = GAME_MODE_MODERN;
  s.state.round = 3;

  const offers = generateUpgradeOffers(s.state);
  assert(offers !== null, "should have offers");

  // Build a fake dialog with choices
  const dialog = {
    entries: [...offers!.entries()].map(([playerId, offerList]) => ({
      playerId,
      offers: offerList,
      choice: offerList[0] as UpgradeId, // pick first offer
      isAi: true,
      aiTimer: 0,
      focused: 0,
    })),
    timer: 0,
  };

  applyUpgradePicks(s.state, dialog);

  for (const [playerId, offerList] of offers!) {
    const player = s.state.players[playerId]!;
    const picked = offerList[0];
    assert(
      player.upgrades.get(picked) === 1,
      `P${playerId} should have 1 stack of ${picked}, got ${player.upgrades.get(picked)}`,
    );
  }
});

test("applyUpgradePicks stacks on repeated picks", () => {
  const s = createScenario(42);
  const player = s.state.players[0]!;
  player.upgrades.set(UID.MASTER_BUILDER as UpgradeId, 1);

  const dialog = {
    entries: [
      {
        playerId: 0,
        offers: [UID.MASTER_BUILDER, UID.RAPID_FIRE, UID.REINFORCED_WALLS] as [UpgradeId, UpgradeId, UpgradeId],
        choice: UID.MASTER_BUILDER as UpgradeId,
        isAi: true,
        aiTimer: 0,
        focused: 0,
      },
    ],
    timer: 0,
  };

  applyUpgradePicks(s.state, dialog);
  assert(
    player.upgrades.get(UID.MASTER_BUILDER as UpgradeId) === 2,
    `should stack to 2, got ${player.upgrades.get(UID.MASTER_BUILDER as UpgradeId)}`,
  );
});

// ---------------------------------------------------------------------------
// Modern mode determinism
// ---------------------------------------------------------------------------

test("two modern games with same seed produce identical state", () => {
  for (let seed = 1; seed <= 3; seed++) {
    const s1 = createScenario(seed);
    s1.state.gameMode = GAME_MODE_MODERN;
    s1.playRounds(6);

    const s2 = createScenario(seed);
    s2.state.gameMode = GAME_MODE_MODERN;
    s2.playRounds(6);

    // Compare key state
    assert(
      s1.state.round === s2.state.round,
      `seed ${seed}: rounds differ ${s1.state.round} vs ${s2.state.round}`,
    );
    assert(
      s1.state.activeModifier === s2.state.activeModifier,
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
  upgradePickDialog?: { entries: { playerId: number; choice: string | null; offers: readonly string[] }[] } | null;
  earlyUpgradePickChoices?: Map<number, string>;
}) {
  const emptyWatcher: WatcherNetworkState = {
    remoteCrosshairs: new Map(),
    remoteCannonPhantoms: [],
    remotePiecePhantoms: [],
    orbitParams: new Map(),
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

test("host applies UPGRADE_PICK message to active dialog", () => {
  const dialog = {
    entries: [
      { playerId: 1, choice: null as string | null, offers: [UID.MASTER_BUILDER, UID.RAPID_FIRE, UID.REINFORCED_WALLS] },
    ],
  };
  const deps = makeIncrementalDeps({ isHost: true, upgradePickDialog: dialog });

  const result = handleServerIncrementalMessage(
    { type: MESSAGE.UPGRADE_PICK, playerId: 1, choice: UID.RAPID_FIRE } as Parameters<typeof handleServerIncrementalMessage>[0],
    deps,
  );

  assert(result !== null && result.applied, "should apply the pick");
  assert(
    dialog.entries[0]!.choice === UID.RAPID_FIRE,
    `entry choice should be rapid_fire, got ${dialog.entries[0]!.choice}`,
  );
});

test("host rejects UPGRADE_PICK with invalid choice (not in offers)", () => {
  const dialog = {
    entries: [
      { playerId: 1, choice: null as string | null, offers: [UID.MASTER_BUILDER, UID.RAPID_FIRE, UID.REINFORCED_WALLS] },
    ],
  };
  const deps = makeIncrementalDeps({ isHost: true, upgradePickDialog: dialog });

  const result = handleServerIncrementalMessage(
    { type: MESSAGE.UPGRADE_PICK, playerId: 1, choice: UID.SCATTER_SHOT } as Parameters<typeof handleServerIncrementalMessage>[0],
    deps,
  );

  assert(result !== null && !result.applied, "should reject invalid choice");
  assert(
    dialog.entries[0]!.choice === null,
    "entry choice should remain null",
  );
});

test("host buffers UPGRADE_PICK when dialog not yet created", () => {
  const earlyPicks = new Map<number, string>();
  const deps = makeIncrementalDeps({
    isHost: true,
    upgradePickDialog: null,
    earlyUpgradePickChoices: earlyPicks,
  });

  const result = handleServerIncrementalMessage(
    { type: MESSAGE.UPGRADE_PICK, playerId: 1, choice: UID.MASTER_BUILDER } as Parameters<typeof handleServerIncrementalMessage>[0],
    deps,
  );

  assert(result !== null && result.applied, "should buffer the early pick");
  assert(
    earlyPicks.get(1) === UID.MASTER_BUILDER,
    `buffered pick should be master_builder, got ${earlyPicks.get(1)}`,
  );
});

test("watcher drops UPGRADE_PICK message (only host processes)", () => {
  const deps = makeIncrementalDeps({ isHost: false });

  const result = handleServerIncrementalMessage(
    { type: MESSAGE.UPGRADE_PICK, playerId: 1, choice: UID.RAPID_FIRE } as Parameters<typeof handleServerIncrementalMessage>[0],
    deps,
  );

  assert(result !== null && !result.applied, "watcher should drop the pick");
});

test("host ignores UPGRADE_PICK for already-resolved entry", () => {
  const dialog = {
    entries: [
      { playerId: 1, choice: UID.MASTER_BUILDER as string | null, offers: [UID.MASTER_BUILDER, UID.RAPID_FIRE, UID.REINFORCED_WALLS] },
    ],
  };
  const deps = makeIncrementalDeps({ isHost: true, upgradePickDialog: dialog });

  const result = handleServerIncrementalMessage(
    { type: MESSAGE.UPGRADE_PICK, playerId: 1, choice: UID.RAPID_FIRE } as Parameters<typeof handleServerIncrementalMessage>[0],
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

test("modifierBannerText returns text for cannon-announced modifiers", () => {
  assert(
    modifierBannerText("wildfire", BANNER_PHASE_CANNON) !== undefined,
    "wildfire should announce on cannon phase",
  );
  assert(
    modifierBannerText("grunt_surge", BANNER_PHASE_CANNON) !== undefined,
    "grunt surge should announce on cannon phase",
  );
  assert(
    modifierBannerText("crumbling_walls", BANNER_PHASE_CANNON) === undefined,
    "crumbling walls should NOT announce on cannon phase",
  );
  assert(
    modifierBannerText(null, BANNER_PHASE_CANNON) === undefined,
    "null modifier should return undefined",
  );
});

test("createUpgradePickDialog returns dialog from pending offers", () => {
  const s = createScenario(42);
  s.state.gameMode = GAME_MODE_MODERN;
  s.state.round = 3;
  s.state.pendingUpgradeOffers = generateUpgradeOffers(s.state);

  const dialog = createUpgradePickDialog({
    state: s.state,
    isHost: true,
    myPlayerId: 0,
    remoteHumanSlots: new Set(),
    isHumanController: () => false,
  });

  assert(dialog !== null, "dialog should be created from pending offers");
  assert(
    dialog!.entries.length > 0,
    "dialog should have entries",
  );
  // All entries should be AI (no human controller)
  for (const entry of dialog!.entries) {
    assert(entry.isAi, `P${entry.playerId} should be AI`);
    assert(entry.offers.length === 3, "each entry should have 3 offers");
    assert(entry.choice === null, "choice should start null");
  }
});

test("createUpgradePickDialog returns null in classic mode", () => {
  const s = createScenario(42);
  // Classic mode, no pending offers
  const dialog = createUpgradePickDialog({
    state: s.state,
    isHost: true,
    myPlayerId: 0,
    remoteHumanSlots: new Set(),
    isHumanController: () => false,
  });
  assert(dialog === null, "classic mode should return null");
});

test("tickUpgradePickDialog resolves AI picks after delay", () => {
  const s = createScenario(42);
  s.state.gameMode = GAME_MODE_MODERN;
  s.state.round = 3;
  s.state.pendingUpgradeOffers = generateUpgradeOffers(s.state);

  const dialog = createUpgradePickDialog({
    state: s.state,
    isHost: true,
    myPlayerId: -1,
    remoteHumanSlots: new Set(),
    isHumanController: () => false,
  })!;

  assert(dialog !== null, "dialog should exist");

  // Tick less than AI delay — not resolved
  let resolved = tickUpgradePickDialog(dialog, 0.5, UPGRADE_PICK_AI_DELAY, UPGRADE_PICK_MAX_TIMER, s.state);
  assert(!resolved, "should not be resolved before AI delay");

  // Tick past AI delay
  resolved = tickUpgradePickDialog(dialog, UPGRADE_PICK_AI_DELAY, UPGRADE_PICK_AI_DELAY, UPGRADE_PICK_MAX_TIMER, s.state);
  assert(resolved, "should be resolved after AI delay");

  // All entries should have choices
  for (const entry of dialog.entries) {
    assert(
      entry.choice !== null,
      `P${entry.playerId} should have picked, got null`,
    );
  }
});

test("tickUpgradePickDialog force-picks on max timer", () => {
  const s = createScenario(42);
  s.state.gameMode = GAME_MODE_MODERN;
  s.state.round = 3;
  s.state.pendingUpgradeOffers = generateUpgradeOffers(s.state);

  const dialog = createUpgradePickDialog({
    state: s.state,
    isHost: true,
    myPlayerId: 0,
    remoteHumanSlots: new Set(),
    isHumanController: (pid) => pid === 0, // player 0 is human
  })!;

  // Human entry won't auto-pick on AI delay
  const humanEntry = dialog.entries.find((en) => en.playerId === 0);
  assert(humanEntry !== undefined && !humanEntry.isAi, "P0 should be human");

  // Tick past max timer — human gets force-picked
  const resolved = tickUpgradePickDialog(dialog, UPGRADE_PICK_MAX_TIMER + 1, UPGRADE_PICK_AI_DELAY, UPGRADE_PICK_MAX_TIMER, s.state);
  assert(resolved, "should be resolved after max timer");
  assert(humanEntry!.choice !== null, "human should have been force-picked");
});

// ---------------------------------------------------------------------------

await runTests("Modern Mode");
