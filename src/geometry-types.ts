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
