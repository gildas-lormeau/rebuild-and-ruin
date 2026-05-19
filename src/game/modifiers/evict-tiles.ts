/**
 * Shared eviction helper for tile-mutating modifiers. Each caller picks
 * the subset of entities its semantics removes — sinkhole/high-tide/low-water
 * all converge here, with slight option differences driven by what kinds
 * of entities could plausibly sit on their target tiles.
 */

import type { TileKey } from "../../shared/core/grid.ts";
import { removeWallFromAllPlayers } from "../../shared/core/player-walls.ts";
import {
  cannonSize,
  filterOffTiles,
  packTile,
} from "../../shared/core/spatial.ts";
import type { GameState } from "../../shared/core/types.ts";

interface EvictOptions {
  readonly walls?: true;
  readonly houses?: true;
  readonly grunts?: true;
  readonly bonusSquares?: true;
  readonly burningPits?: true;
  /** Cannons are evicted when ANY tile of their multi-tile footprint
   *  intersects `tiles`. */
  readonly cannons?: true;
}

/** Remove the requested entity types from any tile in `tiles`. Safe to
 *  call with an empty set (returns immediately). */
export function evictEntitiesOnTiles(
  state: GameState,
  tiles: ReadonlySet<number>,
  opts: EvictOptions,
): void {
  if (tiles.size === 0) return;
  if (opts.walls) {
    for (const key of tiles) removeWallFromAllPlayers(state, key as TileKey);
  }
  if (opts.houses) {
    for (const house of state.map.houses) {
      if (!house.alive) continue;
      if (tiles.has(packTile(house.row, house.col))) house.alive = false;
    }
  }
  if (opts.grunts) {
    state.grunts = filterOffTiles(state.grunts, tiles);
  }
  if (opts.bonusSquares) {
    state.bonusSquares = filterOffTiles(state.bonusSquares, tiles);
  }
  if (opts.burningPits) {
    state.burningPits = filterOffTiles(state.burningPits, tiles);
  }
  if (opts.cannons) {
    for (const player of state.players) {
      player.cannons = player.cannons.filter((cannon) => {
        const size = cannonSize(cannon.mode);
        for (let dr = 0; dr < size; dr++) {
          for (let dc = 0; dc < size; dc++) {
            if (tiles.has(packTile(cannon.row + dr, cannon.col + dc))) {
              return false;
            }
          }
        }
        return true;
      });
    }
  }
}
