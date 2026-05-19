/**
 * Low Water — opposite of high_tide. RNG-shuffled, 2×2-water-preserving
 * riverbed strip behaves as grass for one round: walls placeable, grunts
 * walkable, in-zone via `extraFillable`. Tiles stay water in the array;
 * `state.modern.exposedRiverbedTiles` is the side-set zone-recompute /
 * placement / renderer read. River still blocks cross-zone, and house /
 * bonus / castle-prebuild see water. Clear evicts walls + grunts on it.
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
import { recomputeMapZones } from "../zone-recompute.ts";
import { evictEntitiesOnTiles } from "./evict-tiles.ts";

export const lowWaterImpl: ModifierImpl = {
  lifecycle: "round-scoped",
  // apply / clear extend / retract zone membership via recomputeMapZones,
  // which is the territory-geometry change. The post-apply
  // `recheckTerritory` runs anyway because no `skipsRecheck` is set.
  apply: (state: GameState) => {
    const exposed = computeExposedRiverbedTiles(state.map, state.rng);
    if (exposed.size === 0) {
      return { changedTiles: [], gruntsSpawned: 0 };
    }
    state.modern!.exposedRiverbedTiles = exposed;
    // Zones extend onto exposed tiles so wall-placement zone checks pass
    // and grunts staying within an extended zone aren't classed cross-zone.
    recomputeMapZones(state);
    return { changedTiles: [...exposed], gruntsSpawned: 0 };
  },
  clear: (state: GameState) => {
    const modern = state.modern;
    if (!modern || modern.exposedRiverbedTiles === null) return;
    // River closes — anything that landed on exposed bank during the
    // modifier's life now sits on water. Cannons are impossible here
    // (interior never reaches the river bank), houses/bonus never spawn
    // on exposed tiles, so the only categories to drop are walls and
    // grunts.
    evictEntitiesOnTiles(state, modern.exposedRiverbedTiles, {
      walls: true,
      grunts: true,
    });
    modern.exposedRiverbedTiles = null;
    // Zones retract back to grass-only; mapVersion bumps with it.
    recomputeMapZones(state);
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
  const banks: TileKey[] = [];
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
    const { r, c } = unpackTile(key);
    // Tentatively expose this tile; revert if it would leave a water
    // neighbor without a 2×2-water anchor (river thinning to 1-wide).
    exposed.add(key);
    let safe = true;
    for (const [dr, dc] of DIRS_4) {
      const nr = r + dr;
      const nc = c + dc;
      if (!isWater(tiles, nr, nc)) continue;
      if (exposed.has(packTile(nr, nc))) continue;
      if (!inWater2x2(tiles, exposed, nr, nc)) {
        safe = false;
        break;
      }
    }
    if (!safe) exposed.delete(key);
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
    isWater(tiles, rr, cc) && !exposed.has(packTile(rr, cc));
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
