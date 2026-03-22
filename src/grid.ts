/**
 * Grid dimensions and tile type enum.
 *
 * Lives in its own file to break the circular dependency between
 * spatial.ts and map-generation.ts: both need these primitives,
 * and both are needed by each other, so they must come from a
 * third module that depends on neither.
 */

export const GRID_COLS = 40;
export const GRID_ROWS = 28;
export const TILE_SIZE = 16;
/** Canvas display scale factor (pixel-art 2× upscale). */
export const SCALE = 2;

export enum Tile {
  Grass = 0,
  Water = 1,
}
