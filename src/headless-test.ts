/**
 * Headless game simulation for automated bug detection.
 * Run with: bun src/headless-test.ts
 */
import { GRID_COLS, GRID_ROWS } from "./grid.ts";
import {
  nextPhase,
  resetCannonFacings,
  finalizeBuildPhase,
  computeCannonLimitsForPhase,
} from "./game-engine.ts";
import { BUILD_TIMER, BATTLE_TIMER } from "./types.ts";
import type { GameState } from "./types.ts";
import { updateCannonballs, resolveBalloons } from "./battle-system.ts";
import { tickGrunts, gruntAttackTowers } from "./grunt-system.ts";
import { isGrass, forEachTowerTile, packTile, unpackTile } from "./spatial.ts";
import {
  collectAllCannonTiles,
  collectAllInterior,
  collectAllWalls,
} from "./board-occupancy.ts";
import {
  createHeadlessRuntime,
  processHeadlessReselection,
} from "./headless-sim.ts";

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

interface Violation {
  game: number;
  round: number;
  phase: string;
  tick: number;
  message: string;
}

function validateGameState(
  state: GameState,
  gameNum: number,
  tick: number,
  violations: Violation[],
): void {
  const ctx = { game: gameNum, round: state.round, phase: state.phase, tick };

  function fail(msg: string) {
    violations.push({ ...ctx, message: msg });
  }

  // Build sets for fast lookup
  const allWalls = collectAllWalls(state);
  const allInterior = collectAllInterior(state);
  const allCannonTiles = collectAllCannonTiles(state);

  const towerTiles = new Set<number>();
  for (const t of state.map.towers) {
    forEachTowerTile(t, (_r, _c, key) => towerTiles.add(key));
  }

  // Check grunts
  const gruntPositions = new Set<number>();
  for (const grunt of state.grunts) {
    const key = packTile(grunt.row, grunt.col);

    // No two grunts on same tile
    if (gruntPositions.has(key)) {
      fail(`Two grunts on same tile (${grunt.row}, ${grunt.col})`);
    }
    gruntPositions.add(key);

    // Grunt not on a wall
    if (allWalls.has(key)) {
      fail(`Grunt on wall tile (${grunt.row}, ${grunt.col})`);
    }

    // Grunt not on interior
    if (allInterior.has(key)) {
      fail(`Grunt on interior/enclosed tile (${grunt.row}, ${grunt.col})`);
    }

    // Grunt not on water
    if (!isGrass(state.map.tiles, grunt.row, grunt.col)) {
      fail(`Grunt on non-grass tile (${grunt.row}, ${grunt.col})`);
    }

    // Grunt not on tower
    if (towerTiles.has(key)) {
      fail(`Grunt on tower tile (${grunt.row}, ${grunt.col})`);
    }

    // Grunt not on cannon
    if (allCannonTiles.has(key)) {
      fail(`Grunt on cannon tile (${grunt.row}, ${grunt.col})`);
    }

    // Grunt not on alive house
    for (const house of state.map.houses) {
      if (house.alive && house.row === grunt.row && house.col === grunt.col) {
        fail(`Grunt on alive house tile (${grunt.row}, ${grunt.col})`);
      }
    }

    // Valid targetPlayerId
    const target = state.players[grunt.targetPlayerId];
    if (!target) {
      fail(`Grunt has invalid targetPlayerId=${grunt.targetPlayerId}`);
    }

    // In bounds
    if (
      grunt.row < 0 ||
      grunt.row >= GRID_ROWS ||
      grunt.col < 0 ||
      grunt.col >= GRID_COLS
    ) {
      fail(`Grunt out of bounds (${grunt.row}, ${grunt.col})`);
    }
  }

  // Check alive houses
  for (const house of state.map.houses) {
    if (!house.alive) continue;
    const key = packTile(house.row, house.col);

    // House not on a wall
    if (allWalls.has(key)) {
      fail(`Alive house on wall tile (${house.row}, ${house.col})`);
    }

    // House not on interior
    if (allInterior.has(key)) {
      fail(`Alive house on interior tile (${house.row}, ${house.col})`);
    }
  }

  // Check tower alive flags
  for (let i = 0; i < state.map.towers.length; i++) {
    if (state.towerAlive[i] === undefined) {
      fail(`Tower ${i} has undefined alive state`);
    }
  }

  // Check walls are on grass
  for (const p of state.players) {
    for (const key of p.walls) {
      const { r, c } = unpackTile(key);
      if (!isGrass(state.map.tiles, r, c)) {
        fail(`Player ${p.id} has wall on non-grass tile (${r}, ${c})`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Headless game simulation
// ---------------------------------------------------------------------------

function simulateGame(
  gameNum: number,
  seed: number,
  violations: Violation[],
): { rounds: number; winner: number | null } {
  const runtime = createHeadlessRuntime(seed);
  const { state, controllers, playerCount } = runtime;

  let tick = 0;
  const MAX_ROUNDS = 50;

  while (state.round <= MAX_ROUNDS) {
    // CANNON_PLACE phase
    resetCannonFacings(state);
    computeCannonLimitsForPhase(state);
    for (let i = 0; i < playerCount; i++) {
      const player = state.players[i]!;
      if (player.eliminated) continue;
      const ctrl = controllers[i]!;
      ctrl.placeCannons(state, state.cannonLimits[i]!);
      ctrl.flushCannons(state, state.cannonLimits[i]!);
    }

    // Resolve propaganda balloons, then transition to BATTLE
    resolveBalloons(state);
    nextPhase(state); // CANNON_PLACE → BATTLE
    for (const ctrl of controllers) ctrl.resetBattle(state);

    validateGameState(state, gameNum, tick++, violations);

    // Simulate battle
    const battleDuration = BATTLE_TIMER;
    let battleTime = 0;
    const dt = 0.1;

    while (battleTime < battleDuration || state.cannonballs.length > 0) {
      if (battleTime < battleDuration) {
        for (let i = 0; i < playerCount; i++) {
          if (state.players[i]!.eliminated) continue;
          controllers[i]!.battleTick(state, dt);
        }
      }

      gruntAttackTowers(state, dt);
      updateCannonballs(state, dt);
      battleTime += dt;
      tick++;

      // Validate every 1 second of battle
      if (Math.round(battleTime * 10) % 10 === 0) {
        validateGameState(state, gameNum, tick, violations);
      }
    }
    for (const ctrl of controllers) ctrl.onBattleEnd();

    // BATTLE → WALL_BUILD
    nextPhase(state);

    validateGameState(state, gameNum, tick++, violations);

    // Simulate build phase (BUILD_TIMER + 1 seconds) (26 seconds)
    for (let i = 0; i < playerCount; i++) {
      if (state.players[i]!.eliminated) continue;
      controllers[i]!.startBuild(state);
    }

    const buildDuration = BUILD_TIMER + 1;
    let buildTime = 0;
    let gruntTickAccum = 0;

    while (buildTime < buildDuration) {
      const buildDt = 0.5; // faster steps for build phase
      buildTime += buildDt;

      // Grunt movement (1 tile/sec)
      gruntTickAccum += buildDt;
      if (gruntTickAccum >= 1.0) {
        gruntTickAccum -= 1.0;
        tickGrunts(state);
      }

      // AI placements
      for (let i = 0; i < playerCount; i++) {
        if (state.players[i]!.eliminated) continue;
        controllers[i]!.buildTick(state, buildDt);
      }

      // Validate every 2 seconds of build
      if (Math.round(buildTime * 2) % 2 === 0) {
        validateGameState(state, gameNum, tick++, violations);
      }
    }

    for (const ctrl of controllers) ctrl.endBuild(state);

    const { needsReselect } = finalizeBuildPhase(state);

    processHeadlessReselection(runtime, needsReselect);

    const alive = state.players.filter((p) => !p.eliminated);
    if (alive.length <= 1) {
      return { rounds: state.round, winner: alive[0]?.id ?? null };
    }

    validateGameState(state, gameNum, tick++, violations);
  }

  return { rounds: state.round, winner: null };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const NUM_GAMES = 3;
const violations: Violation[] = [];

console.log(`Running ${NUM_GAMES} headless games...`);

for (let i = 0; i < NUM_GAMES; i++) {
  const seed = Math.floor(Math.random() * 1000000);
  const result = simulateGame(i, seed, violations);
  const status =
    violations.length > 0 ? `⚠ ${violations.length} violations` : "OK";
  console.log(
    `  Game ${i + 1} (seed=${seed}): ${result.rounds} rounds, winner=${result.winner ?? "draw"} [${status}]`,
  );
}

console.log(`\n=== RESULTS ===`);
console.log(`Games: ${NUM_GAMES}`);
console.log(`Total violations: ${violations.length}`);

if (violations.length > 0) {
  // Group by message
  const grouped = new Map<string, Violation[]>();
  for (const v of violations) {
    const list = grouped.get(v.message) ?? [];
    list.push(v);
    grouped.set(v.message, list);
  }

  console.log(`\nViolation types (${grouped.size}):`);
  for (const [msg, list] of [...grouped.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    console.log(`  [${list.length}x] ${msg}`);
    // Show first 3 occurrences
    for (const v of list.slice(0, 3)) {
      console.log(
        `       game=${v.game} round=${v.round} phase=${v.phase} tick=${v.tick}`,
      );
    }
  }
} else {
  console.log("\nNo violations found! All invariants hold.");
}
