/**
 * Grunt invariant test — plays real games and validates grunt state at every
 * phase boundary. Catches spawn location bugs, overlap, invalid tiles, and
 * zone violations through actual gameplay, not synthetic setups.
 *
 * Run with: deno test --no-check test/grunt-spawn.test.ts
 */

import { assert } from "@std/assert";
import { GRID_COLS, GRID_ROWS } from "../src/shared/grid.ts";
import {
  inBounds,
  isGrass,
  isWater,
  packTile,
  isCannonTile,
} from "../src/shared/spatial.ts";
import { hasTowerAt } from "../src/shared/board-occupancy.ts";
import type { GameState } from "../src/shared/types.ts";
import type { Grunt } from "../src/shared/battle-types.ts";
import { GAME_MODE_MODERN } from "../src/shared/game-constants.ts";
import { setGameMode } from "../src/shared/types.ts";
import { createScenario } from "./scenario-helpers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Manhattan distance from (r,c) to nearest water tile on the entire map. */
function minWaterDist(
  tiles: readonly (readonly number[])[],
  row: number,
  col: number,
): number {
  let best = Infinity;
  for (let r = 0; r < GRID_ROWS && best > 1; r++) {
    for (let c = 0; c < GRID_COLS && best > 1; c++) {
      if (isWater(tiles, r, c)) {
        const dist = Math.abs(row - r) + Math.abs(col - c);
        if (dist < best) best = dist;
      }
    }
  }
  return best;
}

/** Snapshot current grunt positions as a set of packed tile keys. */
function gruntKeySet(grunts: readonly Grunt[]): Set<number> {
  return new Set(grunts.map((grunt) => packTile(grunt.row, grunt.col)));
}

// ---------------------------------------------------------------------------
// Invariant checks — run at every phase boundary
// ---------------------------------------------------------------------------

interface Violation {
  round: number;
  phase: string;
  message: string;
}

function validateGrunts(
  state: GameState,
  label: string,
  violations: Violation[],
): void {
  const round = state.round;
  const occupied = new Set<number>();

  for (let idx = 0; idx < state.grunts.length; idx++) {
    const grunt = state.grunts[idx]!;
    const pos = `(${grunt.row},${grunt.col})`;

    if (!inBounds(grunt.row, grunt.col)) {
      violations.push({ round, phase: label, message: `Grunt ${idx} at ${pos} out of bounds` });
      continue;
    }

    // Must be on grass (or frozen water)
    const onGrass = isGrass(state.map.tiles, grunt.row, grunt.col);
    const onFrozen = state.modern?.frozenTiles?.has(packTile(grunt.row, grunt.col)) ?? false;
    if (!onGrass && !onFrozen) {
      violations.push({ round, phase: label, message: `Grunt ${idx} at ${pos} on non-grass/non-frozen tile` });
    }

    // No overlapping grunts
    const key = packTile(grunt.row, grunt.col);
    if (occupied.has(key)) {
      violations.push({ round, phase: label, message: `Duplicate grunt at ${pos}` });
    }
    occupied.add(key);

    // Not on a tower tile
    if (hasTowerAt(state, grunt.row, grunt.col)) {
      violations.push({ round, phase: label, message: `Grunt ${idx} at ${pos} on tower tile` });
    }

    // Not inside enclosed territory
    for (const player of state.players) {
      if (player.interior.has(key)) {
        violations.push({ round, phase: label, message: `Grunt ${idx} at ${pos} inside P${player.id} interior` });
      }
    }

    // Zone must be valid
    const zone = state.map.zones[grunt.row]?.[grunt.col];
    if (zone === undefined || zone < 0) {
      violations.push({ round, phase: label, message: `Grunt ${idx} at ${pos} in invalid zone ${zone}` });
    }

    // Not on an alive cannon
    for (const player of state.players) {
      for (const cannon of player.cannons) {
        if (cannon.hp > 0 && isCannonTile(cannon, grunt.row, grunt.col)) {
          violations.push({ round, phase: label, message: `Grunt ${idx} at ${pos} on alive cannon` });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Spawn location tracking — only for newly appeared grunts
// ---------------------------------------------------------------------------

interface SpawnStats {
  newGrunts: number;
  totalWaterDist: number;
  /** Grunts that spawned near water (dist ≤2 = river bank). */
  bankSpawns: number;
  /** Grunts that spawned on map edge (row/col 0 or max) AND far from water (dist >2). */
  edgeOnlySpawns: number;
}

/** Find grunts that appeared since the last snapshot. */
function findNewGrunts(
  grunts: readonly Grunt[],
  prevKeys: ReadonlySet<number>,
): Grunt[] {
  return grunts.filter((grunt) => !prevKeys.has(packTile(grunt.row, grunt.col)));
}

function isEdgeTile(row: number, col: number): boolean {
  return row <= 0 || col <= 0 || row >= GRID_ROWS - 1 || col >= GRID_COLS - 1;
}

function trackNewSpawns(
  state: GameState,
  prevKeys: ReadonlySet<number>,
  stats: SpawnStats,
): void {
  const newGrunts = findNewGrunts(state.grunts, prevKeys);
  for (const grunt of newGrunts) {
    const dist = minWaterDist(state.map.tiles, grunt.row, grunt.col);
    stats.newGrunts++;
    stats.totalWaterDist += dist;
    if (dist <= 2) {
      stats.bankSpawns++;
    } else if (isEdgeTile(grunt.row, grunt.col)) {
      stats.edgeOnlySpawns++;
    }
  }
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function runGruntInvariantTest(seed: number, modern: boolean): Promise<void> {
  const scenario = await createScenario(seed);
  if (modern) setGameMode(scenario.state, GAME_MODE_MODERN);
  const state = scenario.state;

  const violations: Violation[] = [];
  const stats: SpawnStats = { newGrunts: 0, totalWaterDist: 0, bankSpawns: 0, edgeOnlySpawns: 0 };

  let maxRounds = 8;
  while (state.players.filter((player) => !player.eliminated).length > 1 && maxRounds-- > 0) {
    // Snapshot before cannon phase — interbattle grunts spawn during enterBuildFromBattle
    // which already ran in the previous finalizeBuild/processReselection.
    // New grunts also spawn at cannon→battle transition (idle penalty).
    const preCannonKeys = gruntKeySet(state.grunts);

    scenario.runCannon();
    validateGrunts(state, "after-cannon", violations);
    // Track grunts that appeared during cannon (idle penalty round 1)
    trackNewSpawns(state, preCannonKeys, stats);

    const preBattleKeys = gruntKeySet(state.grunts);
    scenario.runBattle();
    validateGrunts(state, "after-battle", violations);
    // Track grunts spawned from house destruction during battle
    trackNewSpawns(state, preBattleKeys, stats);

    const preBuildKeys = gruntKeySet(state.grunts);
    scenario.runBuild();
    validateGrunts(state, "after-build", violations);
    // Track grunts from breach queue or enclosed-house spawns during build
    trackNewSpawns(state, preBuildKeys, stats);

    const result = scenario.finalizeBuild();
    validateGrunts(state, "after-finalize", violations);

    scenario.processReselection(result.needsReselect);
    if (result.needsReselect.length > 0) {
      validateGrunts(state, "after-reselect", violations);
    }
  }

  // Report violations
  if (violations.length > 0) {
    const summary = violations.slice(0, 10).map(
      (violation) => `  round ${violation.round} ${violation.phase}: ${violation.message}`,
    ).join("\n");
    const extra = violations.length > 10 ? `\n  ... and ${violations.length - 10} more` : "";
    assert(false, `Seed ${seed} (${modern ? "modern" : "classic"}): ${violations.length} grunt violations:\n${summary}${extra}`);
  }

  // Spawn location quality: newly spawned grunts should trend near water.
  // Threshold is 7 (not tighter) because house-destruction spawns and
  // breach-queue spawns legitimately land far from water.
  if (stats.newGrunts > 0) {
    const avgDist = stats.totalWaterDist / stats.newGrunts;
    assert(
      avgDist <= 7,
      `Seed ${seed}: ${stats.newGrunts} new grunts averaged ${avgDist.toFixed(1)} tiles from water (expected ≤7)`,
    );
  }

  // Bank-before-edge ordering: among non-breach/non-house spawns,
  // grunts near water (bank, dist ≤2) should outnumber grunts on map edges
  // (row 0/max or col 0/max) that are far from water (dist >2).
  // This catches regressions where the sort order is broken.
  if (stats.bankSpawns + stats.edgeOnlySpawns > 0) {
    assert(
      stats.bankSpawns >= stats.edgeOnlySpawns,
      `Seed ${seed}: edge-only spawns (${stats.edgeOnlySpawns}) outnumber bank spawns (${stats.bankSpawns}) — bank-first sort may be broken`,
    );
  }
}

// ---------------------------------------------------------------------------
// Multi-seed tests
// ---------------------------------------------------------------------------

const seeds = [42, 99, 77, 256, 1337, 7, 2024, 555];

for (const seed of seeds) {
  Deno.test(`classic seed ${seed}: grunt invariants`, () => runGruntInvariantTest(seed, false));
}

for (const seed of seeds) {
  Deno.test(`modern seed ${seed}: grunt invariants`, () => runGruntInvariantTest(seed, true));
}
