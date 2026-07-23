/**
 * AI tactic — finish it (perimeter spray). A dominant player (>=14 usable
 * cannons) vs a LARGE, MESSY (fat-walled) enemy castle sprays single holes
 * SPACED AROUND its exposed outer wall — not a kill but a demoralising repair
 * tax (every hole a separate refill) plus modern demolition combos. Targets
 * the messiest qualifying enemy. Wired ABOVE pinch in `planBattle` (below
 * defence) so a dominant battle leads with the spray; gate in `rollFinishIt`.
 */

import type { TilePos } from "../shared/core/geometry-types.ts";
import type { TileKey } from "../shared/core/grid.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import {
  computeOutside,
  DIRS_4,
  inBounds,
  manhattanDistance,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import { filterActiveEnemies } from "../shared/sim/board-occupancy.ts";
import { computeLiveInterior, isFatWallTile } from "./ai-strategy-battle.ts";

/** Concurrent player slots (Red/Blue/Gold). The spray's angular start is
 *  offset by slot so two dominant attackers hitting the same castle punch
 *  different holes instead of cloning the same sweep. */
const SLOT_COUNT = 3;
/** Interior tiles a target must enclose to count as "large". Started at the p75
 *  of all measured castles (145); lowered to 130 to fire more often — the size
 *  gate is the second-biggest frequency lever (a dominant player's victim is
 *  often small/being-crushed, so large targets are the scarce ingredient). Kept
 *  well above a crumb so the spray still lands on a castle worth the spend. */
export const FINISH_IT_MIN_INTERIOR = 130;
/** Redundant inner "fat" walls a target must carry to count as "messy" — the
 *  p75 of measured castles. Messiness is the fat-wall signal (not
 *  perimeter-to-area, which the data showed is INVERTED for big castles: they
 *  are thick but compact). A tidy optimal castle carries almost none. */
export const FINISH_IT_MIN_FAT_WALLS = 60;
/** Minimum Manhattan gap between consecutive punched holes. ≥2 leaves at least
 *  one intact wall between holes, so each is a SEPARATE gap the victim fills
 *  with its own piece — the whole point (spread, not one contiguous breach). */
export const FINISH_IT_MIN_SPACING = 2;

/**
 * Plan a "finish it" perimeter spray: pick the messiest large enemy castle and
 * return single-tile outer-wall holes spaced around its whole shell, ordered as
 * a sweep going around the castle (start rotated per-attacker). Returns null
 * when no enemy is both large and messy enough to be worth the spend, or its
 * shell offers no spaced holes.
 */
export function planFinishIt(
  state: BattleViewState,
  playerId: ValidPlayerId,
): TilePos[] | null {
  const target = pickMessiestCastle(state, playerId);
  if (!target) return null;
  const shell = outerShellWalls(target.walls);
  if (shell.length === 0) return null;
  const spread = spreadAroundRing(shell, target.center, playerId);
  return spread.length > 0 ? spread : null;
}

/** The largest+messiest active enemy (max fat-wall count among those clearing
 *  BOTH the interior and fat-wall floors), with its live interior centroid.
 *  Pure synced geometry — no rng — so every peer picks the same target for a
 *  given attacker; per-attacker desync lives in the spray rotation. */
function pickMessiestCastle(
  state: BattleViewState,
  playerId: ValidPlayerId,
): { walls: ReadonlySet<TileKey>; center: TilePos } | undefined {
  let best: { walls: ReadonlySet<TileKey>; center: TilePos } | undefined;
  let bestFat = -1;
  for (const enemy of filterActiveEnemies(state, playerId)) {
    const interior = computeLiveInterior(enemy.walls);
    if (interior.size < FINISH_IT_MIN_INTERIOR) continue;
    const fat = countFatWalls(enemy, interior);
    if (fat < FINISH_IT_MIN_FAT_WALLS) continue;
    if (fat > bestFat) {
      bestFat = fat;
      best = { walls: enemy.walls, center: centroidOf(interior) };
    }
  }
  return best;
}

/** Count the enemy's redundant inner walls (every 8-neighbour is own wall or
 *  live interior — `isFatWallTile`, the same predicate declutter uses). */
function countFatWalls(enemy: Player, interior: ReadonlySet<TileKey>): number {
  let fat = 0;
  for (const key of enemy.walls) {
    const { row, col } = unpackTile(key);
    if (isFatWallTile(enemy.walls, interior, row, col)) fat++;
  }
  return fat;
}

/** The exposed outer shell: every wall tile 4-adjacent to the outside flood —
 *  the perimeter a hole directly punctures (deeper inner walls aren't visible
 *  to a demoralising "make holes all around" spray). */
function outerShellWalls(walls: ReadonlySet<TileKey>): TilePos[] {
  const outside = computeOutside(walls);
  const shell: TilePos[] = [];
  for (const key of walls) {
    const { row, col } = unpackTile(key);
    for (const [dr, dc] of DIRS_4) {
      const nr = row + dr;
      const nc = col + dc;
      // Bounds-guard before packTile: an edge wall's off-grid neighbour would
      // otherwise wrap to a bogus tile (and throw under the dev bounds check).
      if (inBounds(nr, nc) && outside.has(packTile(nr, nc))) {
        shell.push({ row, col });
        break;
      }
    }
  }
  return shell;
}

/** Sweep the shell by angle around the castle centre, punching a hole whenever
 *  the cursor has moved ≥ FINISH_IT_MIN_SPACING from the last hole — spaced
 *  holes distributed all the way around, ordered so the chain glides a short
 *  arc between each (spread SET, cheap travel). The start index is rotated by
 *  slot so concurrent attackers don't clone the sweep. No cap: the sweep runs
 *  the whole ring and the battle timer is the natural limiter. */
function spreadAroundRing(
  shell: readonly TilePos[],
  center: TilePos,
  playerId: ValidPlayerId,
): TilePos[] {
  const sorted = [...shell].sort(
    (a, b) =>
      angleFrom(center, a) - angleFrom(center, b) ||
      packTile(a.row, a.col) - packTile(b.row, b.col),
  );
  const start = Math.floor((playerId / SLOT_COUNT) * sorted.length);
  const holes: TilePos[] = [];
  let last: TilePos | undefined;
  for (let i = 0; i < sorted.length; i++) {
    const tile = sorted[(start + i) % sorted.length]!;
    if (
      last === undefined ||
      manhattanDistance(last.row, last.col, tile.row, tile.col) >=
        FINISH_IT_MIN_SPACING
    ) {
      holes.push(tile);
      last = tile;
    }
  }
  return holes;
}

/** Angle (radians) of a tile about the castle centre — the sweep ordering key. */
function angleFrom(center: TilePos, tile: TilePos): number {
  return Math.atan2(tile.row - center.row, tile.col - center.col);
}

/** Mean position of the interior tiles — the sweep's rotation centre. */
function centroidOf(interior: ReadonlySet<TileKey>): TilePos {
  let sumRow = 0;
  let sumCol = 0;
  for (const key of interior) {
    const { row, col } = unpackTile(key);
    sumRow += row;
    sumCol += col;
  }
  const count = interior.size;
  return { row: sumRow / count, col: sumCol / count };
}
