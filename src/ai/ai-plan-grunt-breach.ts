/**
 * AI tactic — grunt breach. Opens the target's tower ring at the seam NEAREST
 * the grunts massed in its zone, so next WALL_BUILD the grunts walk the gap: a
 * grunt on a reseal tile blocks the piece (placement rejects grunt tiles) and
 * a grunt through the gap reaches the tower (grunts are the only tower killers).
 * Unlike deny_enclosure's global min-cut (often nowhere near a grunt), this
 * drill buys a corridor the greedily-pacing grunts will actually funnel through.
 */

import { shouldAbsorbWallHit } from "../game/index.ts";
import type { TilePos } from "../shared/core/geometry-types.ts";
import type { TileKey } from "../shared/core/grid.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import {
  computeOutside,
  DIRS_4,
  inBounds,
  isWater,
  manhattanDistance,
  packTile,
  unpackTile,
  zoneAt,
} from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import type { Rng } from "../shared/platform/rng.ts";
import {
  buildOccupancyCache,
  collectAliveHouseKeys,
  getBattleInterior,
} from "../shared/sim/board-occupancy.ts";
import { rotateBreachForAttacker } from "./ai-attacker-variation.ts";
import { pickTargetEnemy } from "./ai-plan-deny-enclosure.ts";
import {
  componentHoldsTower,
  findEnclosureComponents,
  isEnclosureBroken,
} from "./ai-strategy-battle.ts";

/** A candidate seam: a ring wall (4-adjacent to intact tower-ring interior)
 *  plus the inward direction toward that interior. */
interface Seam {
  row: number;
  col: number;
  /** Cardinal step from the wall INTO the ring interior. */
  inRow: number;
  inCol: number;
}

/** Minimum grunts within walking reach of the seam for the breach to matter:
 *  one grunt is a coin-flip (one sweep shot removes it); two already queue —
 *  the second holds the gap while the first advances on the tower. */
const GRUNT_BREACH_MIN_GRUNTS = 2;
/** Max walls drilled through one seam. A ring thicker than this is cheaper to
 *  open via the min-cut tactics; past it the drill also stops fitting the
 *  low-cannon budget this tactic is gated on. */
const GRUNT_BREACH_MAX_TILES = 4;
/** Max Manhattan distance from the seam's outer mouth to a counted grunt.
 *  Grunts step 1 tile per second and only during WALL_BUILD; the shortest
 *  difficulty timer is 15s, so 14 keeps the corridor reachable within one
 *  build phase on any difficulty (Manhattan lower-bounds the 4-dir walk).
 *  Exported for the phase test's grunt-proximity assertion. */
export const GRUNT_BREACH_MAX_WALK = 14;

/**
 * Plan a grunt breach against `focusEnemyId` (or a uniformly-chosen active
 * enemy): a straight drill through the ring wall nearest that enemy's in-zone
 * grunts. Returns the drill tiles ordered outermost-first (start rotated
 * per-attacker), or null when the target has no intact tower ring, too few
 * grunts in reach, or no drillable seam within the cannon budget.
 */
export function planGruntBreach(
  state: BattleViewState,
  playerId: ValidPlayerId,
  focusEnemyId: ValidPlayerId | undefined,
  usableCannonCount: number,
  rng: Rng,
): TilePos[] | null {
  const cap = Math.min(usableCannonCount, GRUNT_BREACH_MAX_TILES);
  if (cap < 1) return null;
  const enemy = pickTargetEnemy(state, playerId, focusEnemyId, rng);
  if (!enemy) return null;

  const grunts = gruntsInZone(state, enemy.id);
  if (grunts.length < GRUNT_BREACH_MIN_GRUNTS) return null;

  const outside = computeOutside(enemy.walls);
  const rings = findEnclosureComponents(getBattleInterior(enemy)).filter(
    (comp) =>
      componentHoldsTower(comp, enemy) && !isEnclosureBroken(comp, outside),
  );
  if (rings.length === 0) return null;

  const blocked = terminusBlockedSet(state);
  for (const seam of ringWallsByGruntDistance(enemy, rings, grunts)) {
    const drill = drillSeam(state, enemy, seam, outside, blocked, cap, grunts);
    if (drill) return rotateBreachForAttacker(drill, playerId);
  }
  return null;
}

/** Grunts currently in the enemy's zone — the ones that attack ITS towers
 *  (grunts are ownerless; victimhood is standing in your zone). */
function gruntsInZone(
  state: BattleViewState,
  enemyId: ValidPlayerId,
): TilePos[] {
  const zone = state.playerZones[enemyId];
  return state.grunts
    .filter((grunt) => zoneAt(state.map, grunt.row, grunt.col) === zone)
    .map((grunt) => ({ row: grunt.row, col: grunt.col }));
}

/** Every enemy wall cardinally adjacent to an intact tower-ring interior,
 *  sorted nearest-grunt-first (stable key tiebreak) with its inward direction. */
function ringWallsByGruntDistance(
  enemy: Player,
  rings: readonly (readonly TileKey[])[],
  grunts: readonly TilePos[],
): Seam[] {
  const interior = new Set<TileKey>();
  for (const ring of rings) {
    for (const key of ring) interior.add(key);
  }
  const seams: (Seam & { gruntDist: number; key: number })[] = [];
  for (const wallKey of enemy.walls) {
    const { row, col } = unpackTile(wallKey);
    for (const [dr, dc] of DIRS_4) {
      if (!inBounds(row + dr, col + dc)) continue;
      if (!interior.has(packTile(row + dr, col + dc))) continue;
      seams.push({
        row,
        col,
        inRow: dr,
        inCol: dc,
        gruntDist: nearestGruntDistance(grunts, row, col),
        key: wallKey,
      });
      break;
    }
  }
  seams.sort((a, b) => a.gruntDist - b.gruntDist || a.key - b.key);
  return seams;
}

/** Drill outward from the seam wall (away from the interior) collecting the
 *  wall column, and validate the corridor: the mouth must open onto passable
 *  outside ground with enough grunts in walking reach. Returns the drill tiles
 *  mouth-first (the outermost wall is the first shot — it's the exposed one),
 *  or null when the seam doesn't yield a usable corridor. */
function drillSeam(
  state: BattleViewState,
  enemy: Player,
  seam: Seam,
  outside: ReadonlySet<TileKey>,
  blocked: ReadonlySet<TileKey>,
  cap: number,
  grunts: readonly TilePos[],
): TilePos[] | null {
  const walls: TilePos[] = [];
  let row = seam.row;
  let col = seam.col;
  while (inBounds(row, col) && enemy.walls.has(packTile(row, col))) {
    // Reinforced walls absorb the first hit — a drill through one silently
    // costs double, so skip the seam (mirrors findBreachPath).
    if (shouldAbsorbWallHit(enemy, packTile(row, col))) return null;
    walls.push({ row, col });
    if (walls.length > cap) return null;
    row -= seam.inRow;
    col -= seam.inCol;
  }
  // The mouth: first non-wall tile past the drill. It must be true outside
  // ground a grunt can stand on, else the corridor opens onto water/debris
  // (no march) or another pocket (no flood, ring stays enclosed). A drill
  // that walks off the map has no mouth at all.
  if (!inBounds(row, col)) return null;
  const mouthKey = packTile(row, col);
  if (!outside.has(mouthKey)) return null;
  if (isWater(state.map.tiles, row, col) || blocked.has(mouthKey)) return null;
  const inReach = grunts.filter(
    (grunt) =>
      manhattanDistance(grunt.row, grunt.col, row, col) <=
      GRUNT_BREACH_MAX_WALK,
  );
  if (inReach.length < GRUNT_BREACH_MIN_GRUNTS) return null;
  return walls.reverse();
}

/** Tiles a grunt can never stand on at the corridor mouth: towers, cannons
 *  (incl. debris), burning pits, alive houses. Water is checked separately. */
function terminusBlockedSet(state: BattleViewState): Set<TileKey> {
  const cache = buildOccupancyCache(state);
  const blocked = new Set<TileKey>();
  for (const key of cache.towerKeys) blocked.add(key);
  for (const key of cache.cannonKeys) blocked.add(key);
  for (const key of cache.pitKeys) blocked.add(key);
  for (const key of collectAliveHouseKeys(state)) blocked.add(key);
  return blocked;
}

/** Min Manhattan distance from any grunt to the tile. */
function nearestGruntDistance(
  grunts: readonly TilePos[],
  row: number,
  col: number,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (const grunt of grunts) {
    const dist = manhattanDistance(grunt.row, grunt.col, row, col);
    if (dist < best) best = dist;
  }
  return best;
}
