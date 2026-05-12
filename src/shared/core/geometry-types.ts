import type { Tile } from "./grid.ts";
import type { ZoneCell, ZoneId } from "./zone-id.ts";

export interface TilePos {
  row: number;
  col: number;
}

export interface PixelPos {
  x: number;
  y: number;
}

/** Tile-grid coordinate with x/y axes (x = column, y = row).
 *  Used for river control points where x/y math is natural;
 *  values may be off-map sentinels (e.g. x: -1 or y: GRID_ROWS)
 *  to mark exits at the map edge. */
export interface TileGridPos {
  x: number;
  y: number;
}

export interface TileRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** World coordinate in tile-pixel space (as opposed to screen/canvas pixels). */
export interface WorldPos {
  wx: number;
  wy: number;
}

/** Index into `GameMap.towers[]` (stable after generation). Branded so a
 *  raw number can't accidentally substitute for one (e.g. a cannon index
 *  or card index of the same shape). */
export type TowerIdx = number & { readonly __towerIdx: true };

export interface Tower extends TilePos {
  zone: ZoneId;
  /** Index into the GameMap.towers array (stable after generation). */
  index: TowerIdx;
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
  zone: ZoneId;
  alive: boolean;
}

export interface GameMap {
  tiles: Tile[][];
  towers: Tower[];
  houses: House[];
  zones: ZoneCell[][];
  junction: TileGridPos;
  exits: TileGridPos[];
  /** Per-arm quadratic-Bezier midpoints used when painting the river,
   *  parallel to `exits`. Stored so consumers (e.g. supply-ship
   *  motion) can re-evaluate the same curve and stay in the painted
   *  water lane. */
  riverMidpoints: TileGridPos[];
  /** Bumped when tiles are mutated in place (e.g., sinkhole).
   *  Render terrain cache uses this to detect stale ImageData. */
  mapVersion: number;
}

/** Viewport rect in tile-pixel coordinates (before SCALE). null = full map. */
export interface Viewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Tile bounding rect — inclusive row/col extremes. */
export interface TileBounds {
  minR: number;
  maxR: number;
  minC: number;
  maxC: number;
}

export interface BonusSquare extends TilePos {
  zone: ZoneId;
}
