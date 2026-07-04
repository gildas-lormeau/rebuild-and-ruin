/**
 * AI tactic — pinch kill. The `findMinBreach` min-cut breach of an enemy whose
 * reseal we VERIFY is forced through an obstacle-flanked slot only a small
 * piece (1×1/1×2/1×3) can fill — a kill, not a refillable tax. This adds the
 * reseal check so `planBattle` fires it at top offensive priority (behind the
 * per-player `PINCH_KILL_PROBABILITY` roll that desyncs multiple attackers).
 */

import { TOWER_SIZE } from "../shared/core/game-constants.ts";
import type { TilePos } from "../shared/core/geometry-types.ts";
import { type Tile, type TileKey } from "../shared/core/grid.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import {
  DIRS_4,
  inBounds,
  isWater,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import type { Rng } from "../shared/platform/rng.ts";
import {
  buildOccupancyCache,
  collectAliveHouseKeys,
  filterActiveEnemies,
} from "../shared/sim/board-occupancy.ts";
import { findEnclosureCut } from "./ai-min-cut.ts";
import { findMinBreach } from "./ai-strategy-battle.ts";

/** Max breach holes fired in one chain (also the per-search cost cap). */
const MAX_PINCH_TARGETS = 8;
/** A tetromino covers 4 cells; a buildable island smaller than this admits only
 *  the rare 1×1 / 1×2 / 1×3 (or corner) pieces — the small-piece-only reseal
 *  that turns a breach into a kill rather than a refillable tax. */
const SMALL_PIECE_ISLAND = 4;

/** Plan a guaranteed pinch kill: the min-cut breach of the first enemy whose
 *  reseal it forces through a small-piece-only slot. The enemy scan order is
 *  shuffled per attacker (rng never GATES the kill — whenever any enemy is
 *  pinchable, a pinch still fires) and the min-cut seam pick inside
 *  `findMinBreach` is rng-varied, so two attackers no longer converge on the
 *  identical victim + cut. Returns null when no enemy's cheapest breach leaves
 *  an unrefillable reseal. */
export function planPinchKill(
  state: BattleViewState,
  playerId: ValidPlayerId,
  usableCannonCount: number,
  rng: Rng,
): TilePos[] | null {
  const cap = Math.min(usableCannonCount, MAX_PINCH_TARGETS);
  if (cap < 1) return null;
  const enemies = [...filterActiveEnemies(state, playerId)];
  rng.shuffle(enemies);
  for (const enemy of enemies) {
    if (enemy.enclosedTowers.length === 0) continue;
    const breach = findMinBreach(state, enemy, cap, rng);
    if (!breach || breach.length === 0) continue;
    if (forcesSmallPieceReseal(state, enemy, breach)) return breach;
  }
  return null;
}

/** True when, after the breach walls are gone, at least one of the enemy's
 *  alive enclosed towers can only be re-enclosed by placing a piece in a
 *  buildable island smaller than a tetromino (or cannot be re-enclosed at all). */
function forcesSmallPieceReseal(
  state: BattleViewState,
  enemy: Player,
  breach: readonly TilePos[],
): boolean {
  const removed = new Set<TileKey>(
    breach.map((tile) => packTile(tile.row, tile.col)),
  );
  const reducedWalls = new Set<TileKey>();
  for (const key of enemy.walls) {
    if (!removed.has(key)) reducedWalls.add(key);
  }
  const blocked = buildableBlockedSet(state, removed);

  for (const tower of enemy.enclosedTowers) {
    if (!state.towerAlive[tower.index]) continue;
    const interior = {
      top: tower.row,
      bottom: tower.row + TOWER_SIZE - 1,
      left: tower.col,
      right: tower.col + TOWER_SIZE - 1,
    };
    // Cheapest ring the defender could rebuild against the post-breach walls.
    // null = unenclosable (the strongest kill); empty = the breach didn't open
    // this tower (its ring was elsewhere) — not the lever.
    const cut = findEnclosureCut(
      [{ tower, interior }],
      state,
      reducedWalls,
      false,
    );
    if (cut === null) return true;
    if (cut.size === 0) continue;
    for (const key of cut) {
      const { row, col } = unpackTile(key);
      if (
        resealIslandSize(blocked, state.map.tiles, row, col) <
        SMALL_PIECE_ISLAND
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Tiles a reseal piece can't cover: every wall left after the breach, plus all
 *  towers / cannons / debris / pits / grunts / alive houses. The breach holes
 *  are excluded — they become buildable ground the defender can refill. */
function buildableBlockedSet(
  state: BattleViewState,
  removed: ReadonlySet<TileKey>,
): Set<TileKey> {
  const cache = buildOccupancyCache(state);
  const blocked = new Set<TileKey>();
  for (const key of cache.wallKeys) {
    if (!removed.has(key)) blocked.add(key);
  }
  for (const key of cache.towerKeys) blocked.add(key);
  for (const key of cache.cannonKeys) blocked.add(key);
  for (const key of cache.gruntKeys) blocked.add(key);
  for (const key of cache.pitKeys) blocked.add(key);
  for (const key of collectAliveHouseKeys(state)) blocked.add(key);
  return blocked;
}

/** Size of the 4-connected buildable-ground island containing `(row, col)`,
 *  capped at `SMALL_PIECE_ISLAND`. Buildable = in bounds, not water, not in the
 *  blocked set. A tetromino is 4-connected, so an island below the cap fits no
 *  tetromino — only a small piece. */
function resealIslandSize(
  blocked: ReadonlySet<TileKey>,
  tiles: readonly (readonly Tile[])[],
  row: number,
  col: number,
): number {
  const start = packTile(row, col);
  const seen = new Set<TileKey>([start]);
  const stack: [number, number][] = [[row, col]];
  while (stack.length > 0 && seen.size < SMALL_PIECE_ISLAND) {
    const [cr, cc] = stack.pop()!;
    for (const [dr, dc] of DIRS_4) {
      const nr = cr + dr;
      const nc = cc + dc;
      if (!inBounds(nr, nc)) continue;
      const key = packTile(nr, nc);
      if (seen.has(key) || blocked.has(key) || isWater(tiles, nr, nc)) continue;
      seen.add(key);
      stack.push([nr, nc]);
    }
  }
  return seen.size;
}
