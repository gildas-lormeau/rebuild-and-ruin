/**
 * Low Water — exposes a thinned river bank for one round. Tiles stay
 * water; exposed set is RNG-shuffled per draw (varies which segments
 * win the 2×2-preservation contest), stored on
 * `state.modern.exposedRiverbedTiles`, painted via FLAG_EXPOSED. No
 * eviction at apply (water tiles carry no entities) or at clear.
 */

import type { GameMap } from "../../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, type TileKey } from "../../shared/core/grid.ts";
import type { SerializedModifierTiles } from "../../shared/core/modifier-defs.ts";
import {
  DIRS_4,
  isGrass,
  isWater,
  packTile,
  unpackTile,
} from "../../shared/core/spatial.ts";
import { type GameState, type ModifierImpl } from "../../shared/core/types.ts";
import type { Rng } from "../../shared/platform/rng.ts";

export const lowWaterImpl: ModifierImpl = {
  lifecycle: "round-scoped",
  // Tiles stay water — the visual "exposed bank" is a renderer overlay
  // (FLAG_EXPOSED), not a tile-type change. No territory geometry change
  // at apply or clear, so skip the post-apply recheck.
  skipsRecheck: true,
  apply: (state: GameState) => {
    const exposed = computeExposedRiverbedTiles(state.map, state.rng);
    if (exposed.size === 0) {
      return { changedTiles: [], gruntsSpawned: 0 };
    }
    state.modern!.exposedRiverbedTiles = exposed;
    state.map.mapVersion++;
    return { changedTiles: [...exposed], gruntsSpawned: 0 };
  },
  clear: (state: GameState) => {
    if (!state.modern) return;
    if (state.modern.exposedRiverbedTiles === null) return;
    state.modern.exposedRiverbedTiles = null;
    state.map.mapVersion++;
  },
  restore: (state: GameState, data: SerializedModifierTiles) => {
    state.modern!.exposedRiverbedTiles = data.exposedRiverbedTiles
      ? new Set(data.exposedRiverbedTiles as TileKey[])
      : null;
  },
};

/** Greedy 2×2-preserving erosion over RNG-shuffled bank tiles. Each draw
 *  picks a different set of bank tiles to expose because the iteration
 *  order changes — running this multiple times in a game produces
 *  varied exposed strips instead of the same-every-time row-major slice. */
function computeExposedRiverbedTiles(map: GameMap, rng: Rng): Set<TileKey> {
  const tiles = map.tiles;
  const banks: number[] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (!isWater(tiles, r, c)) continue;
      for (const [dr, dc] of DIRS_4) {
        if (isGrass(tiles, r + dr, c + dc)) {
          banks.push(packTile(r, c));
          break;
        }
      }
    }
  }
  rng.shuffle(banks);

  const exposed = new Set<TileKey>();
  for (const key of banks) {
    const { r, c } = unpackTile(key as TileKey);
    // Tentatively expose this tile; revert if it would leave a water
    // neighbor without a 2×2-water anchor (river thinning to 1-wide).
    exposed.add(key as TileKey);
    let safe = true;
    for (const [dr, dc] of DIRS_4) {
      const nr = r + dr;
      const nc = c + dc;
      if (!isWater(tiles, nr, nc)) continue;
      if (exposed.has(packTile(nr, nc) as TileKey)) continue;
      if (!inWater2x2(tiles, exposed, nr, nc)) {
        safe = false;
        break;
      }
    }
    if (!safe) exposed.delete(key as TileKey);
  }
  return exposed;
}

/** True when (r, c) belongs to at least one 2×2 all-still-water square,
 *  where "still water" = water tile not yet in `exposed`. */
function inWater2x2(
  tiles: ReadonlyArray<ReadonlyArray<number>>,
  exposed: ReadonlySet<TileKey>,
  r: number,
  c: number,
): boolean {
  const stillWater = (rr: number, cc: number): boolean =>
    isWater(tiles, rr, cc) && !exposed.has(packTile(rr, cc) as TileKey);
  return (
    (stillWater(r, c + 1) &&
      stillWater(r + 1, c) &&
      stillWater(r + 1, c + 1)) ||
    (stillWater(r, c - 1) &&
      stillWater(r + 1, c) &&
      stillWater(r + 1, c - 1)) ||
    (stillWater(r, c + 1) &&
      stillWater(r - 1, c) &&
      stillWater(r - 1, c + 1)) ||
    (stillWater(r, c - 1) && stillWater(r - 1, c) && stillWater(r - 1, c - 1))
  );
}
