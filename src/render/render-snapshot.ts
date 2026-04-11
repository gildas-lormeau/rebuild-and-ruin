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
import { GRID_COLS, Tile } from "../shared/core/grid.ts";

/** Clone a `GameMap` with the modifier-changed tiles overridden to Grass.
 *
 *  Used by `drawBannerPrevScene` so the OLD terrain shows below the banner
 *  sweep line for tile-mutation modifier reveals (high_tide, sinkhole). The
 *  terrain `WeakMap` cache (in render-map.ts) produces a separate cached
 *  image for the new map reference, which gets GC'd when the snapshot drops
 *  out of the bannerCache.
 *
 *  Why Grass for every changed tile: both `applyHighTide` and `applySinkhole`
 *  filter `if (!isGrass(...))` before mutating, so every changed tile was
 *  Grass before the modifier ran. For entity-only modifiers (wildfire,
 *  crumbling_walls, etc.) the live tile is already Grass for these positions,
 *  so the override is a no-op — and we don't need to branch on modifier id.
 *
 *  The returned map shares all non-tile fields with `liveMap`. */
export function buildModifierSnapshotMap(
  liveMap: GameMap,
  changedTiles: readonly number[],
): GameMap {
  const snapshot = liveMap.tiles.map((row) => row.slice());
  for (const key of changedTiles) {
    const r = Math.floor(key / GRID_COLS);
    const c = key % GRID_COLS;
    snapshot[r]![c] = Tile.Grass;
  }
  return { ...liveMap, tiles: snapshot };
}
