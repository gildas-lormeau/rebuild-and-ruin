/**
 * Shared spatial/geometric helpers used across multiple modules.
 *
 * These are pure functions that operate on tile coordinates and grid keys.
 * Centralised here to avoid scattering utilities across types.ts,
 * phase-build.ts, and other domain-specific modules.
 *
 * ## Tile encoding convention
 *
 * All Set<number> tile collections (walls, interior, frozenTiles, burningPits, etc.)
 * use flat-index encoding: `key = row * GRID_COLS + col`.
 * Always use packTile(r, c) / unpackTile(key) — never encode manually.
 */

import {
  type BurningPit,
  type Cannon,
  CannonMode,
  isBalloonMode,
  isSuperMode,
} from "./battle-types.ts";
import {
  BALLOON_SIZE,
  NORMAL_CANNON_SIZE,
  SUPER_GUN_SIZE,
  TOWER_SIZE,
} from "./game-constants.ts";
import type { PixelPos, TilePos, Tower } from "./geometry-types.ts";
import { GRID_COLS, GRID_ROWS, TILE_SIZE, Tile } from "./grid.ts";
import { Action } from "./input-action.ts";

/** 45° angle step (π/4 radians) — used for 8-direction snapping. */
const FACING_45_STEP = Math.PI / 4;
/** 90° angle step (π/2 radians) — used for 4-direction snapping. */
export const FACING_90_STEP = Math.PI / 2;
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
/** Offset to convert a tile index to the center of that tile (0.5). */
export const TILE_CENTER_OFFSET = 0.5;

/** Call `fn` for each tile of a 2×2 tower footprint. */
export function forEachTowerTile(
  tilePos: TilePos,
  fn: (r: number, c: number, key: number) => void,
): void {
  forEachSquareTile(tilePos.row, tilePos.col, TOWER_SIZE, fn);
}

/** True if (r,c) is within a 2×2 tower footprint. */
export function isTowerTile(tilePos: TilePos, r: number, c: number): boolean {
  return isTileInRect(tilePos.row, tilePos.col, TOWER_SIZE, r, c);
}

/** Return the set of packed tile keys covered by a cannon footprint. */
export function computeCannonTileSet(
  cannon: Pick<Cannon, "row" | "col" | "mode">,
): Set<number> {
  const tiles = new Set<number>();
  forEachCannonTile(cannon, (_r, _c, key) => tiles.add(key));
  return tiles;
}

/** Call `fn` for each tile of a cannon footprint (size based on mode). */
export function forEachCannonTile(
  cannon: Pick<Cannon, "row" | "col" | "mode">,
  fn: (r: number, c: number, key: number) => void,
): void {
  forEachSquareTile(cannon.row, cannon.col, cannonSize(cannon.mode), fn);
}

/** True if (r,c) is within a cannon footprint (size based on mode). */
export function isCannonTile(
  cannon: Pick<Cannon, "row" | "col" | "mode">,
  r: number,
  c: number,
): boolean {
  return isTileInRect(cannon.row, cannon.col, cannonSize(cannon.mode), r, c);
}

/** Manhattan distance from (r,c) to nearest tile of a TOWER_SIZE×TOWER_SIZE tower. */
export function distanceToTower(
  tilePos: TilePos,
  row: number,
  col: number,
): number {
  const dr = Math.max(
    0,
    tilePos.row - row,
    row - (tilePos.row + TOWER_SIZE - 1),
  );
  const dc = Math.max(
    0,
    tilePos.col - col,
    col - (tilePos.col + TOWER_SIZE - 1),
  );
  return dr + dc;
}

/** Center of a cannon footprint in pixels. */
export function cannonCenter(
  cannon: Pick<Cannon, "row" | "col" | "mode">,
): PixelPos {
  const size = cannonSize(cannon.mode);
  return {
    x: (cannon.col + size / 2) * TILE_SIZE,
    y: (cannon.row + size / 2) * TILE_SIZE,
  };
}

/** Center of a tower footprint as INTEGER tile coordinates (rounded).
 *  Use for cursor positioning, packTile(), and grid lookups.
 *  For float math (distance/angle), use towerCenter() instead. */
export function towerCenterTile(tilePos: TilePos): TilePos {
  const center = towerCenter(tilePos);
  return { row: Math.round(center.row), col: Math.round(center.col) };
}

/** Center of a tower footprint as FLOAT tile coordinates (for distance/angle calculations).
 *  For a 2×2 tower at (r,c), returns { row: r+0.5, col: c+0.5 }.
 *  NOT valid as tile indices — use towerCenterTile() if you need integer coordinates. */
export function towerCenter(tilePos: TilePos): {
  row: number;
  col: number;
} {
  const half = TOWER_SIZE / 2;
  return { row: tilePos.row + half - 0.5, col: tilePos.col + half - 0.5 };
}

/** Pixel center of a tower footprint. */
export function towerCenterPx(tilePos: TilePos): PixelPos {
  const half = TOWER_SIZE / 2;
  return {
    x: (tilePos.col + half) * TILE_SIZE,
    y: (tilePos.row + half) * TILE_SIZE,
  };
}

/** Pixel position at the center of the tile at (row, col). */
export function tileCenterPx(row: number, col: number): PixelPos {
  return { x: (col + 0.5) * TILE_SIZE, y: (row + 0.5) * TILE_SIZE };
}

/** True if all 4 tiles of a 2×2 tower are enclosed (not in the outside set). */
export function isTowerEnclosed(
  tilePos: TilePos,
  outside: Set<number>,
): boolean {
  return isSquareEnclosed(tilePos.row, tilePos.col, 2, outside);
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
  tower: Tower,
  walls: ReadonlySet<number>,
  targets?: ReadonlySet<number>,
): boolean {
  const start = packTile(tower.row, tower.col);
  const visited = new Set<number>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const key = queue.pop()!;
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
      queue.push(nk);
    }
  }
  return false;
}

/** Get the tile size of a cannon mode (2 for normal/balloon, 3 for super). */
export function cannonSize(mode: CannonMode): number {
  if (isSuperMode(mode)) return SUPER_GUN_SIZE;
  if (isBalloonMode(mode)) return BALLOON_SIZE;
  return NORMAL_CANNON_SIZE;
}

/** True if a cannon still has hit points remaining. */
export function isCannonAlive(cannon: Pick<Cannon, "hp">): boolean {
  return cannon.hp > 0;
}

/** True if a cannon is a balloon (propaganda balloon). */
export function isBalloonCannon(cannon: {
  mode: CannonMode;
}): cannon is { mode: CannonMode.BALLOON } {
  return isBalloonMode(cannon.mode);
}

/** True if a cannon is a super gun. */
export function isSuperCannon(cannon: {
  mode: CannonMode;
}): cannon is { mode: CannonMode.SUPER } {
  return isSuperMode(cannon.mode);
}

/** True if (r,c) is occupied by a burning pit. */
export function hasPitAt(
  pits: readonly BurningPit[],
  r: number,
  c: number,
): boolean {
  return pits.some((pit) => isAtTile(pit, r, c));
}

/** Count orthogonal wall neighbors of a tile key in a wall set. */
export function countWallNeighbors(
  walls: ReadonlySet<number>,
  r: number,
  c: number,
): number {
  let neighbors = 0;
  if (walls.has(packTile(r - 1, c))) neighbors++;
  if (walls.has(packTile(r + 1, c))) neighbors++;
  if (walls.has(packTile(r, c - 1))) neighbors++;
  if (walls.has(packTile(r, c + 1))) neighbors++;
  return neighbors;
}

/** Compute the facing angle from origin to target, snapped to 45° increments. */
export function computeFacing45(
  ox: number,
  oy: number,
  tx: number,
  ty: number,
): number {
  return snapAngle(Math.atan2(tx - ox, -(ty - oy)), FACING_45_STEP);
}

/** Snap an angle (radians) to the nearest multiple of `step`. */
export function snapAngle(angle: number, step: number): number {
  return Math.round(angle / step) * step;
}

/** Smoothly rotate `current` angle toward `target` angle by at most `maxStep` radians.
 *  Both angles in radians. Takes the shortest path around the circle. */
export function rotateToward(
  current: number,
  target: number,
  maxStep: number,
): number {
  // Normalize difference to [-PI, PI]
  const raw = (target - current) % (Math.PI * 2);
  const diff =
    raw > Math.PI
      ? raw - Math.PI * 2
      : raw < -Math.PI
        ? raw + Math.PI * 2
        : raw;
  if (Math.abs(diff) <= maxStep) return target;
  return current + Math.sign(diff) * maxStep;
}

/** Map a facing angle (radians, 0=up) to the nearest 8-direction name. */
export function facingToDir8(angle: number): string {
  const a = toPositiveAngle(angle);
  const DIRS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
  const idx = Math.round(a / FACING_45_STEP) % 8;
  return DIRS[idx]!;
}

/** Map a facing angle (radians, 0=up) to the nearest cardinal direction name. */
export function facingToCardinal(angle: number): string {
  const a = toPositiveAngle(angle);
  if (a < FACING_45_STEP || a >= 7 * FACING_45_STEP) return "n";
  if (a < 3 * FACING_45_STEP) return "e";
  if (a < 5 * FACING_45_STEP) return "s";
  return "w";
}

/** Find tower nearest to a world coordinate (tile-pixel space). */
export function towerAtPixel(
  towers: readonly TilePos[],
  worldX: number,
  worldY: number,
): number | undefined {
  const tileCol = pxToTile(worldX);
  const tileRow = pxToTile(worldY);

  const HIT_RADIUS = 2;
  let bestIdx: number | undefined;
  let bestDist = Infinity;

  for (let i = 0; i < towers.length; i++) {
    const tower = towers[i]!;
    const dr = tileRow - (tower.row + 0.5);
    const dc = tileCol - (tower.col + 0.5);
    const dist = Math.sqrt(dr * dr + dc * dc);
    if (dist < HIT_RADIUS && dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  return bestIdx;
}

/** Convert a world-pixel coordinate to a tile index (floor division by TILE_SIZE). */
export function pxToTile(px: number): number {
  return Math.floor(px / TILE_SIZE);
}

/** Find the nearest tower to a given tower in a direction (for spatial navigation). */
export function findNearestTower(
  towers: readonly { row: number; col: number; zone: number }[],
  currentIdx: number,
  direction: Action,
  zone?: number,
): number {
  const current = towers[currentIdx]!;
  let bestIdx = currentIdx;
  let bestScore = Infinity;

  for (let i = 0; i < towers.length; i++) {
    if (i === currentIdx) continue;
    const tower = towers[i]!;
    if (zone !== undefined && tower.zone !== zone) continue;
    const dr = tower.row - current.row;
    const dc = tower.col - current.col;

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

/** Order items by greedy nearest-neighbor (Manhattan distance). */
export function orderByNearest<T extends TilePos>(
  items: readonly T[],
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
  walls: ReadonlySet<number>,
  extraBarriers?: ReadonlySet<number>,
): Set<number> {
  const outside = new Set<number>();
  const queue: number[] = [];
  const blocked = (key: number) =>
    walls.has(key) || (extraBarriers !== undefined && extraBarriers.has(key));
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (isBoundaryTile(r, c)) {
        const key = packTile(r, c);
        if (!blocked(key)) {
          outside.add(key);
          queue.push(key);
        }
      }
    }
  }
  while (queue.length > 0) {
    const key = queue.pop()!;
    const { r, c } = unpackTile(key);
    for (const [dr, dc] of DIRS_8) {
      const nr = r + dr,
        nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const nk = packTile(nr, nc);
      if (outside.has(nk) || blocked(nk)) continue;
      outside.add(nk);
      queue.push(nk);
    }
  }
  return outside;
}

/** Convert a packed tile key back to row/column coordinates. */
export function unpackTile(key: number): { r: number; c: number } {
  return { r: Math.floor(key / GRID_COLS), c: key % GRID_COLS };
}

/** True if (r,c) is within bounds and both values are integers (for validating untrusted input). */
export function inBoundsStrict(r: number, c: number): boolean {
  return (
    Number.isInteger(r) &&
    Number.isInteger(c) &&
    r >= 0 &&
    r < GRID_ROWS &&
    c >= 0 &&
    c < GRID_COLS
  );
}

/** True if (r,c) is within the grid bounds. */
export function inBounds(r: number, c: number): boolean {
  return r >= 0 && r < GRID_ROWS && c >= 0 && c < GRID_COLS;
}

/** True if an object's row/col matches the given position. */
export function isAtTile(obj: TilePos, row: number, col: number): boolean {
  return obj.row === row && obj.col === col;
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

function isSquareEnclosed(
  top: number,
  left: number,
  size: number,
  outside: Set<number>,
): boolean {
  for (let dr = 0; dr < size; dr++) {
    for (let dc = 0; dc < size; dc++) {
      if (outside.has(packTile(top + dr, left + dc))) return false;
    }
  }
  return true;
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

/** Pack row/column into a flat tile key (row * GRID_COLS + col).
 *  Use this instead of manual encoding.
 *  Used for all Set<number> tile collections. See unpackTile() for reverse. */
export function packTile(r: number, c: number): number {
  return r * GRID_COLS + c;
}

/** True if tile is on the outer map border. */
function isBoundaryTile(r: number, c: number): boolean {
  return r === 0 || r === GRID_ROWS - 1 || c === 0 || c === GRID_COLS - 1;
}

/** Normalize an angle (radians) to the range [0, 2π). */
function toPositiveAngle(angle: number): number {
  return ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
}

function nearestItemIndex<T extends TilePos>(
  remaining: readonly T[],
  target: TilePos,
): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < remaining.length; i++) {
    const distance = manhattanDistance(
      remaining[i]!.row,
      remaining[i]!.col,
      target.row,
      target.col,
    );
    if (distance < bestDist) {
      bestDist = distance;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Manhattan distance between two tile positions. */
export function manhattanDistance(
  r1: number,
  c1: number,
  r2: number,
  c2: number,
): number {
  return Math.abs(r1 - r2) + Math.abs(c1 - c2);
}
