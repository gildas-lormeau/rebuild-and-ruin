/**
 * Shared lightweight geometry/data shapes used by strategy and controller code.
 */

export interface TilePos {
  row: number;
  col: number;
}

export interface PixelPos {
  x: number;
  y: number;
}

export interface TileRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type StrategicPixelPos = PixelPos & { strategic?: boolean };

export type PrioritizedTilePos = TilePos & { priority: boolean };

/** World coordinate in tile-pixel space (as opposed to screen/canvas pixels). */
export interface WorldPos {
  wx: number;
  wy: number;
}
