/**
 * Shared lightweight geometry/data shapes used by strategy and controller code.
 */

import type { Tile } from "./grid.ts";

/** RGB color tuple. */
export type RGB = [number, number, number];

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

export interface Tower extends TilePos {
  zone: number;
  /** Index into the GameMap.towers array (stable after generation). */
  index: number;
}

export interface Castle {
  /** Interior bounds (inclusive) — the checkerboard territory */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Tower this castle belongs to */
  tower: Tower;
}

export interface House extends TilePos {
  zone: number;
  alive: boolean;
}

export interface GameMap {
  tiles: Tile[][];
  towers: Tower[];
  houses: House[];
  zones: number[][];
  junction: PixelPos;
  exits: PixelPos[];
}
