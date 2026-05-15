/**
 * High Tide modifier — visually floods grass tiles adjacent to water for
 * one round. Flooded set is derived from the static map
 * (`computeFloodedTiles`), so apply doesn't mutate tiles and clear has
 * nothing to revert. Mass-evicts walls + cannons + burning pits + grunts
 * in the ring; houses + bonus skipped (placement margin keeps them off).
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
