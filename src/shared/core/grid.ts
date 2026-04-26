/**
 * Grid dimensions and tile type enum.
 *
 * Lives in its own file to break the circular dependency between
 * spatial.ts and map-generation.ts: both need these primitives,
 * and both are needed by each other, so they must come from a
 * third module that depends on neither.
 */

export enum Tile {
  Grass = 0,
  Water = 1,
}

/** True when the game booted on a touch device whose screen is in portrait
 *  orientation. The grid axes flip so the playfield matches the screen
 *  aspect (28×44 portrait vs 44×28 landscape). Resolved once at module
 *  load — orientation changes mid-session do not re-trigger the swap, so
 *  a landscape-launched session that rotates to portrait keeps the
 *  44×28 grid and the side loupe converts to a top loupe via CSS only.
 *  Falsy on Deno/Node where matchMedia is undefined (server + tests). */
export const GRID_PORTRAIT_LAUNCHED: boolean =
  typeof matchMedia === "function" &&
  typeof window !== "undefined" &&
  ("ontouchstart" in window || navigator.maxTouchPoints > 0) &&
  matchMedia("(orientation: portrait)").matches;
/** Grid width in tiles. All packed tile indices across the codebase use:
 *    key = row * GRID_COLS + col
 *  Use packTile(r,c) / unpackTile(key) from spatial.ts — never encode manually. */
export const GRID_COLS = GRID_PORTRAIT_LAUNCHED ? 28 : 44;
export const GRID_ROWS = GRID_PORTRAIT_LAUNCHED ? 44 : 28;
/** Total tile count — upper bound for packed tile indices (row * GRID_COLS + col). */
export const TILE_COUNT = GRID_ROWS * GRID_COLS;
export const TILE_SIZE = 16;
/** Canvas display scale factor (pixel-art 2× upscale). */
export const SCALE = 2;
/** Offscreen-buffer resolution multiplier (1 = base, 2 = hi-dpi via sprites@2x).
 *  Independent of `SCALE` (which is the offscreen → display upscale).
 *  Reads devicePixelRatio at module load in browser environments; falls back
 *  to 1 on Deno/Node (server + headless tests) where the global is absent. */
export const OFFSCREEN_SCALE =
  typeof devicePixelRatio === "number" && devicePixelRatio >= 2 ? 2 : 1;
/** Map dimensions in world-pixels (unscaled). */
export const MAP_PX_W = GRID_COLS * TILE_SIZE;
export const MAP_PX_H = GRID_ROWS * TILE_SIZE;
/** Full canvas backing-store dimensions (pixels). */
export const CANVAS_W = MAP_PX_W * SCALE;
export const CANVAS_H = MAP_PX_H * SCALE;
/** Reserved-top-strip height in world-pixel units. One tile's worth
 *  of empty space ABOVE the playable map. Used by the 3D renderer so
 *  tall wall meshes at row 0 don't clip at the top of the canvas
 *  under battle tilt. World-Y range `[-TOP_MARGIN_MAP_PX, 0)` is the
 *  strip; canvas grows by this amount; all game-area drawing shifts
 *  down so internal tile coordinates are unchanged. May later host
 *  the status-bar HUD (currently disabled in 3D). Literal `1 *
 *  TILE_SIZE` is intentional — keeps the "one tile" semantic explicit
 *  (and avoids knip flagging a same-value alias of TILE_SIZE). */
export const TOP_MARGIN_MAP_PX = 1 * TILE_SIZE;
/** Same strip height at display resolution. Matches STATUSBAR_HEIGHT
 *  by construction (both = TILE_SIZE * SCALE = 32 px). */
export const TOP_MARGIN_CANVAS_PX = TOP_MARGIN_MAP_PX * SCALE;
