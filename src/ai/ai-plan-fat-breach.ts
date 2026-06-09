/**
 * AI tactic — diagonal fat-wall breach. Drill a diagonal line of holes
 * (XWW / WXW / WWX) through a thick (≥3-tile) enemy wall body: since the
 * enclosure flood is 8-directional, a diagonal staircase is the
 * minimum-shot way to bridge outside→interior. Breaks enclosure (a
 * repair-tax tactic, not a grunt lane), validated after the budget cap.
 */

import { shouldAbsorbWallHit } from "../game/index.ts";
import {
  filterActiveEnemies,
  getBattleInterior,
} from "../shared/core/board-occupancy.ts";
import type { TilePos } from "../shared/core/geometry-types.ts";
import type { TileKey } from "../shared/core/grid.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import {
  computeOutside,
  DIRS_8,
  inBounds,
  orderByNearest,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import type { Rng } from "../shared/platform/rng.ts";
import {
  countBrokenEnclosures,
  DESTROY_POCKET_MAX_SIZE,
  findEnclosureComponents,
  isEnclosureBroken,
} from "./ai-strategy-battle.ts";

type BreachCandidate = {
  tiles: TilePos[];
  enclosuresBroken: number;
};

/** Minimum walls an enemy must have to possibly contain a 3×3 fat core. */
const FAT_BREACH_MIN_WALLS = 9;
/** Max diagonal holes fired in a single fat-breach chain. */
const MAX_FAT_BREACH_TARGETS = 8;
/** Bound on `computeOutside` floods per enemy (parity with wall-demolition's
 *  MAX_SEED_ATTEMPTS). Candidate runs are flood-validated until this budget is
 *  spent, then the enemy is abandoned. */
const MAX_FLOODS = 5;
/** The two diagonal axes (NW-SE, NE-SW). Walking both ways along an axis covers
 *  all four DIRS_DIAG directions, so iterating only these two avoids generating
 *  each run twice. */
const DIAG_AXES = [
  [1, 1],
  [1, -1],
] as const;

/** Plan a diagonal fat-wall breach: drill a diagonal channel through a thick
 *  enemy wall body so the 8-dir flood breaches a large enclosure. Returns the
 *  diagonal holes ordered for chain execution, or null when no enemy has a fat
 *  body whose diagonal cut breaches within the cannon budget. */
export function planFatBreach(
  state: BattleViewState,
  playerId: ValidPlayerId,
  usableCannonCount: number,
  rng: Rng,
): TilePos[] | null {
  const enemies = filterActiveEnemies(state, playerId);
  rng.shuffle(enemies);
  const cap = Math.min(usableCannonCount, MAX_FAT_BREACH_TARGETS);

  for (const enemy of enemies) {
    if (enemy.walls.size < FAT_BREACH_MIN_WALLS) continue;
    const interior = getBattleInterior(enemy);
    const outside = computeOutside(enemy.walls);
    // Validate only against STILL-INTACT enclosures: an already-breached one
    // is reached by the live flood whatever the candidate is, so leaving it
    // in the set would let any diagonal run "validate" on mid-battle re-plans.
    const large = findEnclosureComponents(interior)
      .filter((comp) => comp.length > DESTROY_POCKET_MAX_SIZE)
      .filter((comp) => !isEnclosureBroken(comp, outside));
    if (large.length === 0) continue;
    const fatCores = collectFatCores(enemy.walls);
    if (fatCores.length === 0) continue;
    // Seed from cores nearest the outer shell first — those produce
    // through-cuts (shell→interior), not partitions buried inside the body.
    fatCores.sort(
      (a, b) => shellDistance(a, outside) - shellDistance(b, outside),
    );

    const best = findBestBreach(enemy, large, outside, fatCores, cap);
    if (best) return orderByNearest(best.tiles);
  }
  return null;
}

/** Wall tiles whose full in-bounds 3×3 neighborhood is all walls (Chebyshev
 *  erosion → the wall body is ≥3 thick there). Edge tiles are rejected because
 *  their 3×3 spills off-grid. */
function collectFatCores(walls: ReadonlySet<TileKey>): TileKey[] {
  const cores: TileKey[] = [];
  for (const key of walls) {
    const { row, col } = unpackTile(key);
    if (isFatCore(walls, row, col)) cores.push(key);
  }
  return cores;
}

/** True when every tile of the 3×3 centered at (row, col) is in-bounds and a wall. */
function isFatCore(
  walls: ReadonlySet<TileKey>,
  row: number,
  col: number,
): boolean {
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const nr = row + dr;
      const nc = col + dc;
      if (!inBounds(nr, nc) || !walls.has(packTile(nr, nc))) return false;
    }
  }
  return true;
}

/** Build diagonal candidate runs from the fat cores and return the best one
 *  whose budget-capped prefix breaches a large enclosure, or null. */
function findBestBreach(
  enemy: Player,
  large: readonly (readonly TileKey[])[],
  outside: ReadonlySet<TileKey>,
  fatCores: readonly TileKey[],
  cap: number,
): BreachCandidate | undefined {
  const seen = new Set<string>();
  let floods = 0;
  let best: BreachCandidate | undefined;

  for (const core of fatCores) {
    for (const [dr, dc] of DIAG_AXES) {
      if (floods >= MAX_FLOODS) return best;
      const run = orientShellFirst(
        diagonalRun(enemy.walls, core, dr, dc),
        outside,
      );
      const sig = run.join(",");
      if (seen.has(sig)) continue;
      seen.add(sig);
      if (run.length < 2) continue;
      if (includesUndamagedReinforced(enemy, run)) continue;

      // Charge the floods growToBreach ACTUALLY ran (it stops at the first
      // breaching prefix) — pre-charging the full capped run length burned
      // the whole budget on the first long run and left the best-of search
      // below comparing nothing.
      const grown = growToBreach(
        enemy.walls,
        large,
        run,
        cap,
        MAX_FLOODS - floods,
      );
      floods += grown.floodsUsed;
      const candidate = grown.candidate;
      if (!candidate) continue;
      if (
        !best ||
        candidate.enclosuresBroken > best.enclosuresBroken ||
        (candidate.enclosuresBroken === best.enclosuresBroken &&
          candidate.tiles.length < best.tiles.length)
      ) {
        best = candidate;
      }
    }
  }
  return best;
}

/** Maximal run of consecutive wall tiles through `start` along the (dr, dc)
 *  diagonal axis, walking both directions. */
function diagonalRun(
  walls: ReadonlySet<TileKey>,
  start: TileKey,
  dr: number,
  dc: number,
): TileKey[] {
  const { row, col } = unpackTile(start);
  const back: TileKey[] = [];
  // Walk backward (−axis), collecting then reversing so the run is contiguous.
  for (let r = row - dr, c = col - dc; ; r -= dr, c -= dc) {
    if (!inBounds(r, c)) break;
    const key = packTile(r, c);
    if (!walls.has(key)) break;
    back.push(key);
  }
  back.reverse();
  const forward: TileKey[] = [start];
  for (let r = row + dr, c = col + dc; ; r += dr, c += dc) {
    if (!inBounds(r, c)) break;
    const key = packTile(r, c);
    if (!walls.has(key)) break;
    forward.push(key);
  }
  return [...back, ...forward];
}

/** Orient a run so index 0 is the end nearest the outside flood, so growing a
 *  prefix drills inward from the shell. */
function orientShellFirst(
  run: readonly TileKey[],
  outside: ReadonlySet<TileKey>,
): TileKey[] {
  if (run.length < 2) return [...run];
  const headDist = shellDistance(run[0]!, outside);
  const tailDist = shellDistance(run[run.length - 1]!, outside);
  return tailDist < headDist ? [...run].reverse() : [...run];
}

/** Cheapest 8-adjacency distance from a wall tile to the outside flood
 *  (0 = the tile itself touches outside, 1 = a neighbor does, else a large
 *  sentinel). Used only to order seeds — not for correctness. */
function shellDistance(
  wallKey: TileKey,
  outside: ReadonlySet<TileKey>,
): number {
  const { row, col } = unpackTile(wallKey);
  for (const [dr, dc] of DIRS_8) {
    const nr = row + dr;
    const nc = col + dc;
    if (inBounds(nr, nc) && outside.has(packTile(nr, nc))) return 1;
  }
  return 2;
}

/** Grow a prefix of `run` from the shell end until removing it breaches a
 *  large enclosure, capped at `cap` tiles and `floodBudget` floods (one flood
 *  per grown tile). Returns the minimal breaching prefix (or undefined when
 *  no in-budget prefix breaches) plus the number of floods actually run, so
 *  the caller charges its shared budget for work done — not for the run's
 *  full capped length. */
function growToBreach(
  walls: ReadonlySet<TileKey>,
  large: readonly (readonly TileKey[])[],
  run: readonly TileKey[],
  cap: number,
  floodBudget: number,
): { candidate: BreachCandidate | undefined; floodsUsed: number } {
  const mod = new Set(walls);
  const limit = Math.min(run.length, cap, floodBudget);
  const prefix: TilePos[] = [];
  for (let i = 0; i < limit; i++) {
    const key = run[i]!;
    mod.delete(key);
    const { row, col } = unpackTile(key);
    prefix.push({ row: row, col: col });
    const broken = countBrokenEnclosures(mod, large);
    if (broken > 0) {
      return {
        candidate: { tiles: prefix, enclosuresBroken: broken },
        floodsUsed: i + 1,
      };
    }
  }
  return { candidate: undefined, floodsUsed: limit };
}

/** True when the run crosses a reinforced wall that hasn't taken its one
 *  absorbing hit yet (needs 2 hits, but the chain fires once per tile — the
 *  binary-removal validation would otherwise lie). `shouldAbsorbWallHit`
 *  encapsulates the Reinforced Walls ownership + damagedWalls check. */
function includesUndamagedReinforced(
  enemy: Player,
  run: readonly TileKey[],
): boolean {
  for (const key of run) {
    if (shouldAbsorbWallHit(enemy, key)) return true;
  }
  return false;
}
