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

export const TILE_GRASS = Tile.Grass;
export const TILE_WATER = Tile.Water;
export const GRID_COLS = 40;
export const GRID_ROWS = 28;
/** Total tile count — upper bound for packed tile indices (row * GRID_COLS + col). */
export const TILE_COUNT = GRID_ROWS * GRID_COLS;
export const TILE_SIZE = 16;
/** Canvas display scale factor (pixel-art 2× upscale). */
export const SCALE = 2;
/** Full canvas backing-store dimensions (pixels). */
export const CANVAS_W = GRID_COLS * TILE_SIZE * SCALE;
export const CANVAS_H = GRID_ROWS * TILE_SIZE * SCALE;
