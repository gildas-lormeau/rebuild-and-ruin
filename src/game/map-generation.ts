/**
 * Rebuild & Ruin — Map Generation
 *
 * Generates a Rampart-style map with:
 * - A Y-shaped river dividing the map into 3 zones
 * - 12 towers (4 per zone, each 2×2 tiles)
 *
 * Grid: 44×28 tiles
 */

// --- Constants ---

import { TOWER_SIZE } from "../shared/game-constants.ts";
import type { GameMap, PixelPos, Tower } from "../shared/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, Tile } from "../shared/grid.ts";
import { Rng } from "../shared/rng.ts";
import { isGrass, isWater, packTile, unpackTile } from "../shared/spatial.ts";

interface ZoneStats {
  minRow: number;
  maxRow: number;
  height: number;
  centroidRow: number;
}

// Tower placement validation — multi-layer checks (isValidTowerPos):
//   1. Edge gap: tower footprint stays MIN_GAP_EDGE tiles from map boundary
//   2. Safe zone: SAFE_ZONE_PAD-tile orthogonal clearance around tower (corners
//      cut at PAD+1 Manhattan distance), must be all grass (no river)
//   3. Tower gap: MIN_GAP_TOWER Manhattan distance between tower rect edges
// Map generation validation (generateMap retry loop):
//   4. Zone count: exactly 3 zones with ≥MIN_ZONE_SIZE grass tiles each
//   5. Zone balance: largest/smallest zone ratio ≤ ZONE_BALANCE_RATIO (strict)
//      or ZONE_BALANCE_RATIO_FALLBACK (relaxed, on second pass)
//   6. Zone height: each zone spans ≥MIN_ZONE_HEIGHT rows (prevents thin slivers)
const SAFE_ZONE_PAD = 3;
// 8×8 safe zone with corners cut (3 tiles clearance orthogonally)
const MIN_GAP_EDGE = 2;
const MIN_GAP_TOWER = 6;
const TOWERS_PER_ZONE = 4;
/** Minimum zone size to be considered a valid zone. */
const MIN_ZONE_SIZE = 80;
/** Maximum generation attempts before falling back. */
const GENERATION_MAX_ATTEMPTS = 5000;
/** Maximum fallback generation attempts. */
const GENERATION_FALLBACK_ATTEMPTS = 2000;
/** Zone balance: largest/smallest must be within this ratio (strict pass). */
const ZONE_BALANCE_RATIO = 1.15;
/** Zone balance: relaxed ratio for fallback generation. */
const ZONE_BALANCE_RATIO_FALLBACK = 1.35;
/** Minimum grass rows per zone to avoid too-thin zones. */
const MIN_ZONE_HEIGHT = 12;
/** Horizontal margin for river exit placement (keeps exits away from map edges). */
const RIVER_EXIT_MARGIN_H = 10;
/** Vertical margin for river exit placement. */
const RIVER_EXIT_MARGIN_V = 6;
/** Horizontal margin for river junction placement. */
const JUNCTION_MARGIN_X = 16;
/** Vertical margin for river junction placement. */
const JUNCTION_MARGIN_Y = 11;
const EDGE_TOP = 0;
const EDGE_RIGHT = 1;
const EDGE_BOTTOM = 2;
const EDGE_LEFT = 3;

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
    ({ zones, regionSizes } = generateRiverAndZones(
      tiles,
      junction,
      exits,
      rng,
    ));

    attempts++;
    if (attempts > GENERATION_MAX_ATTEMPTS) break;

    // Check we have exactly 3 large zones of roughly equal size
    if (!hasThreeBalancedZones(regionSizes, ZONE_BALANCE_RATIO)) continue;

    // Collect per-zone row bounds + centroid in a single grid scan
    const top3 = topZoneIds(regionSizes, 3);
    const zoneStats = collectZoneStats(zones, top3);

    // Reject if any zone has insufficient vertical height
    if (top3.some((zid) => (zoneStats.get(zid)?.height ?? 0) < MIN_ZONE_HEIGHT))
      continue;

    // Nudge junction 1 tile toward the largest zone to balance height.
    // Find the largest zone's centroid row; if it's above/below junction,
    // shift junction 1 tile in that direction and repaint.
    const largestZoneId = top3[0];
    const largestStats =
      largestZoneId !== undefined ? zoneStats.get(largestZoneId) : undefined;
    if (largestStats !== undefined) {
      const centroidR = largestStats.centroidRow;
      const nudge = centroidR < junction.y ? -1 : 1;
      const newY = junction.y + nudge;
      if (newY >= 8 && newY <= GRID_ROWS - 9) {
        junction.y = newY;
        ({ zones, regionSizes } = generateRiverAndZones(
          tiles,
          junction,
          exits,
          rng,
        ));
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
    ({ zones, regionSizes } = generateRiverAndZones(
      tiles,
      junction,
      exits,
      rng,
    ));

    if (!hasThreeBalancedZones(regionSizes, ZONE_BALANCE_RATIO_FALLBACK))
      continue;

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

/**
 * Return the top N zones by grass tile count, sorted largest-first.
 * Used to identify the main player zones on the map.
 */
export function topZonesBySize(
  map: GameMap,
  count: number,
): { zone: number; count: number }[] {
  const counts = new Map<number, number>();
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (isGrass(map.tiles, r, c)) {
        const zone = map.zones[r]![c]!;
        counts.set(zone, (counts.get(zone) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([zone, count]) => ({ zone, count }));
}

function hasThreeBalancedZones(
  regionSizes: Map<number, number>,
  maxRatio: number,
): boolean {
  const bigZones = [...regionSizes.values()]
    .filter((size) => size > MIN_ZONE_SIZE)
    .sort((a, b) => b - a);
  if (bigZones.length < 3) return false;
  return bigZones[0]! / bigZones[2]! <= maxRatio;
}

/** Single-pass: collect row bounds + centroid for the given zone IDs. */
function collectZoneStats(
  zones: readonly number[][],
  zoneIds: readonly number[],
): Map<number, ZoneStats> {
  const acc = new Map<
    number,
    { minR: number; maxR: number; sumR: number; count: number }
  >();
  for (const zid of zoneIds) {
    acc.set(zid, { minR: GRID_ROWS, maxR: 0, sumR: 0, count: 0 });
  }

  for (let r = 0; r < GRID_ROWS; r++) {
    const row = zones[r]!;
    for (let c = 0; c < GRID_COLS; c++) {
      const a = acc.get(row[c]!);
      if (a === undefined) continue;
      if (r < a.minR) a.minR = r;
      if (r > a.maxR) a.maxR = r;
      a.sumR += r;
      a.count++;
    }
  }

  const result = new Map<number, ZoneStats>();
  for (const [zid, a] of acc) {
    if (a.count === 0) continue;
    result.set(zid, {
      minRow: a.minR,
      maxRow: a.maxR,
      height: a.maxR - a.minR + 1,
      centroidRow: a.sumR / a.count,
    });
  }
  return result;
}

function pickExits(rng: Rng): PixelPos[] {
  const edges = [EDGE_TOP, EDGE_RIGHT, EDGE_BOTTOM, EDGE_LEFT];
  rng.shuffle(edges);
  const chosen = edges.slice(0, 3);

  return chosen.map((edge) => {
    switch (edge) {
      case EDGE_TOP:
        return {
          x: rng.int(RIVER_EXIT_MARGIN_H, GRID_COLS - RIVER_EXIT_MARGIN_H - 1),
          y: -1,
        };
      case EDGE_RIGHT:
        return {
          x: GRID_COLS,
          y: rng.int(RIVER_EXIT_MARGIN_V, GRID_ROWS - RIVER_EXIT_MARGIN_V - 1),
        };
      case EDGE_BOTTOM:
        return {
          x: rng.int(RIVER_EXIT_MARGIN_H, GRID_COLS - RIVER_EXIT_MARGIN_H - 1),
          y: GRID_ROWS,
        };
      case EDGE_LEFT:
        return {
          x: -1,
          y: rng.int(RIVER_EXIT_MARGIN_V, GRID_ROWS - RIVER_EXIT_MARGIN_V - 1),
        };
      default:
        return { x: 0, y: 0 };
    }
  });
}

function pickJunction(rng: Rng): PixelPos {
  // Keep junction roughly central so all 3 zones have enough room for towers.
  // Each zone needs at least ~10 tiles of width for 4 towers with SAFE_ZONE_PAD=3.
  return {
    x: rng.int(JUNCTION_MARGIN_X, GRID_COLS - JUNCTION_MARGIN_X - 1),
    y: rng.int(JUNCTION_MARGIN_Y, GRID_ROWS - JUNCTION_MARGIN_Y - 1),
  };
}

function buildRiverDistanceGrid(tiles: readonly Tile[][]): number[][] {
  const dist: number[][] = Array.from({ length: GRID_ROWS }, () =>
    new Array(GRID_COLS).fill(Infinity),
  );
  // Flat-index BFS queue avoids tuple allocations (encode as packTile(r, c))
  const queue: number[] = [];

  // Seed BFS from all river tiles
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (isWater(tiles, r, c)) {
        dist[r]![c] = 0;
        queue.push(packTile(r, c));
      }
    }
  }

  // BFS to compute Manhattan distance to nearest river tile
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++]!;
    const { r, c } = unpackTile(idx);
    const d1 = dist[r]![c]! + 1;
    if (r > 0 && dist[r - 1]![c]! > d1) {
      dist[r - 1]![c] = d1;
      queue.push(idx - GRID_COLS);
    }
    if (r < GRID_ROWS - 1 && dist[r + 1]![c]! > d1) {
      dist[r + 1]![c] = d1;
      queue.push(idx + GRID_COLS);
    }
    if (c > 0 && dist[r]![c - 1]! > d1) {
      dist[r]![c - 1] = d1;
      queue.push(idx - 1);
    }
    if (c < GRID_COLS - 1 && dist[r]![c + 1]! > d1) {
      dist[r]![c + 1] = d1;
      queue.push(idx + 1);
    }
  }

  return dist;
}

function placeTowers(
  zones: readonly number[][],
  regionSizes: Map<number, number>,
  riverDist: readonly number[][],
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
      validPositions.reduce((size, [c]) => size + c, 0) / validPositions.length;
    const centroidR =
      validPositions.reduce((size, [, r]) => size + r, 0) /
      validPositions.length;

    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < validPositions.length; i++) {
      const distance =
        Math.abs(validPositions[i]![0] - centroidC) +
        Math.abs(validPositions[i]![1] - centroidR);
      if (distance < bestDist) {
        bestDist = distance;
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
    const zoneTowerStart = towers.length - 1; // index of first tower in this zone
    for (let tower = 1; tower < TOWERS_PER_ZONE; tower++) {
      let bestPos: [number, number] | undefined;
      let bestMinDist = -1;

      for (const [c, r] of validPositions) {
        if (!isValidTowerPos(c, r, riverDist, towers)) continue;

        let minDist = Infinity;
        for (
          let towerIdx = zoneTowerStart;
          towerIdx < towers.length;
          towerIdx++
        ) {
          const tower = towers[towerIdx]!;
          minDist = Math.min(
            minDist,
            towerRectDistance(c, r, tower.col, tower.row),
          );
        }

        if (minDist > bestMinDist) {
          bestMinDist = minDist;
          bestPos = [c, r];
        }
      }

      if (bestPos) {
        towers.push({
          col: bestPos[0],
          row: bestPos[1],
          zone: zoneId,
          index: towers.length,
        });
      }
    }
  }

  return towers;
}

function topZoneIds(regionSizes: Map<number, number>, count: number): number[] {
  return [...regionSizes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([id]) => id);
}

function isValidTowerPos(
  col: number,
  row: number,
  riverDist: readonly number[][],
  existingTowers: readonly Tower[],
): boolean {
  if (col + TOWER_SIZE - 1 >= GRID_COLS || row + TOWER_SIZE - 1 >= GRID_ROWS)
    return false;

  // Edge gap: tower footprint must fit within grid minus edge margin
  if (col < MIN_GAP_EDGE || col + TOWER_SIZE > GRID_COLS - MIN_GAP_EDGE)
    return false;
  if (row < MIN_GAP_EDGE || row + TOWER_SIZE > GRID_ROWS - MIN_GAP_EDGE)
    return false;

  // Safe zone: padded area around the tower footprint, corners cut off
  // Distance from tower edge: dx = max(0, distance to nearest tower col)
  //                           dy = max(0, distance to nearest tower row)
  // Skip corners where dx + dy > SAFE_ZONE_PAD + 1
  for (let dr = -SAFE_ZONE_PAD; dr < TOWER_SIZE + SAFE_ZONE_PAD; dr++) {
    for (let dc = -SAFE_ZONE_PAD; dc < TOWER_SIZE + SAFE_ZONE_PAD; dc++) {
      const dy = dr < 0 ? -dr : dr >= TOWER_SIZE ? dr - (TOWER_SIZE - 1) : 0;
      const dx = dc < 0 ? -dc : dc >= TOWER_SIZE ? dc - (TOWER_SIZE - 1) : 0;
      if (dx + dy > SAFE_ZONE_PAD + 1) continue; // cut corners
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || r >= GRID_ROWS || c < 0 || c >= GRID_COLS) return false;
      if (riverDist[r]![c] === 0) return false;
    }
  }

  // Tower gap: min empty tiles between edges (Manhattan)
  for (const tower of existingTowers) {
    if (towerRectDistance(col, row, tower.col, tower.row) < MIN_GAP_TOWER)
      return false;
  }

  return true;
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

/**
 * Reset tiles to grass, paint the river, smooth it, remove isolated water,
 * and flood-fill zones. Used during map generation to (re-)generate the
 * river layout from a junction and exits.
 */
function generateRiverAndZones(
  tiles: readonly Tile[][],
  junction: PixelPos,
  exits: readonly PixelPos[],
  rng: Rng,
): { zones: number[][]; regionSizes: Map<number, number> } {
  resetTilesToGrass(tiles);
  paintRiver(tiles, junction, exits, rng);
  smoothRiver(tiles);
  removeIsolatedWater(tiles);
  return floodFillZones(tiles);
}

function resetTilesToGrass(tiles: readonly Tile[][]): void {
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      tiles[r]![c] = Tile.Grass;
    }
  }
}

/**
 * Paint river onto tile grid. Each branch is 3 tiles wide (all Water).
 * Width is painted perpendicular to the path direction.
 */
function paintRiver(
  tiles: readonly Tile[][],
  junction: PixelPos,
  exits: readonly PixelPos[],
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
      const point = path[i]!;

      // Determine path direction to paint perpendicular width
      const prev = path[Math.max(0, i - 1)]!;
      const next = path[Math.min(path.length - 1, i + 1)]!;
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;

      setWater(point.x, point.y);

      if (Math.abs(dx) >= Math.abs(dy)) {
        // Moving mostly horizontal -> paint vertical width (3 tiles)
        setWater(point.x, point.y - 1);
        setWater(point.x, point.y + 1);
      } else {
        // Moving mostly vertical -> paint horizontal width (3 tiles)
        setWater(point.x - 1, point.y);
        setWater(point.x + 1, point.y);
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
 * Interpolate a smooth path from `from` to `to` via an optional midpoint for curvature.
 * Returns a list of integer (col, row) center points.
 */
function interpolatePath(
  from: PixelPos,
  target: PixelPos,
  rng: Rng,
): PixelPos[] {
  // Add a random midpoint for gentle curvature
  const midX = (from.x + target.x) / 2 + rng.int(-3, 3);
  const midY = (from.y + target.y) / 2 + rng.int(-2, 2);

  const controlPoints = [from, { x: midX, y: midY }, target];
  const points: PixelPos[] = [];

  // Walk along the quadratic bezier at small steps
  const steps = Math.max(GRID_COLS, GRID_ROWS) * 2;
  let prevX = -999;
  let prevY = -999;

  for (let i = 0; i <= steps; i++) {
    const interpolationParameter = i / steps;
    const complement = 1 - interpolationParameter;
    const bx =
      complement * complement * controlPoints[0]!.x +
      2 * complement * interpolationParameter * controlPoints[1]!.x +
      interpolationParameter * interpolationParameter * controlPoints[2]!.x;
    const by =
      complement * complement * controlPoints[0]!.y +
      2 * complement * interpolationParameter * controlPoints[1]!.y +
      interpolationParameter * interpolationParameter * controlPoints[2]!.y;

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
 * Smooth river edges: convert grass tiles with ≤1 grass neighbor to water.
 * Repeat until stable to remove peninsulas and jagged bits.
 */
function smoothRiver(tiles: readonly Tile[][]): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        if (!isGrass(tiles, r, c)) continue;
        let grassNeighbors = 0;
        if (r > 0 && isGrass(tiles, r - 1, c)) grassNeighbors++;
        if (r < GRID_ROWS - 1 && isGrass(tiles, r + 1, c)) grassNeighbors++;
        if (c > 0 && isGrass(tiles, r, c - 1)) grassNeighbors++;
        if (c < GRID_COLS - 1 && isGrass(tiles, r, c + 1)) grassNeighbors++;
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
function removeIsolatedWater(tiles: readonly Tile[][]): void {
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (!isWater(tiles, r, c)) continue;
      let waterNeighbors = 0;
      if (r > 0 && isWater(tiles, r - 1, c)) waterNeighbors++;
      if (r < GRID_ROWS - 1 && isWater(tiles, r + 1, c)) waterNeighbors++;
      if (c > 0 && isWater(tiles, r, c - 1)) waterNeighbors++;
      if (c < GRID_COLS - 1 && isWater(tiles, r, c + 1)) waterNeighbors++;
      if (waterNeighbors <= 1) {
        tiles[r]![c] = Tile.Grass;
      }
    }
  }
}

function floodFillZones(tiles: readonly Tile[][]): {
  zones: number[][];
  regionSizes: Map<number, number>;
} {
  const zones: number[][] = Array.from({ length: GRID_ROWS }, () =>
    new Array(GRID_COLS).fill(0),
  );
  let regionId = 0;
  const regionSizes = new Map<number, number>();
  // Reusable flat-index queue across all fills (cleared per region)
  const queue: number[] = [];

  const tryEnqueue = (r: number, c: number, rid: number): void => {
    if (
      r >= 0 &&
      r < GRID_ROWS &&
      c >= 0 &&
      c < GRID_COLS &&
      zones[r]![c] === 0 &&
      isGrass(tiles, r, c)
    ) {
      zones[r]![c] = rid;
      queue.push(packTile(r, c));
    }
  };

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (zones[r]![c] !== 0 || !isGrass(tiles, r, c)) continue;

      regionId++;
      queue.length = 0;
      zones[r]![c] = regionId;
      queue.push(packTile(r, c));
      let size = 0;
      let head = 0;

      while (head < queue.length) {
        const idx = queue[head++]!;
        const { r: cr, c: cc } = unpackTile(idx);
        size++;
        tryEnqueue(cr - 1, cc, regionId);
        tryEnqueue(cr + 1, cc, regionId);
        tryEnqueue(cr, cc - 1, regionId);
        tryEnqueue(cr, cc + 1, regionId);
      }

      regionSizes.set(regionId, size);
    }
  }

  return { zones, regionSizes };
}
