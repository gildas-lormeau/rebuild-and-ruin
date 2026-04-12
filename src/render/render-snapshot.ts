/**
 * Pre-render snapshot construction.
 *
 * Builds throwaway data structures (frozen `GameMap` clones, etc.) that the
 * renderer feeds to its draw functions when it needs to display state that
 * differs from the live game state — typically for transition animations
 * where the OLD scene must be visible alongside the NEW one.
 *
 * This module is intentionally separate from `render-map.ts`:
 *   - render-map.ts is "draw pixels to canvas" — it has no business knowing
 *     about `Tile` enum values directly. It uses spatial helpers everywhere.
 *   - render-snapshot.ts is "produce alternate data for the renderer" — it
 *     legitimately needs `Tile` values to override tile types. Isolated here
 *     so the unusual imports don't pollute the main render module.
 */

import type { GameMap } from "../shared/core/geometry-types.ts";
import { GRID_COLS } from "../shared/core/grid.ts";

/** Clone a `GameMap` with the modifier-changed tiles overridden to `prevTile`.
 *
 *  Used by `drawBannerPrevScene` so the OLD terrain shows below the banner
 *  sweep line for tile-mutation modifier reveals (high_tide, sinkhole). The
 *  terrain `WeakMap` cache in render-map.ts produces a separate cached image
 *  for the new map reference, which gets GC'd when the snapshot drops out of
 *  the bannerCache.
 *
 *  `prevTile` is the modifier's pre-mutation tile value, looked up from
 *  `modifierDef(id).tileMutationPrev` at the call site. Callers MUST NOT
 *  invoke this function for modifiers that don't mutate tiles
 *  (`tileMutationPrev === null`) — the renderer gates on that itself.
 *  Centralising the prev value in `modifier-defs.ts` is what protects against
 *  the frozen_river-class bug where the renderer used to assume `Grass` for
 *  every modifier and would have flashed grass strips over the river.
 *
 *  The returned map shares all non-tile fields with `liveMap`. */
export function buildModifierSnapshotMap(
  liveMap: GameMap,
  changedTiles: readonly number[],
  prevTile: number,
): GameMap {
  const snapshot = liveMap.tiles.map((row) => row.slice());
  for (const key of changedTiles) {
    const r = Math.floor(key / GRID_COLS);
    const c = key % GRID_COLS;
    snapshot[r]![c] = prevTile;
  }
  return { ...liveMap, tiles: snapshot };
}
