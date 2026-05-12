/**
 * High Tide modifier — floods grass tiles adjacent to water (river banks widen by 1 tile).
 * Destroys walls, houses, grunts, bonus squares, burning pits, and cannons on flooded tiles.
 */

import { FID } from "../../shared/core/feature-defs.ts";
import { GRID_COLS, GRID_ROWS, type TileKey } from "../../shared/core/grid.ts";
import type { SerializedModifierTiles } from "../../shared/core/modifier-defs.ts";
import { hasTowerAt } from "../../shared/core/occupancy-queries.ts";
import {
  DIRS_4,
  isGrass,
  isWater,
  packTile,
  setGrass,
  setWater,
  unpackTile,
} from "../../shared/core/spatial.ts";
// (jscpd: high-tide imports are intentionally similar to low-water — same shape, mirror modifiers)
import {
  type GameState,
  hasFeature,
  type ModifierImpl,
} from "../../shared/core/types.ts";
import { recomputeMapZones } from "../zone-recompute.ts";
import { evictEntitiesOnTiles } from "./evict-tiles.ts";

export const highTideImpl: ModifierImpl = {
  lifecycle: "round-scoped",
  apply: (state: GameState) => ({
    changedTiles: [...applyHighTide(state)],
    gruntsSpawned: 0,
  }),
  clear: clearHighTide,
  restore: (state: GameState, data: SerializedModifierTiles) => {
    state.modern!.highTideTiles = data.highTideTiles
      ? new Set(data.highTideTiles as TileKey[])
      : null;
    reapplyHighTideTiles(state);
    recomputeMapZones(state);
  },
};

/** Re-apply high tide tile mutations on a map regenerated from seed.
 *  Called from `restore` during checkpoint hydration. Idempotent.
 *  `mapVersion` is bumped by the caller's `recomputeMapZones`. */
function reapplyHighTideTiles(state: GameState): void {
  const highTide = state.modern?.highTideTiles;
  if (!highTide || highTide.size === 0) return;
  const tiles = state.map.tiles;
  for (const key of highTide) {
    const { r, c } = unpackTile(key as TileKey);
    setWater(tiles, r, c);
  }
}

/** Apply high tide: flood grass tiles adjacent to water. */
function applyHighTide(state: GameState): ReadonlySet<number> {
  const modern = state.modern;
  if (!modern) return new Set();
  const tiles = state.map.tiles;
  const flooded = new Set<TileKey>();
  // Find all grass tiles that are 4-dir adjacent to water
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (!isGrass(tiles, r, c)) continue;
      if (hasTowerAt(state, r, c)) continue;
      for (const [dr, dc] of DIRS_4) {
        if (isWater(tiles, r + dr, c + dc)) {
          flooded.add(packTile(r, c));
          break;
        }
      }
    }
  }
  if (flooded.size === 0) return flooded;
  // Convert to water
  for (const key of flooded) {
    const { r, c } = unpackTile(key as TileKey);
    setWater(tiles, r, c);
  }
  evictEntitiesOnTiles(state, flooded, {
    walls: true,
    houses: true,
    grunts: true,
    bonusSquares: true,
    burningPits: true,
    cannons: true,
  });
  modern.highTideTiles = flooded;
  recomputeMapZones(state);
  return flooded;
}

/** Revert high tide: restore flooded tiles back to grass. */
function clearHighTide(state: GameState): void {
  const modern = state.modern;
  if (!modern || !hasFeature(state, FID.MODIFIERS)) return;
  if (!modern.highTideTiles) return;
  const tiles = state.map.tiles;
  for (const key of modern.highTideTiles) {
    const { r, c } = unpackTile(key as TileKey);
    setGrass(tiles, r, c);
  }
  modern.highTideTiles = null;
  recomputeMapZones(state);
}
