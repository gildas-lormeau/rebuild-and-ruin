/**
 * AI tactic — sustained pressure. Tail fallback chain: when no surgical
 * tactic plans (rings breached, once-per-battle attacks spent), grind the
 * victim's remaining walls instead of dropping to the per-shot loop —
 * repair tax plus the visible volley the min-cut tactics traded away.
 * Fires a nearest-neighbour walk from the attacker's own crosshair,
 * preferring walls that still seal live interior over opened rubble.
 */

import type { TilePos } from "../shared/core/geometry-types.ts";
import type { TileKey } from "../shared/core/grid.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import {
  DIRS_8,
  inBounds,
  manhattanDistance,
  orderByNearest,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import type { Rng } from "../shared/platform/rng.ts";
import { filterActiveEnemies } from "../shared/sim/board-occupancy.ts";
import { computeLiveInterior, leadWithEnemy } from "./ai-strategy-battle.ts";

/** Below this many victim walls the per-shot loop covers the grind fine. */
const MIN_TARGET_WALLS = 4;
/** Chain budget — matches the deny / max_repair siege chains. (A shorter
 *  8-cap was A/B'd to cut the grind's useless-hit share via more frequent
 *  live re-plans; it lowered total pressure without improving quality.) */
const MAX_SUSTAINED_TARGETS = 12;
/** Stop the walk rather than hop farther than this between consecutive
 *  targets — a long glide mid-chain costs more shots than it fires. */
const MAX_GRIND_HOP_TILES = 6;

/** Plan a sustained-pressure grind: pick the battle victim (falling back to
 *  any active enemy with enough walls) and chain a contiguous slice of their
 *  walls, preferring tiles still sealing live interior. Returns null only
 *  when no enemy offers a dense-enough wall cluster near the cursor. */
export function planSustainedPressure(
  state: BattleViewState,
  playerId: ValidPlayerId,
  usableCannonCount: number,
  rng: Rng,
  cursor: TilePos,
  victimId: ValidPlayerId | undefined,
): TilePos[] | null {
  const enemies = filterActiveEnemies(state, playerId);
  if (enemies.length === 0) return null;
  rng.shuffle(enemies);
  leadWithEnemy(enemies, victimId);
  const budget = Math.min(usableCannonCount * 2, MAX_SUSTAINED_TARGETS);
  // Two passes: first only walls still sealing live interior — on ANY enemy,
  // so once the victim's ring is open the grind moves to an enemy whose
  // enclosure still stands (real pressure, and it spreads fire off the
  // already-broken victim). Rubble is the last resort: pure rebuild tax,
  // and every hit reads "useless" on the breach-distance axis.
  for (const workingOnly of [true, false]) {
    for (const enemy of enemies) {
      if (enemy.walls.size < MIN_TARGET_WALLS) continue;
      const pool = pickPool(enemy, workingOnly);
      if (pool.length < MIN_TARGET_WALLS) continue;
      const targets = grindWalk(pool, cursor, budget);
      if (targets.length >= MIN_TARGET_WALLS) return targets;
    }
  }
  return null;
}

/** The enemy's walls with any 8-neighbour in their LIVE interior — walls
 *  still doing enclosure work — or every wall when `workingOnly` is false
 *  (the rubble-tax pass). Live flood, not the cached `player.interior`: mid-
 *  battle the cache still holds the build-time territory, so an already-
 *  opened ring's walls would all read "working" and the grind would never
 *  move off the broken victim. One flood per enemy per plan. */
function pickPool(enemy: Player, workingOnly: boolean): TilePos[] {
  const interior = computeLiveInterior(enemy.walls);
  const pool: TilePos[] = [];
  for (const key of enemy.walls) {
    const { row, col } = unpackTile(key);
    if (!workingOnly || bordersInterior(interior, row, col)) {
      pool.push({ row, col });
    }
  }
  return pool;
}

function bordersInterior(
  interior: ReadonlySet<TileKey>,
  row: number,
  col: number,
): boolean {
  for (const [dr, dc] of DIRS_8) {
    const nr = row + dr;
    const nc = col + dc;
    if (inBounds(nr, nc) && interior.has(packTile(nr, nc))) return true;
  }
  return false;
}

/** Greedy nearest-neighbour walk over the pool (`orderByNearest`, seeded at
 *  the cursor), truncated at the first hop past MAX_GRIND_HOP_TILES. */
function grindWalk(
  pool: TilePos[],
  cursor: TilePos,
  budget: number,
): TilePos[] {
  const ordered = orderByNearest(pool, budget, cursor);
  const targets: TilePos[] = [];
  for (const tile of ordered) {
    const prev = targets[targets.length - 1];
    if (
      prev &&
      manhattanDistance(prev.row, prev.col, tile.row, tile.col) >
        MAX_GRIND_HOP_TILES
    ) {
      break;
    }
    targets.push(tile);
  }
  return targets;
}
