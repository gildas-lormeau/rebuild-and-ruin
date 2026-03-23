/**
 * Rebuild & Ruin — Map Generation
 *
 * Generates a Rampart-style map with:
 * - A Y-shaped river dividing the map into 3 zones
 * - 12 towers (4 per zone, each 2×2 tiles)
 *
 * Grid: 40×28 tiles
 */

// --- Constants ---

import { GRID_COLS, GRID_ROWS, Tile } from "./grid.ts";
import type { TilePos, PixelPos } from "./geometry-types.ts";
import { Rng } from "./rng.ts";
import { isPlayerActive, HOUSE_MIN_DISTANCE, type GameState } from "./types.ts";
import { DIRS_4, packTile, unpackTile, manhattanDistance, isGrass, forEachTowerTile, inBounds } from "./spatial.ts";
import { collectOccupiedTiles } from "./board-occupancy.ts";

const SAFE_ZONE_PAD = 3; // 8×8 safe zone with corners cut (3 tiles clearance orthogonally)
const MIN_GAP_EDGE = 2;
const MIN_GAP_TOWER = 4;
const TOWERS_PER_ZONE = 4;
const HOUSE_SPAWN_MARGIN = 2;
/** Minimum zone size to be considered a valid zone. */
const MIN_ZONE_SIZE = 80;
/** Maximum generation attempts before falling back. */
const GENERATION_MAX_ATTEMPTS = 5000;
/** Maximum fallback generation attempts. */
const GENERATION_FALLBACK_ATTEMPTS = 2000;

function forEachOrthoNeighbor(
  row: number,
  col: number,
  fn: (neighborRow: number, neighborCol: number) => void,
): void {
  for (const [dr, dc] of DIRS_4) {
    fn(row + dr, col + dc);
  }
}

function resetTilesToGrass(tiles: Tile[][]): void {
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      tiles[r]![c] = Tile.Grass;
    }
  }
}

function topZoneIds(regionSizes: Map<number, number>, count: number): number[] {
  return [...regionSizes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([id]) => id);
}

function hasThreeBalancedZones(
  regionSizes: Map<number, number>,
  maxRatio: number,
): boolean {
  const bigZones = [...regionSizes.values()]
    .filter((s) => s > MIN_ZONE_SIZE)
    .sort((a, b) => b - a);
  if (bigZones.length < 3) return false;
  return bigZones[0]! / bigZones[2]! <= maxRatio;
}

function hasAnyThinTopZone(
  zones: number[][],
  regionSizes: Map<number, number>,
  minHeight: number,
): boolean {
  const top3 = topZoneIds(regionSizes, 3);
  for (const zid of top3) {
    let minR = GRID_ROWS;
    let maxR = 0;
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        if (zones[r]![c] === zid) {
          minR = Math.min(minR, r);
          maxR = Math.max(maxR, r);
        }
      }
    }
    if (maxR - minR + 1 < minHeight) return true;
  }
  return false;
}

function zoneCentroidRow(zones: number[][], zoneId: number): number | null {
  let sumR = 0;
  let count = 0;
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (zones[r]![c] === zoneId) {
        sumR += r;
        count++;
      }
    }
  }
  if (count === 0) return null;
  return sumR / count;
}

function towerRectDistance(
  colA: number,
  rowA: number,
  colB: number,
  rowB: number,
): number {
  const dx = Math.max(0, Math.max(colA, colB) - Math.min(colA + 1, colB + 1));
  const dy = Math.max(0, Math.max(rowA, rowB) - Math.min(rowA + 1, rowB + 1));
  return dx + dy;
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

// --- River Generation ---

function pickExits(rng: Rng): PixelPos[] {
  const edges = [0, 1, 2, 3]; // top, right, bottom, left
  rng.shuffle(edges);
  const chosen = edges.slice(0, 3);

  return chosen.map((edge) => {
    switch (edge) {
      case 0:
        return { x: rng.int(10, GRID_COLS - 11), y: -1 };
      case 1:
        return { x: GRID_COLS, y: rng.int(6, GRID_ROWS - 7) };
      case 2:
        return { x: rng.int(10, GRID_COLS - 11), y: GRID_ROWS };
      case 3:
        return { x: -1, y: rng.int(6, GRID_ROWS - 7) };
      default:
        return { x: 0, y: 0 };
    }
  });
}

function pickJunction(rng: Rng): PixelPos {
  // Keep junction roughly central so all 3 zones have enough room for towers.
  // Each zone needs at least ~10 tiles of width for 4 towers with SAFE_ZONE_PAD=3.
  return {
    x: rng.int(16, GRID_COLS - 17),
    y: rng.int(11, GRID_ROWS - 12),
  };
}

/**
 * Interpolate a smooth path from `from` to `to` via an optional midpoint for curvature.
 * Returns a list of integer (col, row) center points.
 */
function interpolatePath(from: PixelPos, to: PixelPos, rng: Rng): PixelPos[] {
  // Add a random midpoint for gentle curvature
  const midX = (from.x + to.x) / 2 + rng.int(-3, 3);
  const midY = (from.y + to.y) / 2 + rng.int(-2, 2);

  const controlPoints = [from, { x: midX, y: midY }, to];
  const points: PixelPos[] = [];

  // Walk along the quadratic bezier at small steps
  const steps = Math.max(GRID_COLS, GRID_ROWS) * 2;
  let prevX = -999;
  let prevY = -999;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const bx =
      u * u * controlPoints[0]!.x +
      2 * u * t * controlPoints[1]!.x +
      t * t * controlPoints[2]!.x;
    const by =
      u * u * controlPoints[0]!.y +
      2 * u * t * controlPoints[1]!.y +
      t * t * controlPoints[2]!.y;

    const px = Math.round(bx);
    const py = Math.round(by);

    if (px === prevX && py === prevY) continue;

    // Fill in any gaps (ensure 4-connected continuity)
    if (points.length > 0) {
      const last = points[points.length - 1]!;
      let cx = last.x;
      let cy = last.y;
      while (cx !== px || cy !== py) {
        const dx = px - cx;
        const dy = py - cy;
        // Move one step at a time, prefer the larger axis
        if (Math.abs(dx) >= Math.abs(dy)) {
          cx += dx > 0 ? 1 : -1;
        } else {
          cy += dy > 0 ? 1 : -1;
        }
        if (cx === last.x && cy === last.y) continue;
        points.push({ x: cx, y: cy });
      }
    } else {
      points.push({ x: px, y: py });
    }

    prevX = px;
    prevY = py;
  }

  return points;
}

/**
 * Paint river onto tile grid. Each branch is 3 tiles wide (all Water).
 * Width is painted perpendicular to the path direction.
 */
function paintRiver(
  tiles: Tile[][],
  junction: PixelPos,
  exits: PixelPos[],
  rng: Rng,
): void {
  const setWater = (x: number, y: number) => {
    if (x >= 0 && x < GRID_COLS && y >= 0 && y < GRID_ROWS) {
      tiles[y]![x] = Tile.Water;
    }
  };

  for (const exit of exits) {
    const path = interpolatePath(junction, exit, rng);

    for (let i = 0; i < path.length; i++) {
      const p = path[i]!;

      // Determine path direction to paint perpendicular width
      const prev = path[Math.max(0, i - 1)]!;
      const next = path[Math.min(path.length - 1, i + 1)]!;
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;

      setWater(p.x, p.y);

      if (Math.abs(dx) >= Math.abs(dy)) {
        // Moving mostly horizontal -> paint vertical width (3 tiles)
        setWater(p.x, p.y - 1);
        setWater(p.x, p.y + 1);
      } else {
        // Moving mostly vertical -> paint horizontal width (3 tiles)
        setWater(p.x - 1, p.y);
        setWater(p.x + 1, p.y);
      }
    }
  }

  // Widen the junction area
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (Math.abs(dx) + Math.abs(dy) > 3) continue;
      const nx = junction.x + dx;
      const ny = junction.y + dy;
      setWater(nx, ny);
    }
  }
}

/**
 * Smooth river edges: convert grass tiles with ≤1 grass neighbor to water.
 * Repeat until stable to remove peninsulas and jagged bits.
 */
function smoothRiver(tiles: Tile[][]): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        if (tiles[r]![c] !== Tile.Grass) continue;
        let grassNeighbors = 0;
        forEachOrthoNeighbor(r, c, (nr, nc) => {
          if (inBounds(nr, nc) && tiles[nr]![nc] === Tile.Grass) {
            grassNeighbors++;
          }
        });
        if (grassNeighbors <= 1) {
          tiles[r]![c] = Tile.Water;
          changed = true;
        }
      }
    }
  }
}

/**
 * Remove isolated water tiles: single-pass, convert water tiles with ≤1 water
 * orthogonal neighbor to grass (truly isolated stubs).
 */
function removeIsolatedWater(tiles: Tile[][]): void {
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (tiles[r]![c] !== Tile.Water) continue;
      let waterOrtho = 0;
      forEachOrthoNeighbor(r, c, (nr, nc) => {
        if (inBounds(nr, nc) && tiles[nr]![nc] === Tile.Water) {
          waterOrtho++;
        }
      });
      if (waterOrtho <= 1) {
        tiles[r]![c] = Tile.Grass;
      }
    }
  }
}

// --- Flood Fill ---

function floodFillZones(tiles: Tile[][]): {
  zones: number[][];
  regionSizes: Map<number, number>;
} {
  const zones: number[][] = Array.from({ length: GRID_ROWS }, () =>
    new Array(GRID_COLS).fill(0),
  );
  let regionId = 0;
  const regionSizes = new Map<number, number>();

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (zones[r]![c] !== 0 || tiles[r]![c] !== Tile.Grass) continue;

      regionId++;
      let size = 0;
      const queue: [number, number][] = [[r, c]];

      while (queue.length > 0) {
        const [cr, cc] = queue.pop()!;
        if (cr < 0 || cr >= GRID_ROWS || cc < 0 || cc >= GRID_COLS) continue;
        if (zones[cr]![cc] !== 0 || tiles[cr]![cc] !== Tile.Grass) continue;

        zones[cr]![cc] = regionId;
        size++;
        forEachOrthoNeighbor(cr, cc, (nr, nc) => {
          queue.push([nr, nc]);
        });
      }

      regionSizes.set(regionId, size);
    }
  }

  return { zones, regionSizes };
}

// --- Precompute distance-to-river grid ---

function buildRiverDistanceGrid(tiles: Tile[][]): number[][] {
  const dist: number[][] = Array.from({ length: GRID_ROWS }, () =>
    new Array(GRID_COLS).fill(Infinity),
  );
  const queue: [number, number][] = [];

  // Seed BFS from all river tiles
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (tiles[r]![c] === Tile.Water) {
        dist[r]![c] = 0;
        queue.push([r, c]);
      }
    }
  }

  // BFS to compute Manhattan distance to nearest river tile
  let head = 0;
  while (head < queue.length) {
    const [r, c] = queue[head++]!;
    const d = dist[r]![c]!;
    forEachOrthoNeighbor(r, c, (nr, nc) => {
      if (
        nr >= 0 &&
        nr < GRID_ROWS &&
        nc >= 0 &&
        nc < GRID_COLS &&
        dist[nr]![nc]! > d + 1
      ) {
        dist[nr]![nc] = d + 1;
        queue.push([nr, nc]);
      }
    });
  }

  return dist;
}

// --- Tower Placement ---

function isValidTowerPos(
  col: number,
  row: number,
  riverDist: number[][],
  existingTowers: Tower[],
): boolean {
  if (col + 1 >= GRID_COLS || row + 1 >= GRID_ROWS) return false;

  // Edge gap: tower occupies [col, col+1] x [row, row+1]
  if (col < MIN_GAP_EDGE || col + 2 > GRID_COLS - MIN_GAP_EDGE) return false;
  if (row < MIN_GAP_EDGE || row + 2 > GRID_ROWS - MIN_GAP_EDGE) return false;

  // Safe zone: 8×8 area centered on the 2×2 tower, corners cut off
  // Distance from tower edge: dx = max(0, distance to nearest tower col)
  //                           dy = max(0, distance to nearest tower row)
  // Skip corners where dx + dy > SAFE_ZONE_PAD + 1
  for (let dr = -SAFE_ZONE_PAD; dr < 2 + SAFE_ZONE_PAD; dr++) {
    for (let dc = -SAFE_ZONE_PAD; dc < 2 + SAFE_ZONE_PAD; dc++) {
      const dy = dr < 0 ? -dr : dr >= 2 ? dr - 1 : 0;
      const dx = dc < 0 ? -dc : dc >= 2 ? dc - 1 : 0;
      if (dx + dy > SAFE_ZONE_PAD + 1) continue; // cut corners
      const r = row + dr;
      const c = col + dc;
      if (!inBounds(r, c)) return false;
      if (riverDist[r]![c] === 0) return false;
    }
  }

  // Tower gap: min empty tiles between edges (Manhattan)
  for (const t of existingTowers) {
    if (towerRectDistance(col, row, t.col, t.row) < MIN_GAP_TOWER) return false;
  }

  return true;
}

function placeTowers(
  zones: number[][],
  regionSizes: Map<number, number>,
  riverDist: number[][],
): Tower[] {
  const sortedRegions = topZoneIds(regionSizes, 3);

  const towers: Tower[] = [];

  for (const zoneId of sortedRegions) {
    // Collect all valid positions in this zone
    const validPositions: [number, number][] = [];
    for (let r = 0; r < GRID_ROWS - 1; r++) {
      for (let c = 0; c < GRID_COLS - 1; c++) {
        if (zones[r]![c] !== zoneId) continue;
        if (isValidTowerPos(c, r, riverDist, towers)) {
          validPositions.push([c, r]);
        }
      }
    }

    if (validPositions.length === 0) continue;

    // Farthest-point sampling
    // First tower: near centroid
    const centroidC =
      validPositions.reduce((s, [c]) => s + c, 0) / validPositions.length;
    const centroidR =
      validPositions.reduce((s, [, r]) => s + r, 0) / validPositions.length;

    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < validPositions.length; i++) {
      const d =
        Math.abs(validPositions[i]![0] - centroidC) +
        Math.abs(validPositions[i]![1] - centroidR);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }

    towers.push({
      col: validPositions[bestIdx]![0],
      row: validPositions[bestIdx]![1],
      zone: zoneId,
      index: towers.length,
    });

    // Remaining towers: farthest from existing zone towers
    for (let t = 1; t < TOWERS_PER_ZONE; t++) {
      let bestPos: [number, number] | null = null;
      let bestMinDist = -1;

      for (const [c, r] of validPositions) {
        if (!isValidTowerPos(c, r, riverDist, towers)) continue;

        let minDist = Infinity;
        for (const tw of towers.filter((tw) => tw.zone === zoneId)) {
          minDist = Math.min(minDist, towerRectDistance(c, r, tw.col, tw.row));
        }

        if (minDist > bestMinDist) {
          bestMinDist = minDist;
          bestPos = [c, r];
        }
      }

      if (bestPos) {
        towers.push({ col: bestPos[0], row: bestPos[1], zone: zoneId, index: towers.length });
      }
    }
  }

  return towers;
}

// --- House Placement ---

/** Max houses when refilling a zone mid-game (lower than initial to leave room). */
const REFILL_HOUSES_PER_ZONE = 8;

/** Build set of all 2×2 tower tile keys. */
function buildTowerTileSet(towers: Tower[]): Set<number> {
  const towerTiles = new Set<number>();
  for (const t of towers) {
    forEachTowerTile(t, (_r, _c, key) => towerTiles.add(key));
  }
  return towerTiles;
}

/** Check if a position is a valid house candidate (grass, correct zone, away from water and towers). */
function isValidHousePos(
  tiles: Tile[][],
  zones: number[][],
  towerTiles: Set<number>,
  r: number,
  c: number,
  zoneId: number,
): boolean {
  if (tiles[r]![c] !== Tile.Grass) return false;
  if (zones[r]![c] !== zoneId) return false;
  if (towerTiles.has(packTile(r, c))) return false;
  // All 8 neighbors must be grass (1-tile margin from water/edge)
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++)
      if (tiles[r + dr]![c + dc] !== Tile.Grass) return false;
  // Not adjacent to a tower (1 tile gap)
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++)
      if (towerTiles.has(packTile(r + dr, c + dc))) return false;
  return true;
}

/** True if (r,c) is too close to any existing house. */
function isHouseTooClose(houses: readonly House[], r: number, c: number): boolean {
  return houses.some(h => manhattanDistance(h.row, h.col, r, c) < HOUSE_MIN_DISTANCE);
}

// --- Main Generation ---

/**
 * Reset tiles to grass, paint the river, smooth it, remove isolated water,
 * and flood-fill zones. Used during map generation to (re-)generate the
 * river layout from a junction and exits.
 */
function generateRiverAndZones(
  tiles: Tile[][],
  junction: PixelPos,
  exits: PixelPos[],
  rng: Rng,
): { zones: number[][]; regionSizes: Map<number, number> } {
  resetTilesToGrass(tiles);
  paintRiver(tiles, junction, exits, rng);
  smoothRiver(tiles);
  removeIsolatedWater(tiles);
  return floodFillZones(tiles);
}

export function generateMap(seed?: number): GameMap {
  const rng = new Rng(seed ?? Date.now());

  const tiles: Tile[][] = Array.from({ length: GRID_ROWS }, () =>
    new Array(GRID_COLS).fill(Tile.Grass),
  );

  let junction!: PixelPos;
  let exits!: PixelPos[];
  let zones!: number[][];
  let regionSizes!: Map<number, number>;

  // Retry until we get 3 large zones (min 80 tiles each)
  let attempts = 0;
  do {
    junction = pickJunction(rng);
    exits = pickExits(rng);
    ({ zones, regionSizes } = generateRiverAndZones(tiles, junction, exits, rng));

    attempts++;
    if (attempts > GENERATION_MAX_ATTEMPTS) break;

    // Check we have exactly 3 large zones of roughly equal size
    if (!hasThreeBalancedZones(regionSizes, 1.15)) continue;

    // Reject if any zone has insufficient vertical height (< 12 grass rows)
    if (hasAnyThinTopZone(zones, regionSizes, 12)) continue;

    // Nudge junction 1 tile toward the largest zone to balance height.
    // Find the largest zone's centroid row; if it's above/below junction,
    // shift junction 1 tile in that direction and repaint.
    const largestZoneId = topZoneIds(regionSizes, 1)[0];
    if (largestZoneId !== undefined) {
      const centroidR = zoneCentroidRow(zones, largestZoneId);
      if (centroidR === null) continue;
      const nudge = centroidR < junction.y ? -1 : 1;
      const newY = junction.y + nudge;
      if (newY >= 8 && newY <= GRID_ROWS - 9) {
        junction.y = newY;
        ({ zones, regionSizes } = generateRiverAndZones(tiles, junction, exits, rng));
      }
    }

    // Check tower placement is possible — require exactly 12 towers (4 per zone)
    const riverDist = buildRiverDistanceGrid(tiles);
    const towers = placeTowers(zones, regionSizes, riverDist);
    if (towers.length < TOWERS_PER_ZONE * 3) continue;

    return { tiles, towers, houses: [], zones, junction, exits };
  } while (true);

  // Fallback: retry with relaxed ratio (1.35) but still require 12 towers
  for (let fallback = 0; fallback < GENERATION_FALLBACK_ATTEMPTS; fallback++) {
    junction = pickJunction(rng);
    exits = pickExits(rng);
    ({ zones, regionSizes } = generateRiverAndZones(tiles, junction, exits, rng));

    if (!hasThreeBalancedZones(regionSizes, 1.35)) continue;

    const riverDist = buildRiverDistanceGrid(tiles);
    const towers = placeTowers(zones, regionSizes, riverDist);
    if (towers.length < TOWERS_PER_ZONE * 3) continue;

    return { tiles, towers, houses: [], zones, junction, exits };
  }

  // Last resort — should virtually never happen
  const riverDist = buildRiverDistanceGrid(tiles);
  const towers = placeTowers(zones, regionSizes, riverDist);
  return { tiles, towers, houses: [], zones, junction, exits };
}

// --- Castle Gap Helpers ---

/**
 * Shrink gaps until the wall ring is valid (full ring check including corners).
 * Tries to identify the specific side causing invalidity; falls back to shrinking
 * the largest gap.
 */
function shrinkGapsUntilValid(
  isValid: (gL: number, gR: number, gT: number, gB: number) => boolean,
  gL: number,
  gR: number,
  gT: number,
  gB: number,
): { gL: number; gR: number; gT: number; gB: number } {
  let maxIter = 20;
  while (!isValid(gL, gR, gT, gB) && maxIter-- > 0) {
    // Find which side's wall has water and shrink it
    let shrunk = false;
    for (const side of ["L", "R", "T", "B"] as const) {
      const g = side === "L" ? gL : side === "R" ? gR : side === "T" ? gT : gB;
      if (g > 0) {
        const tryL = side === "L" ? g - 1 : gL;
        const tryR = side === "R" ? g - 1 : gR;
        const tryT = side === "T" ? g - 1 : gT;
        const tryB = side === "B" ? g - 1 : gB;
        // Check if this side's wall column/row has issues
        if (
          !isValid(gL, gR, gT, gB) &&
          isValid(tryL, tryR, tryT, tryB)
        ) {
          gL = tryL;
          gR = tryR;
          gT = tryT;
          gB = tryB;
          shrunk = true;
          break;
        }
      }
    }
    if (!shrunk) {
      // Shrink the side with the largest gap
      const gaps = [
        { side: "B" as const, val: gB },
        { side: "R" as const, val: gR },
        { side: "T" as const, val: gT },
        { side: "L" as const, val: gL },
      ].sort((a, b) => b.val - a.val);
      for (const { side } of gaps) {
        const g =
          side === "L" ? gL : side === "R" ? gR : side === "T" ? gT : gB;
        if (g > 0) {
          if (side === "L") gL--;
          else if (side === "R") gR--;
          else if (side === "T") gT--;
          else gB--;
          break;
        }
      }
    }
  }
  return { gL, gR, gT, gB };
}

/**
 * Extend gaps to reach the target budget, preferring the shorter axis first.
 * Each extension is validated against the wall ring check.
 */
function extendGapsToTarget(
  isValid: (gL: number, gR: number, gT: number, gB: number) => boolean,
  budget: number,
  gL: number,
  gR: number,
  gT: number,
  gB: number,
): { gL: number; gR: number; gT: number; gB: number } {
  while (gL + gR + gT + gB < budget) {
    // Try extending in priority order: opposite of constrained sides, then any direction
    const deficit = budget - (gL + gR + gT + gB);
    if (deficit <= 0) break;

    let extended = false;

    // If horizontal axis is short (gL+gR < 4), try extending horizontally
    // If vertical axis is short (gT+gB < 4), try extending vertically
    const hTotal = gL + gR;
    const vTotal = gT + gB;

    // Try each direction, preferring the axis that's shorter
    const directions: ("L" | "R" | "T" | "B")[] =
      hTotal <= vTotal ? ["R", "L", "B", "T"] : ["B", "T", "R", "L"];

    for (const dir of directions) {
      const newL = dir === "L" ? gL + 1 : gL;
      const newR = dir === "R" ? gR + 1 : gR;
      const newT = dir === "T" ? gT + 1 : gT;
      const newB = dir === "B" ? gB + 1 : gB;
      if (newL >= 0 && newR >= 0 && newT >= 0 && newB >= 0 && isValid(newL, newR, newT, newB)) {
        gL = newL;
        gR = newR;
        gT = newT;
        gB = newB;
        extended = true;
        break;
      }
    }

    if (!extended) break;
  }
  return { gL, gR, gT, gB };
}

// --- Castle Auto-Building ---

/**
 * Build the initial castle walls around a selected tower.
 *
 * Rules (reverse-engineered from Rampart arcade):
 * - Ideal: 6×6 interior (square) with gap=2 from tower edge to wall on each side
 * - The 1-tile-thick wall ring around the interior must be entirely on grass
 *   (no water, no off-map tiles on left/right/bottom — top edge can touch row 0)
 * - When water/edge constrains one side, shrink that gap; extend the opposite
 *   side to compensate (keeping the same-axis interior dimension at 6)
 * - If both sides of an axis are squeezed, extend the other axis to maintain
 *   area ≈ 36 (enough for tower + 6 cannons of 2×2)
 * - The gap sum (gL+gR+gT+gB) stays at 8 for a standard castle
 */
export function buildCastle(
  tower: Tower,
  tiles: Tile[][],
  allTowers?: Tower[],
): Castle {
  const tc = tower.col;
  const tr = tower.row;
  const IDEAL_GAP = 2;
  const GAP_BUDGET = 8;

  // Build a set of tiles occupied by OTHER towers (2×2 each)
  const otherTowerTiles = new Set<number>();
  if (allTowers) {
    for (const t of allTowers) {
      if (t === tower) continue;
      forEachTowerTile(t, (_r, _c, key) => otherTowerTiles.add(key));
    }
  }

  // Check if a proposed wall ring is fully valid (all wall tiles on grass & on-map).
  // Interior is defined by gaps: cols [tc-gL .. tc+1+gR], rows [tr-gT .. tr+1+gB].
  // Wall ring is 1 tile outside that.
  function isWallRingValid(
    gL: number,
    gR: number,
    gT: number,
    gB: number,
  ): boolean {
    const intLeft = tc - gL;
    const intRight = tc + 1 + gR;
    const intTop = tr - gT;
    const intBottom = tr + 1 + gB;
    const wL = intLeft - 1;
    const wR = intRight + 1;
    const wT = intTop - 1;
    const wB = intBottom + 1;

    for (let r = wT; r <= wB; r++) {
      for (let c = wL; c <= wR; c++) {
        // Skip interior tiles
        if (r >= intTop && r <= intBottom && c >= intLeft && c <= intRight)
          continue;
        // Off-map = blocked
        if (!inBounds(r, c)) return false;
        // Water = blocked
        if (tiles[r]![c] === Tile.Water) return false;
        // Other tower = blocked (wall ring and interior must not overlap another tower)
        if (otherTowerTiles.has(packTile(r, c))) return false;
      }
    }
    // Also check that no other tower sits inside the interior
    for (let r = intTop; r <= intBottom; r++) {
      for (let c = intLeft; c <= intRight; c++) {
        if (otherTowerTiles.has(packTile(r, c))) return false;
      }
    }
    return true;
  }

  // Find the maximum gap in a direction before the wall ring would hit water/edge.
  // Tests incrementally: gap=0,1,2,... checking if a wall at that distance is valid.
  function maxGap(side: "L" | "R" | "T" | "B"): number {
    for (let g = 0; g <= 15; g++) {
      // Check the wall column/row at distance g+1 from the tower edge
      const wallPos =
        side === "L"
          ? tc - g - 1
          : side === "R"
            ? tc + 2 + g
            : side === "T"
              ? tr - g - 1
              : tr + 2 + g;

      if (side === "L" || side === "R") {
        if (wallPos < 0 || wallPos >= GRID_COLS) return g;
        if (
          tiles[tr]![wallPos] === Tile.Water ||
          tiles[tr + 1]![wallPos] === Tile.Water
        )
          return g;
        // Check for other towers
        if (
          otherTowerTiles.has(packTile(tr, wallPos)) ||
          otherTowerTiles.has(packTile(tr + 1, wallPos))
        )
          return g;
      } else {
        if (wallPos < 0 || wallPos >= GRID_ROWS) return g;
        if (
          tiles[wallPos]![tc] === Tile.Water ||
          tiles[wallPos]![tc + 1] === Tile.Water
        )
          return g;
        if (
          otherTowerTiles.has(packTile(wallPos, tc)) ||
          otherTowerTiles.has(packTile(wallPos, tc + 1))
        )
          return g;
      }
    }
    return 15;
  }

  // Phase 1: Find maximum possible gap in each direction (quick check along tower rows/cols)
  const quickMax = {
    L: maxGap("L"),
    R: maxGap("R"),
    T: maxGap("T"),
    B: maxGap("B"),
  };

  // Phase 2: Start with ideal gaps, shrink where wall ring is invalid
  const initialL = Math.min(IDEAL_GAP, quickMax.L);
  const initialR = Math.min(IDEAL_GAP, quickMax.R);
  const initialT = Math.min(IDEAL_GAP, quickMax.T);
  const initialB = Math.min(IDEAL_GAP, quickMax.B);

  const shrunk = shrinkGapsUntilValid(isWallRingValid, initialL, initialR, initialT, initialB);
  let { gL, gR, gT, gB } = shrunk;

  // Phase 3: Compensate — extend opposite sides to reach GAP_BUDGET
  const extended = extendGapsToTarget(isWallRingValid, GAP_BUDGET, gL, gR, gT, gB);
  gL = extended.gL;
  gR = extended.gR;
  gT = extended.gT;
  gB = extended.gB;

  // Interior bounds (inclusive)
  return {
    left: tc - gL,
    right: tc + 1 + gR,
    top: tr - gT,
    bottom: tr + 1 + gB,
    tower,
  };
}

/**
 * Get all wall tile positions for a castle (1-tile ring around interior).
 * Only includes tiles that are on-map and on grass.
 */
export function getCastleWallTiles(
  castle: Castle,
  tiles: Tile[][],
): [number, number][] {
  const { left, right, top, bottom } = castle;
  const wallTiles: [number, number][] = [];

  // Wall ring: 1 tile outside the interior bounds
  const wL = left - 1;
  const wR = right + 1;
  const wT = top - 1;
  const wB = bottom + 1;

  for (let r = wT; r <= wB; r++) {
    for (let c = wL; c <= wR; c++) {
      if (!inBounds(r, c)) continue;
      // Is this on the wall ring (not interior)?
      if (r >= top && r <= bottom && c >= left && c <= right) continue;
      // Only place walls on grass
      if (tiles[r]![c] !== Tile.Grass) continue;
      wallTiles.push([r, c]);
    }
  }

  return wallTiles;
}

/**
 * Apply clumsy builder cosmetic noise to a wall set, then sweep isolated tiles.
 *
 * For each wall tile, ~1/10 chance to add an adjacent tile (inside or outside).
 * For each corner of the wall ring, ~1/12 chance to misplace the corner tile.
 * After all additions, sweep tiles connected to ≤1 other wall tile until stable.
 * Net effect: only extra walls near corners survive the sweep.
 */
export function applyClumsyBuilders(
  walls: Set<number>,
  castle: Castle,
  tiles: Tile[][],
  rng: Rng,
  allTowers?: Tower[],
): void {
  const { left, right, top, bottom } = castle;
  const wL = left - 1;
  const wR = right + 1;
  const wT = top - 1;
  const wB = bottom + 1;

  const towerTiles = new Set<number>();
  for (const t of allTowers ?? [castle.tower]) {
    forEachTowerTile(t, (_r, _c, key) => towerTiles.add(key));
  }
  const isTower = (r: number, c: number) => towerTiles.has(packTile(r, c));

  // Scale mistake probability with castle perimeter — small castles can't afford errors
  // Top+bottom rows counted fully, left+right columns minus corners to avoid double-counting
  const perimeter = 2 * (wR - wL + 1) + 2 * (wB - wT - 1);
  // Reference perimeter (~22 for a margin-2 castle around a centroid tower).
  // Mistakes scale linearly: half-size castle → half the per-tile chance.
  const REF_PERIMETER = 22;
  const clumsyScale = Math.min(1, perimeter / REF_PERIMETER);

  // Identify the 4 corners of the wall ring
  const corners: [number, number][] = [
    [wT, wL],
    [wT, wR],
    [wB, wL],
    [wB, wR],
  ];

  // For each corner, ~1/12 chance (scaled) to add an extra wall tile
  // adjacent to the corner (cardinal direction inward), creating a bump.
  for (const [cr, cc] of corners) {
    if (!rng.bool((1 / 12) * clumsyScale)) continue;
    const key = packTile(cr, cc);
    if (!walls.has(key)) continue;
    // Pick one of the two cardinal-inward neighbors (toward interior)
    const dr = cr === wT ? 1 : -1;
    const dc = cc === wL ? 1 : -1;
    const candidates: [number, number][] = [[cr + dr, cc], [cr, cc + dc]];
    const [nr, nc] = rng.pick(candidates);
    if (inBounds(nr, nc) && !isTower(nr, nc) && !walls.has(packTile(nr, nc)) && isGrass(tiles, nr, nc)) {
      walls.add(packTile(nr, nc));
    }
  }

  // For each wall tile, ~1/10 chance (scaled) to add an adjacent inner or outer tile
  const currentWalls = [...walls];
  for (const key of currentWalls) {
    if (!rng.bool((1 / 10) * clumsyScale)) continue;
    const { r, c } = unpackTile(key);

    // Collect candidate neighbors (4-connected) that aren't already walls or tower
    const candidates: [number, number][] = [];
    for (const [dr, dc] of DIRS_4) {
      const nr = r + dr;
      const nc = c + dc;
      if (!isGrass(tiles, nr, nc)) continue;
      if (walls.has(packTile(nr, nc))) continue;
      if (isTower(nr, nc)) continue;
      candidates.push([nr, nc]);
    }
    if (candidates.length === 0) continue;

    // Pick a random candidate
    const [nr, nc] = rng.pick(candidates);
    walls.add(packTile(nr, nc));
  }

  // Sweep: remove completely isolated extra tiles (0 wall neighbors).
  // Tiles with 1+ neighbors are valid bumps from clumsy builders.
  for (const key of [...walls]) {
    const { r, c } = unpackTile(key);
    let neighbors = 0;
    for (const [dr, dc] of DIRS_4) {
      if (walls.has(packTile(r + dr, c + dc))) neighbors++;
    }
    if (neighbors === 0) {
      walls.delete(key);
    }
  }
}

// --- House Refilling (mid-game) ---

/**
 * Spawn houses in a single zone, avoiding walls, cannons, towers, and their margins.
 * Appends new houses to state.map.houses.
 */
export function spawnHousesInZone(state: GameState, zoneId: number): void {
  const { tiles, towers, zones } = state.map;
  const towerTiles = buildTowerTileSet(towers);

  // Build set of blocked tiles: all player walls, interior, cannons (alive + dead debris), grunts
  const blocked = collectOccupiedTiles(state, {
    includeWalls: true,
    includeInterior: true,
    includeCannons: true,
    includeGrunts: true,
  });

  const candidates: [number, number][] = [];
  for (let r = HOUSE_SPAWN_MARGIN; r < GRID_ROWS - HOUSE_SPAWN_MARGIN; r++) {
    for (let c = HOUSE_SPAWN_MARGIN; c < GRID_COLS - HOUSE_SPAWN_MARGIN; c++) {
      if (!isValidHousePos(tiles, zones, towerTiles, r, c, zoneId)) continue;
      const key = packTile(r, c);
      if (blocked.has(key)) continue;
      // 1-tile margin from walls/cannons/interior
      let nearBlocked = false;
      for (let dr = -1; dr <= 1 && !nearBlocked; dr++)
        for (let dc = -1; dc <= 1 && !nearBlocked; dc++)
          if (blocked.has(packTile(r + dr, c + dc))) nearBlocked = true;
      if (nearBlocked) continue;
      candidates.push([r, c]);
    }
  }

  state.rng.shuffle(candidates);

  const existingHouses = state.map.houses;
  let placed = 0;
  for (const [r, c] of candidates) {
    if (placed >= REFILL_HOUSES_PER_ZONE) break;
    if (isHouseTooClose(existingHouses, r, c)) continue;
    existingHouses.push({ row: r, col: c, zone: zoneId, alive: true });
    placed++;
  }
}

/**
 * Called at the start of each build phase:
 * Refill houses in zones that have fewer than the refill cap.
 */
export function startOfBuildPhaseHousekeeping(state: GameState): void {
  for (const player of state.players) {
    if (!isPlayerActive(player)) continue;
    const zone = player.homeTower.zone;
    const aliveInZone = state.map.houses.filter(
      (h) => h.zone === zone && h.alive,
    ).length;
    if (aliveInZone < REFILL_HOUSES_PER_ZONE) {
      // Remove dead houses in zone first to free up positions
      state.map.houses = state.map.houses.filter(
        (h) => h.zone !== zone || h.alive,
      );
      spawnHousesInZone(state, zone);
    }
  }
}

/**
 * Return the top N zones by grass tile count, sorted largest-first.
 * Used to identify the main player zones on the map.
 */
export function topZonesBySize(
  map: GameMap,
  n: number,
): { zone: number; count: number }[] {
  const counts = new Map<number, number>();
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (map.tiles[r]![c] === Tile.Grass) {
        const z = map.zones[r]![c]!;
        counts.set(z, (counts.get(z) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([zone, count]) => ({ zone, count }));
}
