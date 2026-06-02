/**
 * Shared spatial/geometric helpers — pure functions on tile coordinates
 * and grid keys. Tile encoding for every `Set<number>` collection (walls,
 * interior, frozenTiles, burningPits…): `key = row * GRID_COLS + col`.
 * Always go through `packTile(r, c)` / `unpackTile(key)` — never encode
 * manually.
 */

import { type BurningPit, type Cannon, CannonMode } from "./battle-types.ts";
import { cannonModeDef } from "./cannon-mode-defs.ts";
import { TOWER_SIZE } from "./game-constants.ts";
import type {
  GameMap,
  PixelPos,
  TileBounds,
  TilePos,
  Tower,
  TowerIdx,
} from "./geometry-types.ts";
import { GRID_COLS, GRID_ROWS, TILE_SIZE, Tile, type TileKey } from "./grid.ts";
import type { ValidPlayerId } from "./player-slot.ts";
import { type Player, playerByZone } from "./player-types.ts";
import type { ZoneCell, ZoneId } from "./zone-id.ts";

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

/** Return the set of packed tile keys covered by a cannon footprint. */
export function computeCannonTileSet(
  cannon: Pick<Cannon, "row" | "col" | "mode">,
): Set<TileKey> {
  const tiles = new Set<TileKey>();
  forEachCannonTile(cannon, (_r, _c, key) => tiles.add(key));
  return tiles;
}

/** Call `fn` for each tile of a cannon footprint (size based on mode).
 *
 *  lint:allow-callback-inversion -- iterator HOF: callback runs per tile,
 *  no return value feeds back into iteration logic. */
export function forEachCannonTile(
  cannon: Pick<Cannon, "row" | "col" | "mode">,
  callback: (r: number, c: number, key: TileKey) => void,
): void {
  forEachSquareTile(cannon.row, cannon.col, cannonSize(cannon.mode), callback);
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

/** Pixel center of the home tower owned by the player in `zone`, or null
 *  if no player occupies that zone or the player has no tower. */
export function zoneTowerCenterPx(
  playerZones: readonly ZoneId[],
  players: readonly ({ homeTower: Tower | null } | null | undefined)[],
  zone: ZoneId,
): PixelPos | null {
  const pid = playerByZone(playerZones, zone);
  const tower = pid !== undefined ? players[pid]?.homeTower : null;
  return tower ? towerCenterPx(tower) : null;
}

/** Pixel position at the center of the tile at (row, col). */
export function tileCenterPx(row: number, col: number): PixelPos {
  return { x: (col + 0.5) * TILE_SIZE, y: (row + 0.5) * TILE_SIZE };
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
  walls: ReadonlySet<TileKey>,
  targets?: ReadonlySet<TileKey>,
): boolean {
  const start = packTile(tower.row, tower.col);
  const visited = new Set<TileKey>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const key = queue.pop()!;
    const { row: kr, col: kc } = unpackTile(key);
    if (targets) {
      if (targets.has(key)) return true;
    } else {
      if (isBoundaryTile(kr, kc)) return true;
    }
    for (const [dr, dc] of DIRS_4) {
      const nr = kr + dr,
        nc = kc + dc;
      if (!inBounds(nr, nc)) continue;
      const neighborKey = packTile(nr, nc);
      if (visited.has(neighborKey) || walls.has(neighborKey)) continue;
      visited.add(neighborKey);
      queue.push(neighborKey);
    }
  }
  return false;
}

/** Get the tile size of a cannon mode (2 for normal/balloon, 3 for super). */
export function cannonSize(mode: CannonMode): number {
  return cannonModeDef(mode).size;
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
  walls: ReadonlySet<TileKey>,
  r: number,
  c: number,
): number {
  let neighbors = 0;
  if (r - 1 >= 0 && walls.has(packTile(r - 1, c))) neighbors++;
  if (r + 1 < GRID_ROWS && walls.has(packTile(r + 1, c))) neighbors++;
  if (c - 1 >= 0 && walls.has(packTile(r, c - 1))) neighbors++;
  if (c + 1 < GRID_COLS && walls.has(packTile(r, c + 1))) neighbors++;
  return neighbors;
}

/** Snap an angle (radians) to the nearest multiple of `step`. */
export function snapAngle(angle: number, step: number): number {
  return Math.round(angle / step) * step;
}

/** Find tower nearest to a world coordinate (tile-pixel space). */
export function towerAtPixel(
  towers: readonly TilePos[],
  worldX: number,
  worldY: number,
): TowerIdx | undefined {
  const tileCol = pxToTile(worldX);
  const tileRow = pxToTile(worldY);

  const HIT_RADIUS = 2;
  let bestIdx: TowerIdx | undefined;
  let bestDist = Infinity;

  for (let i = 0; i < towers.length; i++) {
    const tower = towers[i]!;
    const dr = tileRow - (tower.row + 0.5);
    const dc = tileCol - (tower.col + 0.5);
    const dist = Math.sqrt(dr * dr + dc * dc);
    if (dist < HIT_RADIUS && dist < bestDist) {
      bestDist = dist;
      bestIdx = i as TowerIdx;
    }
  }

  return bestIdx;
}

/** Drop every item whose tile lies inside `tiles`. */
export function filterOffTiles<T extends TilePos>(
  items: readonly T[],
  tiles: ReadonlySet<TileKey>,
): T[] {
  return items.filter((item) => !tiles.has(packTile(item.row, item.col)));
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

/** True if all 8 neighbors of (r,c) are in-bounds and non-water — i.e. a
 *  player can build a wall ring around the tile to enclose it. Used by
 *  placement predicates for houses, bonus squares, and modifier pits. */
export function hasEnclosableMargin(
  tiles: readonly (readonly Tile[])[],
  r: number,
  c: number,
): boolean {
  for (const [dr, dc] of DIRS_8) {
    const nr = r + dr;
    const nc = c + dc;
    if (!inBounds(nr, nc)) return false;
    if (isWater(tiles, nr, nc)) return false;
  }
  return true;
}

/** Mutate a tile to water. Used by sinkhole modifier for permanent terrain changes. */
export function setWater(tiles: Tile[][], r: number, c: number): void {
  tiles[r]![c] = Tile.Water;
}

/** Mutate a tile to grass. Used to revert sinkholes on dead player zones. */
export function setGrass(tiles: Tile[][], r: number, c: number): void {
  tiles[r]![c] = Tile.Grass;
}

/** Per-tile membership test for the high_tide flooded ring — the
 *  point-wise version of `computeFloodedTiles`. Use this in hot loops
 *  (grunt pathfinding) to avoid building the whole set; callers that
 *  iterate every flooded tile (renderer, eviction) should still build
 *  the set once via `computeFloodedTiles`. */
export function isFloodedTile(map: GameMap, r: number, c: number): boolean {
  if (!isGrass(map.tiles, r, c)) return false;
  for (const [dr, dc] of DIRS_4) {
    if (isWater(map.tiles, r + dr, c + dc)) {
      // Towers occupy grass tiles; the flood ring excludes them.
      for (const tower of map.towers) {
        if (isTowerTile(tower, r, c)) return false;
      }
      return true;
    }
  }
  return false;
}

/** True if (r,c) is within a 2×2 tower footprint. */
export function isTowerTile(tilePos: TilePos, r: number, c: number): boolean {
  return isTileInRect(tilePos.row, tilePos.col, TOWER_SIZE, r, c);
}

/** Pure function of the static map: every grass tile 4-dir adjacent to
 *  water, minus tiles occupied by a 2×2 tower footprint. This is exactly
 *  the set high_tide marks as flooded — derivable instead of stored, so
 *  no checkpoint/wire round-trip and no host/watcher serialization gap.
 *  O(GRID_ROWS·GRID_COLS); call from each consumer that needs the whole
 *  set (renderer tile-data, apply-time eviction). Per-tile callers
 *  (grunt-movement) should use `isFloodedTile` instead. */
export function computeFloodedTiles(map: GameMap): Set<TileKey> {
  const towerTiles = new Set<TileKey>();
  for (const tower of map.towers) {
    forEachTowerTile(tower, (_r, _c, key) => towerTiles.add(key));
  }
  const flooded = new Set<TileKey>();
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (!isGrass(map.tiles, r, c)) continue;
      const key = packTile(r, c);
      if (towerTiles.has(key)) continue;
      for (const [dr, dc] of DIRS_4) {
        if (isWater(map.tiles, r + dr, c + dc)) {
          flooded.add(key);
          break;
        }
      }
    }
  }
  return flooded;
}

/** Call `fn` for each tile of a 2×2 tower footprint.
 *
 *  lint:allow-callback-inversion -- iterator HOF (see forEachCannonTile). */
export function forEachTowerTile(
  tilePos: TilePos,
  callback: (r: number, c: number, key: TileKey) => void,
): void {
  forEachSquareTile(tilePos.row, tilePos.col, TOWER_SIZE, callback);
}

/** True if tile at (r,c) is grass. Returns false for out-of-bounds. */
export function isGrass(
  tiles: readonly (readonly Tile[])[],
  r: number,
  c: number,
): boolean {
  return tiles[r]?.[c] === Tile.Grass;
}

/** True if tile at (r,c) is water. Returns false for out-of-bounds. */
export function isWater(
  tiles: readonly (readonly Tile[])[],
  r: number,
  c: number,
): boolean {
  return tiles[r]?.[c] === Tile.Water;
}

/** Flood-fill from map edges to find all "outside" tiles (not enclosed by walls). */
export function computeOutside(walls: ReadonlySet<TileKey>): Set<TileKey> {
  const outside = new Set<TileKey>();
  // Parallel queues for r/c — avoids per-dequeue object allocation from unpackTile.
  const queueR: number[] = [];
  const queueC: number[] = [];
  // Seed boundary tiles directly (4 edges) instead of scanning the full grid.
  // Top + bottom rows.
  for (let c = 0; c < GRID_COLS; c++) {
    const topKey = c as TileKey; // packTile(0, c)
    if (!walls.has(topKey)) {
      outside.add(topKey);
      queueR.push(0);
      queueC.push(c);
    }
    if (GRID_ROWS > 1) {
      const botR = GRID_ROWS - 1;
      const botKey = (botR * GRID_COLS + c) as TileKey;
      if (!walls.has(botKey)) {
        outside.add(botKey);
        queueR.push(botR);
        queueC.push(c);
      }
    }
  }
  // Left + right columns (excluding corners — already covered above).
  for (let r = 1; r < GRID_ROWS - 1; r++) {
    const leftKey = (r * GRID_COLS) as TileKey;
    if (!walls.has(leftKey)) {
      outside.add(leftKey);
      queueR.push(r);
      queueC.push(0);
    }
    if (GRID_COLS > 1) {
      const rightC = GRID_COLS - 1;
      const rightKey = (r * GRID_COLS + rightC) as TileKey;
      if (!walls.has(rightKey)) {
        outside.add(rightKey);
        queueR.push(r);
        queueC.push(rightC);
      }
    }
  }
  while (queueR.length > 0) {
    const r = queueR.pop()!;
    const c = queueC.pop()!;
    forEachNeighbor8(r, c, (neighborR, neighborC, neighborKey) => {
      if (outside.has(neighborKey)) return;
      if (walls.has(neighborKey)) return;
      outside.add(neighborKey);
      queueR.push(neighborR);
      queueC.push(neighborC);
    });
  }
  return outside;
}

/** Incrementally compute the outside set after adding new walls.
 *  Equivalent to `computeOutside(baselineWalls ∪ newWallTiles)` but skips
 *  re-flooding regions far from the added walls. Hot path for AI candidate
 *  scoring, which evaluates many small wall additions against the same baseline.
 *
 *  Requires `baselineOutside === computeOutside(baselineWalls)`. */
export function computeOutsideAfterAdd(
  baselineOutside: ReadonlySet<TileKey>,
  newWallTiles: readonly TileKey[],
): Set<TileKey> {
  const trapped = computeTrappedAfterAdd(baselineOutside, newWallTiles);
  const newOutside = new Set(baselineOutside);
  for (let i = 0; i < newWallTiles.length; i++) {
    newOutside.delete(newWallTiles[i]!);
  }
  for (let i = 0; i < trapped.length; i++) {
    newOutside.delete(trapped[i]!);
  }
  return newOutside;
}

/** Find tiles that lose boundary connectivity when `newWallTiles` are added.
 *
 *  Like `computeOutsideAfterAdd` but skips the O(baselineOutside.size) clone
 *  of the outside set — useful when the caller only needs to know whether
 *  any trap occurs (the common case is no trap, where the clone would be
 *  pure waste). The returned array is empty when no traps occur.
 *
 *  Inlines the neighbor walk and barrier checks (rather than using the
 *  `forEachNeighbor8` callback helper) — the closure-call overhead added
 *  up to hundreds of ms across a single seed's run in profiling. */
export function computeTrappedAfterAdd(
  baselineOutside: ReadonlySet<TileKey>,
  newWallTiles: readonly TileKey[],
): TileKey[] {
  const trapped: TileKey[] = [];
  const newWallSet = new Set(newWallTiles);
  // Only baseline-outside neighbors of the new walls can lose their boundary
  // path — every other tile keeps its existing connection.
  const suspects: TileKey[] = [];
  for (let i = 0; i < newWallTiles.length; i++) {
    const tile = newWallTiles[i]!;
    const r = (tile / GRID_COLS) | 0;
    const c = tile - r * GRID_COLS;
    for (let dirIdx = 0; dirIdx < 8; dirIdx++) {
      const dir = DIRS_8[dirIdx]!;
      const nr = r + dir[0];
      const nc = c + dir[1];
      if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
      const neighborKey = (nr * GRID_COLS + nc) as TileKey;
      if (newWallSet.has(neighborKey)) continue;
      if (!baselineOutside.has(neighborKey)) continue;
      suspects.push(neighborKey);
    }
  }
  if (suspects.length === 0) return trapped;
  // Flood each suspect's outside component. A component touching the map edge
  // stays outside; one that doesn't is now trapped. We stop a flood the instant
  // it proves boundary-connected, so the common "no new enclosure" case is a
  // short walk to the nearest edge instead of an O(outside-region) flood.
  //
  // `boundaryConnected` records tiles already proven to reach the edge. It is
  // load-bearing for correctness: an early-exited flood only partially marks
  // its component `visited`, so a later suspect in the SAME component re-floods
  // the remainder — without this set it could miss the (already-consumed) edge
  // tile and be misclassified as trapped. A flood that reaches any
  // boundary-connected tile concludes immediately. The resulting `trapped` set
  // is identical to a full flood: boundary components never contribute, and
  // trapped components (no edge tile) still run to completion in the same order.
  const visited = new Set<TileKey>();
  const boundaryConnected = new Set<TileKey>();
  for (let seedIdx = 0; seedIdx < suspects.length; seedIdx++) {
    const seed = suspects[seedIdx]!;
    if (visited.has(seed)) continue;
    const { reachesBoundary, componentTiles } = floodOutsideComponent(
      seed,
      baselineOutside,
      newWallSet,
      visited,
      boundaryConnected,
    );
    if (reachesBoundary) {
      for (let t = 0; t < componentTiles.length; t++) {
        boundaryConnected.add(componentTiles[t]!);
      }
    } else {
      for (let t = 0; t < componentTiles.length; t++) {
        trapped.push(componentTiles[t]!);
      }
    }
  }
  return trapped;
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

/** Return the player id owning the zone at (row, col), or `0` if no
 *  owner found (water, unassigned zone, eliminated slot). Uses
 *  `playerZones` (stable across elimination) rather than `homeTower`
 *  (nulled on elimination). Thin glue over `zoneAt` + `playerByZone` —
 *  the fall-back-to-0 convention is preserved for rendering callers
 *  that want a non-undefined `ValidPlayerId`. */
export function zoneOwnerIdAt(
  state: { readonly map: GameMap; readonly playerZones: readonly ZoneId[] },
  row: number,
  col: number,
): ValidPlayerId {
  const zone = zoneAt(state.map, row, col);
  if (zone === undefined) return 0 as ValidPlayerId;
  return (playerByZone(state.playerZones, zone) ?? 0) as ValidPlayerId;
}

/** Boundary helper: read a cell from `map.zones` and return it as a `ZoneId`,
 *  or `undefined` for out-of-bounds and water cells (the `0` sentinel).
 *  All grid reads should go through this so the water sentinel cannot leak
 *  into APIs expecting a validated zone id. */
export function zoneAt(
  map: GameMap,
  row: number,
  col: number,
): ZoneId | undefined {
  const cell = map.zones[row]?.[col];
  return cell === undefined || cell === 0 ? undefined : cell;
}

/** Inclusive tile bounding box of every cell assigned to `zone`, or null when
 *  the zone owns no tiles. Lets placement scans skip the whole grid and only
 *  visit a player's own zone — anchors outside this box always have an
 *  out-of-zone tile, so they fail placement regardless. Zones are static for a
 *  match except when a modifier recomputes them (low_water). */
export function zoneTileBounds(map: GameMap, zone: ZoneId): TileBounds | null {
  let minR = GRID_ROWS;
  let maxR = -1;
  let minC = GRID_COLS;
  let maxC = -1;
  for (let r = 0; r < map.zones.length; r++) {
    const rowCells = map.zones[r]!;
    for (let c = 0; c < rowCells.length; c++) {
      if (rowCells[c] === zone) {
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
      }
    }
  }
  return maxR < 0 ? null : { minR, maxR, minC, maxC };
}

/** Pixel center of the castle owned by the player in `zoneId`: bounding
 *  box of (walls ∪ home tower). Falls back to home tower alone when the
 *  player has no walls yet, then to the zone's static tile-rect center
 *  when the zone has no occupant (e.g. eliminated player path).
 *
 *  Single source of truth for "where is this player's castle" — used by
 *  the camera (auto-zoom viewport center) and by overlay panel anchoring
 *  (life-lost popup) so both line up under a zoomed viewport. */
export function castleCenterPx(
  players: readonly Player[],
  playerZones: readonly ZoneId[],
  mapZones: readonly (readonly ZoneCell[])[],
  zoneId: ZoneId,
): PixelPos {
  const pid = playerByZone(playerZones, zoneId);
  const player = pid !== undefined ? players[pid] : undefined;
  if (player) {
    const bounds: TileBounds = {
      minR: Number.POSITIVE_INFINITY,
      maxR: Number.NEGATIVE_INFINITY,
      minC: Number.POSITIVE_INFINITY,
      maxC: Number.NEGATIVE_INFINITY,
    };
    extendBoundsFromWalls(bounds, player.walls);
    extendBoundsFromTower(bounds, player.homeTower);
    if (bounds.minR !== Number.POSITIVE_INFINITY) {
      return boundsCenterPx(bounds);
    }
  }
  const fallback = boundsFromZoneCells(mapZones, zoneId);
  return boundsCenterPx(fallback);
}

/** Pixel center of a tower footprint. */
export function towerCenterPx(tilePos: TilePos): PixelPos {
  const half = TOWER_SIZE / 2;
  return {
    x: (tilePos.col + half) * TILE_SIZE,
    y: (tilePos.row + half) * TILE_SIZE,
  };
}

/** Convert a world-pixel coordinate to a tile index (floor division by TILE_SIZE). */
export function pxToTile(px: number): number {
  return Math.floor(px / TILE_SIZE);
}

/** Flood one outside component from `seed`, stopping early once it proves
 *  boundary-connected (touches the map edge or a tile already in
 *  `boundaryConnected`). Adds every visited tile to `visited`. Returns whether
 *  the component reaches the boundary and the tiles flooded so far (the full
 *  component when trapped, a partial walk-to-edge when boundary-connected). */
function floodOutsideComponent(
  seed: TileKey,
  baselineOutside: ReadonlySet<TileKey>,
  newWallSet: ReadonlySet<TileKey>,
  visited: Set<TileKey>,
  boundaryConnected: ReadonlySet<TileKey>,
): { reachesBoundary: boolean; componentTiles: TileKey[] } {
  const componentTiles: TileKey[] = [seed];
  const seedR = (seed / GRID_COLS) | 0;
  const seedC = seed - seedR * GRID_COLS;
  visited.add(seed);
  let reachesBoundary = isBoundaryTile(seedR, seedC);
  const stackR: number[] = [seedR];
  const stackC: number[] = [seedC];
  while (!reachesBoundary && stackR.length > 0) {
    const r = stackR.pop()!;
    const c = stackC.pop()!;
    for (let dirIdx = 0; dirIdx < 8; dirIdx++) {
      const dir = DIRS_8[dirIdx]!;
      const nr = r + dir[0];
      const nc = c + dir[1];
      if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
      const neighborKey = (nr * GRID_COLS + nc) as TileKey;
      if (boundaryConnected.has(neighborKey)) {
        reachesBoundary = true;
        break;
      }
      if (visited.has(neighborKey)) continue;
      if (newWallSet.has(neighborKey)) continue;
      if (!baselineOutside.has(neighborKey)) continue;
      visited.add(neighborKey);
      componentTiles.push(neighborKey);
      if (isBoundaryTile(nr, nc)) {
        reachesBoundary = true;
        break;
      }
      stackR.push(nr);
      stackC.push(nc);
    }
  }
  return { reachesBoundary, componentTiles };
}

function extendBoundsFromWalls(
  bounds: TileBounds,
  walls: ReadonlySet<TileKey>,
): void {
  for (const key of walls) {
    const { row, col } = unpackTile(key);
    extendBounds(bounds, row, col);
  }
}

/** Convert a packed tile key back to row/column coordinates. */
export function unpackTile(key: TileKey): TilePos {
  return { row: Math.floor(key / GRID_COLS), col: key % GRID_COLS };
}

function extendBoundsFromTower(
  bounds: TileBounds,
  tower: Tower | null | undefined,
): void {
  if (!tower) return;
  // 2x2 tower footprint extends to (row+1, col+1) inclusive.
  extendBounds(bounds, tower.row, tower.col);
  extendBounds(bounds, tower.row + 1, tower.col + 1);
}

function boundsFromZoneCells(
  mapZones: readonly (readonly ZoneCell[])[],
  zoneId: ZoneId,
): TileBounds {
  const bounds: TileBounds = {
    minR: Number.POSITIVE_INFINITY,
    maxR: Number.NEGATIVE_INFINITY,
    minC: Number.POSITIVE_INFINITY,
    maxC: Number.NEGATIVE_INFINITY,
  };
  for (let r = 0; r < GRID_ROWS; r++) {
    const row = mapZones[r]!;
    for (let c = 0; c < GRID_COLS; c++) {
      if (row[c] === zoneId) extendBounds(bounds, r, c);
    }
  }
  return bounds;
}

function extendBounds(bounds: TileBounds, row: number, col: number): void {
  if (row < bounds.minR) bounds.minR = row;
  if (row > bounds.maxR) bounds.maxR = row;
  if (col < bounds.minC) bounds.minC = col;
  if (col > bounds.maxC) bounds.maxC = col;
}

function boundsCenterPx(bounds: TileBounds): PixelPos {
  return {
    x: ((bounds.minC + bounds.maxC + 1) * TILE_SIZE) / 2,
    y: ((bounds.minR + bounds.maxR + 1) * TILE_SIZE) / 2,
  };
}

/** Visit all 8 in-bounds neighbors of (r, c). Passes neighbor (row, col, key)
 *  to `visit`. Used by both `computeOutside` and `computeOutsideAfterAdd`
 *  flood-fill kernels — keep the body tight, V8 inlines it at monomorphic
 *  call sites. */
function forEachNeighbor8(
  r: number,
  c: number,
  visit: (neighborR: number, neighborC: number, neighborKey: TileKey) => void,
): void {
  for (let dirIdx = 0; dirIdx < 8; dirIdx++) {
    const dir = DIRS_8[dirIdx]!;
    const neighborR = r + dir[0];
    const neighborC = c + dir[1];
    if (
      neighborR < 0 ||
      neighborR >= GRID_ROWS ||
      neighborC < 0 ||
      neighborC >= GRID_COLS
    )
      continue;
    visit(neighborR, neighborC, (neighborR * GRID_COLS + neighborC) as TileKey);
  }
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
  callback: (r: number, c: number, key: TileKey) => void,
): void {
  for (let dr = 0; dr < size; dr++) {
    for (let dc = 0; dc < size; dc++) {
      const r = top + dr;
      const c = left + dc;
      callback(r, c, packTile(r, c));
    }
  }
}

/** Pack row/column into a flat tile key (row * GRID_COLS + col).
 *  Use this instead of manual encoding.
 *  Used for all Set<TileKey> tile collections. See unpackTile() for reverse. */
export function packTile(r: number, c: number): TileKey {
  // Dev/test only: surface accidental wrap-around (packTile(r, -1) silently
  // collides with packTile(r-1, GRID_COLS-1)). Vite DCE strips this in prod.
  // @ts-ignore — import.meta.env is Vite-specific (not recognized by Deno LSP)
  if (import.meta.env?.DEV !== false) {
    if (r < 0 || r >= GRID_ROWS || c < 0 || c >= GRID_COLS) {
      throw new Error(
        `packTile out of bounds: r=${r}, c=${c} (GRID_ROWS=${GRID_ROWS}, GRID_COLS=${GRID_COLS})`,
      );
    }
  }
  return (r * GRID_COLS + c) as TileKey;
}

/** True if tile is on the outer map border. */
function isBoundaryTile(r: number, c: number): boolean {
  return r === 0 || r === GRID_ROWS - 1 || c === 0 || c === GRID_COLS - 1;
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
