/**
 * Headless game simulation — runs full games validating invariants
 * at phase boundaries. Uses the scenario test DSL.
 */

import {
  collectAllCannonTiles,
  collectAllInterior,
  collectAllWalls,
} from "../src/shared/board-occupancy.ts";
import { GRID_COLS, GRID_ROWS } from "../src/shared/grid.ts";
import type { GameState } from "../src/shared/types.ts";
import { createScenario } from "./scenario-helpers.ts";
import { assert } from "@std/assert";
import { cannonSize, computeOutside, forEachTowerTile, isCannonAlive, isGrass, packTile, unpackTile, waterKeys } from "../src/shared/spatial.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_ROUNDS = 12;

// ---------------------------------------------------------------------------
// Invariant validation
// ---------------------------------------------------------------------------

interface Violation {
  round: number;
  phase: string;
  message: string;
}

function validateGameState(
  state: GameState,
  violations: Violation[],
): void {
  const ctx = { round: state.round, phase: state.phase };

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

  // --- Grunt checks ---
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

    if (!state.players[grunt.victimPlayerId])
      fail(`Grunt has invalid victimPlayerId=${grunt.victimPlayerId}`);
    if (
      grunt.row < 0 ||
      grunt.row >= GRID_ROWS ||
      grunt.col < 0 ||
      grunt.col >= GRID_COLS
    )
      fail(`Grunt out of bounds (${grunt.row}, ${grunt.col})`);
  }

  // --- House checks ---
  for (const house of state.map.houses) {
    if (!house.alive) continue;
    const key = packTile(house.row, house.col);
    if (allWalls.has(key))
      fail(`Alive house on wall tile (${house.row}, ${house.col})`);
    if (allInterior.has(key))
      fail(`Alive house on interior tile (${house.row}, ${house.col})`);
  }

  // --- Tower checks ---
  for (let i = 0; i < state.map.towers.length; i++) {
    if (state.towerAlive[i] === undefined)
      fail(`Tower ${i} has undefined alive state`);
  }

  // --- Wall checks ---
  for (const p of state.players) {
    for (const key of p.walls) {
      const { r, c } = unpackTile(key);
      if (!isGrass(state.map.tiles, r, c))
        fail(`Player ${p.id} has wall on non-grass tile (${r}, ${c})`);
    }
  }

  // --- Walls and interior must not overlap ---
  for (const p of state.players) {
    for (const key of p.walls) {
      if (p.interior.has(key))
        fail(`Player ${p.id} wall+interior overlap at tile ${key}`);
    }
  }

  // --- Interior tiles must be enclosed by walls ---
  // (flood-fill from edges should NOT reach interior tiles)
  const water = waterKeys(state.map.tiles);
  for (const p of state.players) {
    if (p.interior.size === 0) continue;
    const outside = computeOutside(p.walls, water);
    for (const key of p.interior) {
      if (outside.has(key)) {
        const { r, c } = unpackTile(key);
        fail(
          `Player ${p.id} interior tile (${r}, ${c}) is reachable from edges (not enclosed)`,
        );
      }
    }
  }

  // --- Cannon consistency ---
  for (const p of state.players) {
    const cannonTilesForPlayer = new Set<number>();
    for (const cannon of p.cannons) {
      const sz = cannonSize(cannon.mode);
      // Cannon must be in bounds
      if (
        cannon.row < 0 ||
        cannon.col < 0 ||
        cannon.row + sz > GRID_ROWS ||
        cannon.col + sz > GRID_COLS
      )
        fail(
          `Player ${p.id} cannon at (${cannon.row}, ${cannon.col}) sz=${sz} out of bounds`,
        );

      // Alive cannons must have hp > 0
      if (isCannonAlive(cannon) && cannon.hp <= 0)
        fail(
          `Player ${p.id} cannon at (${cannon.row}, ${cannon.col}) alive but hp=${cannon.hp}`,
        );

      // Dead cannons must have hp <= 0
      if (!isCannonAlive(cannon) && cannon.hp > 0)
        fail(
          `Player ${p.id} cannon at (${cannon.row}, ${cannon.col}) dead but hp=${cannon.hp}`,
        );

      // No overlapping cannons
      for (let dr = 0; dr < sz; dr++) {
        for (let dc = 0; dc < sz; dc++) {
          const key = packTile(cannon.row + dr, cannon.col + dc);
          if (cannonTilesForPlayer.has(key))
            fail(
              `Player ${p.id} overlapping cannons at (${cannon.row + dr}, ${cannon.col + dc})`,
            );
          cannonTilesForPlayer.add(key);
        }
      }
    }
  }

  // --- Eliminated player consistency ---
  for (const p of state.players) {
    if (!p.eliminated) continue;
    if (p.lives > 0)
      fail(`Eliminated player ${p.id} has lives=${p.lives}`);
  }

  // --- Score must never be negative ---
  for (const p of state.players) {
    if (p.score < 0) fail(`Player ${p.id} has negative score ${p.score}`);
  }

  // --- Burning pits on grass ---
  for (const pit of state.burningPits) {
    if (!isGrass(state.map.tiles, pit.row, pit.col))
      fail(`Burning pit on non-grass tile (${pit.row}, ${pit.col})`);
    if (pit.roundsLeft <= 0)
      fail(`Expired burning pit at (${pit.row}, ${pit.col}) roundsLeft=${pit.roundsLeft}`);
  }

  // --- Bonus squares on grass and not on walls/interior ---
  for (const sq of state.bonusSquares) {
    if (!isGrass(state.map.tiles, sq.row, sq.col))
      fail(`Bonus square on non-grass tile (${sq.row}, ${sq.col})`);
    const key = packTile(sq.row, sq.col);
    if (allWalls.has(key))
      fail(`Bonus square on wall tile (${sq.row}, ${sq.col})`);
  }
}

// ---------------------------------------------------------------------------
// Cross-round invariants (tracked across the game)
// ---------------------------------------------------------------------------

interface GameTracker {
  prevScores: number[];
  prevRound: number;
}

function validateCrossRound(
  state: GameState,
  tracker: GameTracker,
  violations: Violation[],
): void {
  const ctx = { round: state.round, phase: state.phase };

  // Round must advance
  if (state.round < tracker.prevRound) {
    violations.push({
      ...ctx,
      message: `Round went backwards: ${tracker.prevRound} → ${state.round}`,
    });
  }

  // Scores must never decrease
  for (let i = 0; i < state.players.length; i++) {
    const prev = tracker.prevScores[i] ?? 0;
    const curr = state.players[i]!.score;
    if (curr < prev) {
      violations.push({
        ...ctx,
        message: `Player ${i} score decreased: ${prev} → ${curr}`,
      });
    }
  }

  // Update tracker
  tracker.prevScores = state.players.map((p) => p.score);
  tracker.prevRound = state.round;
}

// ---------------------------------------------------------------------------
// Tests — one per seed
// ---------------------------------------------------------------------------

async function runGame(seed: number): Promise<void> {
  const s = await createScenario(seed);
  const tracker: GameTracker = {
    prevScores: s.state.players.map((p) => p.score),
    prevRound: s.state.round,
  };
  const violations: Violation[] = [];

  while (s.state.round <= MAX_ROUNDS) {
    const { needsReselect } = s.playRound();

    validateGameState(s.state, violations);
    validateCrossRound(s.state, tracker, violations);

    s.processReselection(needsReselect);

    validateGameState(s.state, violations);

    const alive = s.state.players.filter((p) => !p.eliminated);
    if (alive.length <= 1) break;
  }

  if (violations.length > 0) {
    const summary = violations
      .slice(0, 10)
      .map((v) => `  round=${v.round} phase=${v.phase}: ${v.message}`)
      .join("\n");
    assert(false, `${violations.length} violation(s) in seed=${seed}:\n${summary}`);
  }
}

for (const seed of [3, 7, 25, 40, 55]) {
  Deno.test(`headless game invariants (seed=${seed})`, async () => {
    await runGame(seed);
  });
}
