/**
 * High Tide — visually floods grass tiles 4-dir adjacent to water for
 * one round. Flooded set is derived from the static map (no tile
 * mutation, no checkpoint state). Mass-evicts every entity class on
 * flooded tiles. House/bonus eviction guards the sinkhole→high_tide
 * chain (see file body).
 */

import { computeFloodedTiles } from "../../shared/core/spatial.ts";
import { type GameState, type ModifierImpl } from "../../shared/core/types.ts";
import { evictEntitiesOnTiles } from "./evict-tiles.ts";

export const highTideImpl: ModifierImpl = {
  lifecycle: "round-scoped",
  // skipsRecheck stays OFF: apply mass-evicts walls in the flooded ring,
  // which can invalidate interior (a removed wall opens enclosure). The
  // default territory recheck after apply is required for correctness.
  apply: (state: GameState) => {
    const flooded = computeFloodedTiles(state.map);
    if (flooded.size === 0) {
      return { changedTiles: [], gruntsSpawned: 0 };
    }
    evictEntitiesOnTiles(state, flooded, {
      walls: true,
      grunts: true,
      burningPits: true,
      cannons: true,
      houses: true,
      bonusSquares: true,
    });
    // Bump so the renderer's tile-data cache invalidates and the shader
    // picks up FLAG_FLOODED on the next frame.
    state.map.mapVersion++;
    return { changedTiles: [...flooded], gruntsSpawned: 0 };
  },
  clear: (state: GameState) => {
    // Bump so FLAG_FLOODED clears in the next frame's tile-data refresh.
    state.map.mapVersion++;
  },
};
