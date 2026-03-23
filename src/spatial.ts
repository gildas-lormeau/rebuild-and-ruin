/**
 * Shared spatial/geometric helpers used across multiple modules.
 *
 * These are pure functions that operate on tile coordinates and grid keys.
 * Centralised here to avoid scattering utilities across types.ts,
 * build-phase.ts, and other domain-specific modules.
 */

import { GRID_ROWS, GRID_COLS, TILE_SIZE, Tile } from "./grid.ts";
import type { TilePos, PixelPos } from "./geometry-types.ts";
import type { Tower } from "./map-generation.ts";
import type { Cannon, BurningPit } from "./types.ts";
import {
  SUPER_GUN_SIZE,
  NORMAL_CANNON_SIZE,
  BALLOON_SIZE,
  Action,
} from "./types.ts";

/** Cardinal directions: up, down, left, right. */
export const DIRS_4 = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

/** Diagonal directions: SE, SW, NE, NW. */
export const DIRS_DIAG = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

/** All 8 directions (cardinal + diagonal). */
export const DIRS_8 = [...DIRS_4, ...DIRS_DIAG] as const;

/** Top-left corners of all 2x2 squares that contain a given tile. */
export const CORNERS_2X2 = [
  [0, 0],
  [0, -1],
  [-1, 0],
  [-1, -1],
] as const;

// ---------------------------------------------------------------------------
// Grid key helpers
// ---------------------------------------------------------------------------

/** Convert a packed tile key to row/column coordinates. */
export const unpackTile = (key: number): { r: number; c: number } => ({
  r: Math.floor(key / GRID_COLS),
  c: key % GRID_COLS,
});

/** Pack row/column coordinates into a tile key. */
export const packTile = (r: number, c: number): number => r * GRID_COLS + c;

/** Manhattan distance between two tile positions. */
export const manhattanDistance = (
  r1: number,
  c1: number,
  r2: number,
  c2: number,
): number => Math.abs(r1 - r2) + Math.abs(c1 - c2);

// ---------------------------------------------------------------------------
// Tile / footprint helpers
// ---------------------------------------------------------------------------

/** Call `fn` for each tile of a 2×2 tower footprint. */
export function forEachTowerTile(
  t: TilePos,
  fn: (r: number, c: number, key: number) => void,
): void {
  forEachSquareTile(t.row, t.col, 2, fn);
}

function isTileInRect(
  top: number,
  left: number,
  size: number,
  row: number,
  col: number,
): boolean {
  return row >= top && row < top + size && col >= left && col < left + size;
}

function forEachSquareTile(
  top: number,
  left: number,
  size: number,
  fn: (r: number, c: number, key: number) => void,
): void {
  for (let dr = 0; dr < size; dr++) {
    for (let dc = 0; dc < size; dc++) {
      const r = top + dr;
      const c = left + dc;
      fn(r, c, packTile(r, c));
    }
  }
}

function isSquareEnclosed(
  top: number,
  left: number,
  size: number,
  outside: Set<number>,
): boolean {
  let enclosed = true;
  forEachSquareTile(top, left, size, (_r, _c, key) => {
    if (outside.has(key)) enclosed = false;
  });
  return enclosed;
}

/** True if (r,c) is within a 2×2 tower footprint. */
export function isTowerTile(t: TilePos, r: number, c: number): boolean {
  return isTileInRect(t.row, t.col, 2, r, c);
}

/** Call `fn` for each tile of a cannon footprint (2×2 or 3×3 super). */
export function forEachCannonTile(
  cannon: Pick<Cannon, "row" | "col" | "super">,
  fn: (r: number, c: number, key: number) => void,
): void {
  const sz = cannon.super ? 3 : 2;
  forEachSquareTile(cannon.row, cannon.col, sz, fn);
}

/** True if (r,c) is within a cannon footprint (2×2 or 3×3 super). */
export function isCannonTile(
  cannon: Pick<Cannon, "row" | "col" | "super">,
  r: number,
  c: number,
): boolean {
  const sz = cannon.super ? 3 : 2;
  return isTileInRect(cannon.row, cannon.col, sz, r, c);
}

/** Manhattan distance from (r,c) to nearest tile of a 2×2 tower. */
export function distanceToTower(t: TilePos, r: number, c: number): number {
  const dr = Math.max(0, t.row - r, r - (t.row + 1));
  const dc = Math.max(0, t.col - c, c - (t.col + 1));
  return dr + dc;
}

/** Center of a cannon footprint in pixels. */
export function cannonCenter(
  cannon: Pick<Cannon, "row" | "col" | "super" | "balloon">,
): PixelPos {
  const size = cannonSize(cannon);
  return {
    x: (cannon.col + size / 2) * TILE_SIZE,
    y: (cannon.row + size / 2) * TILE_SIZE,
  };
}

/** Center of a 2×2 tower footprint (between the 4 tiles). */
export function towerCenter(t: TilePos): {
  row: number;
  col: number;
} {
  return { row: t.row + 0.5, col: t.col + 0.5 };
}

/** True if all 4 tiles of a 2×2 tower are enclosed (not in the outside set). */
export function isTowerEnclosed(t: TilePos, outside: Set<number>): boolean {
  return isSquareEnclosed(t.row, t.col, 2, outside);
}

/**
 * 4-directional BFS from a tower tile — returns true if the BFS reaches any
 * tile in `targets` without crossing `walls`.  When `targets` is omitted the
 * BFS checks whether it can reach the map border instead.
 *
 * Used to verify enclosure results from the 8-dir `computeOutside` flood:
 *  - pass `outside` set → detects diagonal-only leaks (8-dir says enclosed
 *    but 4-dir path reaches outside)
 *  - pass no targets → detects whether walls form a complete orthogonal ring
 *    even when 8-dir flood leaks through a diagonal gap
 */
export function towerReachesOutsideCardinal(
  t: Tower,
  walls: Set<number>,
  targets?: Set<number>,
): boolean {
  const start = packTile(t.row, t.col);
  const visited = new Set<number>([start]);
  const q = [start];
  while (q.length > 0) {
    const key = q.pop()!;
    const { r: kr, c: kc } = unpackTile(key);
    if (targets) {
      if (targets.has(key)) return true;
    } else {
      if (isBoundaryTile(kr, kc)) return true;
    }
    for (const [dr, dc] of DIRS_4) {
      const nr = kr + dr,
        nc = kc + dc;
      if (!inBounds(nr, nc)) continue;
      const nk = packTile(nr, nc);
      if (visited.has(nk) || walls.has(nk)) continue;
      visited.add(nk);
      q.push(nk);
    }
  }
  return false;
}

/** Get the tile size of a cannon (2 for normal/balloon, 3 for super). */
export function cannonSize(cannon: Pick<Cannon, "super" | "balloon">): number {
  if (cannon.super) return SUPER_GUN_SIZE;
  if (cannon.balloon) return BALLOON_SIZE;
  return NORMAL_CANNON_SIZE;
}

/** True if a cannon still has hit points remaining. */
export function isCannonAlive(cannon: Pick<Cannon, "hp">): boolean {
  return cannon.hp > 0;
}

/** True if (r,c) is occupied by a burning pit. */
export function isPitAt(pits: BurningPit[], r: number, c: number): boolean {
  return pits.some((p) => p.row === r && p.col === c);
}

/** Count orthogonal wall neighbors of a tile key in a wall set. */
export function countWallNeighbors(
  walls: Set<number>,
  r: number,
  c: number,
): number {
  let n = 0;
  if (walls.has(packTile(r - 1, c))) n++;
  if (walls.has(packTile(r + 1, c))) n++;
  if (walls.has(packTile(r, c - 1))) n++;
  if (walls.has(packTile(r, c + 1))) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Angle utilities
// ---------------------------------------------------------------------------

/** Snap an angle (radians) to the nearest multiple of `step`. */
export function snapAngle(angle: number, step: number): number {
  return Math.round(angle / step) * step;
}

/** Compute the facing angle from origin to target, snapped to 45° increments. */
export function computeFacing45(
  ox: number,
  oy: number,
  tx: number,
  ty: number,
): number {
  return snapAngle(Math.atan2(tx - ox, -(ty - oy)), Math.PI / 4);
}

/** Smoothly rotate `current` angle toward `target` angle by at most `maxStep` radians.
 *  Both angles in radians. Takes the shortest path around the circle. */
export function rotateToward(
  current: number,
  target: number,
  maxStep: number,
): number {
  let diff = target - current;
  // Normalize to [-PI, PI]
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) <= maxStep) return target;
  return current + Math.sign(diff) * maxStep;
}

/** Map a facing angle (radians, 0=up) to the nearest 8-direction name. */
export function facingToDir8(angle: number): string {
  const a = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const DIRS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
  const idx = Math.round(a / (Math.PI * 0.25)) % 8;
  return DIRS[idx]!;
}

/** Map a facing angle (radians, 0=up) to the nearest cardinal direction name. */
export function facingToCardinal(angle: number): string {
  const a = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (a < Math.PI * 0.25 || a >= Math.PI * 1.75) return "n";
  if (a < Math.PI * 0.75) return "e";
  if (a < Math.PI * 1.25) return "s";
  return "w";
}

// ---------------------------------------------------------------------------
// Tower spatial queries
// ---------------------------------------------------------------------------

/** Find tower nearest to a world coordinate (tile-pixel space). */
export function towerAtPixel(
  towers: TilePos[],
  worldX: number,
  worldY: number,
): number | null {
  const tileCol = Math.floor(worldX / TILE_SIZE);
  const tileRow = Math.floor(worldY / TILE_SIZE);

  const HIT_RADIUS = 2;
  let bestIdx: number | null = null;
  let bestDist = Infinity;

  for (let i = 0; i < towers.length; i++) {
    const t = towers[i]!;
    const dr = tileRow - (t.row + 0.5);
    const dc = tileCol - (t.col + 0.5);
    const dist = Math.sqrt(dr * dr + dc * dc);
    if (dist < HIT_RADIUS && dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  return bestIdx;
}

/** Find the nearest tower to a given tower in a direction (for spatial navigation). */
export function findNearestTower(
  towers: { row: number; col: number; zone: number }[],
  currentIdx: number,
  direction: Action,
  zone?: number,
): number {
  const current = towers[currentIdx]!;
  let bestIdx = currentIdx;
  let bestScore = Infinity;

  for (let i = 0; i < towers.length; i++) {
    if (i === currentIdx) continue;
    const t = towers[i]!;
    if (zone !== undefined && t.zone !== zone) continue;
    const dr = t.row - current.row;
    const dc = t.col - current.col;

    let primary: number;
    let secondary: number;
    switch (direction) {
      case Action.UP:
        primary = -dr;
        secondary = Math.abs(dc);
        break;
      case Action.DOWN:
        primary = dr;
        secondary = Math.abs(dc);
        break;
      case Action.LEFT:
        primary = -dc;
        secondary = Math.abs(dr);
        break;
      case Action.RIGHT:
        primary = dc;
        secondary = Math.abs(dr);
        break;
      default:
        continue;
    }

    if (primary <= 0) continue;
    const score = secondary * 2 + primary;
    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx;
}

// ---------------------------------------------------------------------------
// General utilities
// ---------------------------------------------------------------------------

/** True if (r,c) is within the grid bounds. */
export function inBounds(r: number, c: number): boolean {
  return r >= 0 && r < GRID_ROWS && c >= 0 && c < GRID_COLS;
}

/** True if tile is on the outer map border. */
export function isBoundaryTile(r: number, c: number): boolean {
  return r === 0 || r === GRID_ROWS - 1 || c === 0 || c === GRID_COLS - 1;
}

function nearestItemIndex<T extends TilePos>(
  remaining: T[],
  target: TilePos,
): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < remaining.length; i++) {
    const d = manhattanDistance(
      remaining[i]!.row,
      remaining[i]!.col,
      target.row,
      target.col,
    );
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Order items by greedy nearest-neighbor (Manhattan distance). */
export function orderByNearest<T extends TilePos>(
  items: T[],
  maxCount?: number,
): T[] {
  if (items.length <= 1) return [...items];
  const ordered = [items[0]!];
  const remaining = items.slice(1);
  const limit = maxCount ?? items.length;
  while (ordered.length < limit && remaining.length > 0) {
    const last = ordered[ordered.length - 1]!;
    const bestIdx = nearestItemIndex(remaining, last);
    ordered.push(remaining[bestIdx]!);
    remaining.splice(bestIdx, 1);
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Territory analysis
// ---------------------------------------------------------------------------

/** True if tile at (r,c) is water. Returns false for out-of-bounds. */
export function isWater(
  tiles: readonly (readonly Tile[])[],
  r: number,
  c: number,
): boolean {
  return tiles[r]?.[c] === Tile.Water;
}

/** True if tile at (r,c) is grass. Returns false for out-of-bounds. */
export function isGrass(
  tiles: readonly (readonly Tile[])[],
  r: number,
  c: number,
): boolean {
  return tiles[r]?.[c] === Tile.Grass;
}

/** Build a set of all water tile keys — use as extra barriers for computeOutside. */
export function waterKeys(tiles: readonly (readonly Tile[])[]): Set<number> {
  const water = new Set<number>();
  for (let r = 0; r < GRID_ROWS; r++)
    for (let c = 0; c < GRID_COLS; c++)
      if (tiles[r]![c] === Tile.Water) water.add(packTile(r, c));
  return water;
}

/** Flood-fill from map edges to find all "outside" tiles (not enclosed by walls).
 *  `extraBarriers` (e.g. water keys) are treated as impassable, like walls. */
export function computeOutside(
  walls: Set<number>,
  extraBarriers?: Set<number>,
): Set<number> {
  const outside = new Set<number>();
  const q: number[] = [];
  const blocked = (key: number) =>
    walls.has(key) || (extraBarriers !== undefined && extraBarriers.has(key));
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (isBoundaryTile(r, c)) {
        const key = packTile(r, c);
        if (!blocked(key)) {
          outside.add(key);
          q.push(key);
        }
      }
    }
  }
  while (q.length > 0) {
    const key = q.pop()!;
    const { r, c } = unpackTile(key);
    for (const [dr, dc] of DIRS_8) {
      const nr = r + dr,
        nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const nk = packTile(nr, nc);
      if (outside.has(nk) || blocked(nk)) continue;
      outside.add(nk);
      q.push(nk);
    }
  }
  return outside;
}
