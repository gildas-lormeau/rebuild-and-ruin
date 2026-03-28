/**
 * Headless game simulation — runs N full games validating invariants
 * at phase boundaries. Rewritten to use the scenario test DSL.
 *
 * Run with: bun test/headless.test.ts
 */

import {
  collectAllCannonTiles,
  collectAllInterior,
  collectAllWalls,
} from "../src/board-occupancy.ts";
import { GRID_COLS, GRID_ROWS } from "../src/grid.ts";
import { forEachTowerTile, isGrass, packTile, unpackTile } from "../src/spatial.ts";
import type { GameState } from "../src/types.ts";
import { createScenario } from "./scenario-helpers.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const NUM_GAMES = 3;
const MAX_ROUNDS = 50;

// ---------------------------------------------------------------------------
// Invariant validation
// ---------------------------------------------------------------------------

interface Violation {
  game: number;
  round: number;
  phase: string;
  message: string;
}

function validateGameState(
  state: GameState,
  gameNum: number,
  violations: Violation[],
): void {
  const ctx = { game: gameNum, round: state.round, phase: state.phase };

  function fail(msg: string) {
    violations.push({ ...ctx, message: msg });
  }

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

    if (gruntPositions.has(key))
      fail(`Two grunts on same tile (${grunt.row}, ${grunt.col})`);
    gruntPositions.add(key);

    if (allWalls.has(key))
      fail(`Grunt on wall tile (${grunt.row}, ${grunt.col})`);
    if (allInterior.has(key))
      fail(`Grunt on interior tile (${grunt.row}, ${grunt.col})`);
    if (!isGrass(state.map.tiles, grunt.row, grunt.col))
      fail(`Grunt on non-grass tile (${grunt.row}, ${grunt.col})`);
    if (towerTiles.has(key))
      fail(`Grunt on tower tile (${grunt.row}, ${grunt.col})`);
    if (allCannonTiles.has(key))
      fail(`Grunt on cannon tile (${grunt.row}, ${grunt.col})`);

    for (const house of state.map.houses) {
      if (house.alive && house.row === grunt.row && house.col === grunt.col)
        fail(`Grunt on alive house tile (${grunt.row}, ${grunt.col})`);
    }

    if (!state.players[grunt.targetPlayerId])
      fail(`Grunt has invalid targetPlayerId=${grunt.targetPlayerId}`);
    if (
      grunt.row < 0 ||
      grunt.row >= GRID_ROWS ||
      grunt.col < 0 ||
      grunt.col >= GRID_COLS
    )
      fail(`Grunt out of bounds (${grunt.row}, ${grunt.col})`);
  }

  // Check alive houses
  for (const house of state.map.houses) {
    if (!house.alive) continue;
    const key = packTile(house.row, house.col);
    if (allWalls.has(key))
      fail(`Alive house on wall tile (${house.row}, ${house.col})`);
    if (allInterior.has(key))
      fail(`Alive house on interior tile (${house.row}, ${house.col})`);
  }

  // Check tower alive flags
  for (let i = 0; i < state.map.towers.length; i++) {
    if (state.towerAlive[i] === undefined)
      fail(`Tower ${i} has undefined alive state`);
  }

  // Check walls are on grass
  for (const p of state.players) {
    for (const key of p.walls) {
      const { r, c } = unpackTile(key);
      if (!isGrass(state.map.tiles, r, c))
        fail(`Player ${p.id} has wall on non-grass tile (${r}, ${c})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Run games
// ---------------------------------------------------------------------------

console.log(`Running ${NUM_GAMES} headless games...\n`);

const violations: Violation[] = [];

for (let i = 0; i < NUM_GAMES; i++) {
  const seed = Math.floor(Math.random() * 1000000);
  const s = createScenario(seed);

  let rounds = 0;
  while (s.state.round <= MAX_ROUNDS) {
    const { needsReselect } = s.playRound();

    validateGameState(s.state, i, violations);

    s.processReselection(needsReselect);

    validateGameState(s.state, i, violations);

    const alive = s.state.players.filter((p) => !p.eliminated);
    if (alive.length <= 1) {
      rounds = s.state.round;
      const winner = alive[0]?.id ?? null;
      const status =
        violations.length > 0 ? `⚠ ${violations.length} violations` : "OK";
      console.log(
        `  Game ${i + 1} (seed=${seed}): ${rounds} rounds, winner=${winner ?? "draw"} [${status}]`,
      );
      break;
    }
    rounds = s.state.round;
  }

  if (s.state.players.filter((p) => !p.eliminated).length > 1) {
    console.log(
      `  Game ${i + 1} (seed=${seed}): ${rounds} rounds, winner=draw [max rounds]`,
    );
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log(`\n=== RESULTS ===`);
console.log(`Games: ${NUM_GAMES}`);
console.log(`Total violations: ${violations.length}`);

if (violations.length > 0) {
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
    for (const v of list.slice(0, 3)) {
      console.log(`       game=${v.game} round=${v.round} phase=${v.phase}`);
    }
  }
  process.exit(1);
} else {
  console.log("\nNo violations found! All invariants hold.");
}
