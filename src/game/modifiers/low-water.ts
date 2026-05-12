/**
 * Low Water modifier — converts all shallow river-edge tiles to grass
 * (river banks narrow by 1 tile). Mirror of high tide.
 */

import { FID } from "../../shared/core/feature-defs.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  type Tile,
  type TileKey,
} from "../../shared/core/grid.ts";
import type { SerializedModifierTiles } from "../../shared/core/modifier-defs.ts";
// jscpd:ignore-start
import {
  DIRS_4,
  isGrass,
  isWater,
  packTile,
  setGrass,
  setWater,
  unpackTile,
} from "../../shared/core/spatial.ts";
import {
  type GameState,
  hasFeature,
  type ModifierImpl,
} from "../../shared/core/types.ts";
import { recomputeMapZones } from "../zone-recompute.ts";
import { evictEntitiesOnTiles } from "./evict-tiles.ts";

export const lowWaterImpl: ModifierImpl = {
  lifecycle: "round-scoped",
  apply: (state: GameState) => ({
    changedTiles: [...applyLowWater(state)],
    gruntsSpawned: 0,
  }),
  clear: clearLowWater,
  restore: (state: GameState, data: SerializedModifierTiles) => {
    state.modern!.lowWaterTiles = data.lowWaterTiles
      ? new Set(data.lowWaterTiles as TileKey[])
      : null;
    reapplyLowWaterTiles(state);
    recomputeMapZones(state);
  },
};

/** Re-apply low water tile mutations on a map regenerated from seed.
 *  Called from `restore` during checkpoint hydration. Idempotent.
 *  `mapVersion` is bumped by the caller's `recomputeMapZones`. */
function reapplyLowWaterTiles(state: GameState): void {
  const lowWater = state.modern?.lowWaterTiles;
  if (!lowWater || lowWater.size === 0) return;
  const tiles = state.map.tiles;
  for (const key of lowWater) {
    const { r, c } = unpackTile(key as TileKey);
    setGrass(tiles, r, c);
  }
}

/** Apply low water: erode one layer of bank tiles, preserving 2×2 water
 *  blocks so the river never thins to a 1-wide channel. */
function applyLowWater(state: GameState): ReadonlySet<number> {
  const modern = state.modern;
  if (!modern) return new Set();
  const tiles = state.map.tiles;
  const converted = new Set<TileKey>();
  // Snapshot bank tiles before any mutations.
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
  // Greedy erosion: convert each bank tile only if every remaining water
  // neighbor still belongs to at least one 2×2 water block afterwards.
  for (const key of banks) {
    const { r, c } = unpackTile(key as TileKey);
    if (!isWater(tiles, r, c)) continue;
    // Tentatively convert
    setGrass(tiles, r, c);
    // Check all water neighbors still have a 2×2
    let safe = true;
    for (const [dr, dc] of DIRS_4) {
      const nr = r + dr;
      const nc = c + dc;
      if (!isWater(tiles, nr, nc)) continue;
      if (!inWater2x2(tiles, nr, nc)) {
        safe = false;
        break;
      }
    }
    if (safe) {
      converted.add(key as TileKey);
    } else {
      // Revert
      setWater(tiles, r, c);
    }
  }
  if (converted.size === 0) return converted;
  modern.lowWaterTiles = converted;
  recomputeMapZones(state);
  return converted;
}

/** True when (r,c) belongs to at least one 2×2 all-water square. */
function inWater2x2(
  tiles: readonly (readonly Tile[])[],
  r: number,
  c: number,
): boolean {
  return (
    (isWater(tiles, r, c + 1) &&
      isWater(tiles, r + 1, c) &&
      isWater(tiles, r + 1, c + 1)) ||
    (isWater(tiles, r, c - 1) &&
      isWater(tiles, r + 1, c) &&
      isWater(tiles, r + 1, c - 1)) ||
    (isWater(tiles, r, c + 1) &&
      isWater(tiles, r - 1, c) &&
      isWater(tiles, r - 1, c + 1)) ||
    (isWater(tiles, r, c - 1) &&
      isWater(tiles, r - 1, c) &&
      isWater(tiles, r - 1, c - 1))
  );
}

/** Revert low water: restore converted tiles back to water. */
function clearLowWater(state: GameState): void {
  const modern = state.modern;
  if (!modern || !hasFeature(state, FID.MODIFIERS)) return;
  if (!modern.lowWaterTiles) return;
  const tiles = state.map.tiles;
  for (const key of modern.lowWaterTiles) {
    const { r, c } = unpackTile(key as TileKey);
    setWater(tiles, r, c);
  }
  // Houses and bonus squares never spawned on these tiles (they were
  // water at map-gen time), so no need to evict them.
  evictEntitiesOnTiles(state, modern.lowWaterTiles, {
    walls: true,
    grunts: true,
    burningPits: true,
    cannons: true,
  });
  modern.lowWaterTiles = null;
  recomputeMapZones(state);
}
