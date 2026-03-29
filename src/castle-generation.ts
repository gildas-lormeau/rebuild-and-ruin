/**
 * Rebuild & Ruin — Castle & House Generation
 *
 * Castle wall construction (initial walls around a selected tower),
 * clumsy-builder cosmetic noise, and house spawning.
 */

import {
  collectOccupiedTiles,
  HOUSE_SPAWN_BLOCKED,
} from "./board-occupancy.ts";
import { HOUSE_MIN_DISTANCE } from "./game-constants.ts";
import type { Castle, House, Tower } from "./geometry-types.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  TILE_GRASS,
  TILE_WATER,
  type Tile,
} from "./grid.ts";
import type { Rng } from "./rng.ts";
import {
  DIRS_4,
  forEachTowerTile,
  inBounds,
  isGrass,
  manhattanDistance,
  packTile,
  unpackTile,
} from "./spatial.ts";
import { type GameState, isPlayerActive } from "./types.ts";

type CastleSide = (typeof Side)[keyof typeof Side];

/** Gap sizes per side: [L, R, T, B]. */
type Gaps = [number, number, number, number];

type GapsValidator = (g: Gaps) => boolean;

/** Castle gap directions: indices into a Gaps tuple. */
const Side = { L: 0, R: 1, T: 2, B: 3 } as const;
const ALL_SIDES: readonly CastleSide[] = [Side.L, Side.R, Side.T, Side.B];
const HOUSE_SPAWN_MARGIN = 2;
/** Max houses when refilling a zone mid-game (lower than initial to leave room). */
const REFILL_HOUSES_PER_ZONE = 8;
/** Clumsy builder: chance per corner to add a bump wall tile. */
const CLUMSY_CORNER_CHANCE = 1 / 12;
/** Clumsy builder: chance per wall tile to add an adjacent tile. */
const CLUMSY_WALL_CHANCE = 1 / 10;
const CASTLE_SHRINK_MAX_ITER = 20;

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
export function createCastle(
  tower: Tower,
  tiles: readonly Tile[][],
  allTowers?: readonly Tower[],
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
  // Towers are 2×2: tc..tc+1 cols, tr..tr+1 rows (TOWER_SIZE in game-constants.ts).
  // Interior is defined by gaps: cols [tc-gL .. tc+1+gR], rows [tr-gT .. tr+1+gB].
  // Wall ring is 1 tile outside that.
  function isWallRingValid(g: Gaps): boolean {
    const intLeft = tc - g[Side.L];
    const intRight = tc + 1 + g[Side.R];
    const intTop = tr - g[Side.T];
    const intBottom = tr + 1 + g[Side.B];
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
        if (tiles[r]![c] === TILE_WATER) return false;
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
  function maxGap(side: CastleSide): number {
    const MAX_CASTLE_GAP = 15;
    const isHorizontal = side === Side.L || side === Side.R;
    for (let g = 0; g <= MAX_CASTLE_GAP; g++) {
      // Check the wall column/row at distance g+1 from the tower edge
      const wallPos =
        side === Side.L
          ? tc - g - 1
          : side === Side.R
            ? tc + 2 + g
            : side === Side.T
              ? tr - g - 1
              : tr + 2 + g;

      if (isHorizontal) {
        if (wallPos < 0 || wallPos >= GRID_COLS) return g;
        if (
          tiles[tr]![wallPos] === TILE_WATER ||
          tiles[tr + 1]![wallPos] === TILE_WATER
        )
          return g;
        if (
          otherTowerTiles.has(packTile(tr, wallPos)) ||
          otherTowerTiles.has(packTile(tr + 1, wallPos))
        )
          return g;
      } else {
        if (wallPos < 0 || wallPos >= GRID_ROWS) return g;
        if (
          tiles[wallPos]![tc] === TILE_WATER ||
          tiles[wallPos]![tc + 1] === TILE_WATER
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
  const quickMax: Gaps = [
    maxGap(Side.L),
    maxGap(Side.R),
    maxGap(Side.T),
    maxGap(Side.B),
  ];

  // Phase 2: Start with ideal gaps, shrink where wall ring is invalid
  const initial: Gaps = ALL_SIDES.map((s) =>
    Math.min(IDEAL_GAP, quickMax[s]),
  ) as unknown as Gaps;

  const gaps = shrinkGapsUntilValid(isWallRingValid, initial);

  // Phase 3: Compensate — extend opposite sides to reach GAP_BUDGET
  extendGapsToTarget(isWallRingValid, GAP_BUDGET, gaps);

  // Interior bounds (inclusive)
  return {
    left: tc - gaps[Side.L],
    right: tc + 1 + gaps[Side.R],
    top: tr - gaps[Side.T],
    bottom: tr + 1 + gaps[Side.B],
    tower,
  };
}

/**
 * Get all wall tile positions for a castle (1-tile ring around interior).
 * Only includes tiles that are on-map and on grass.
 */
export function computeCastleWallTiles(
  castle: Castle,
  tiles: readonly Tile[][],
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
      if (tiles[r]![c] !== TILE_GRASS) continue;
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
  tiles: readonly Tile[][],
  rng: Rng,
  allTowers?: readonly Tower[],
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
    if (!rng.bool(CLUMSY_CORNER_CHANCE * clumsyScale)) continue;
    const key = packTile(cr, cc);
    if (!walls.has(key)) continue;
    // Pick one of the two cardinal-inward neighbors (toward interior)
    const dr = cr === wT ? 1 : -1;
    const dc = cc === wL ? 1 : -1;
    const candidates: [number, number][] = [
      [cr + dr, cc],
      [cr, cc + dc],
    ];
    const [nr, nc] = rng.pick(candidates);
    if (
      inBounds(nr, nc) &&
      !isTower(nr, nc) &&
      !walls.has(packTile(nr, nc)) &&
      isGrass(tiles, nr, nc)
    ) {
      walls.add(packTile(nr, nc));
    }
  }

  // For each wall tile, ~1/10 chance (scaled) to add an adjacent inner or outer tile
  const currentWalls = [...walls];
  for (const key of currentWalls) {
    if (!rng.bool(CLUMSY_WALL_CHANCE * clumsyScale)) continue;
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
 * Spawn houses in a single zone, avoiding walls, cannons, towers, and their margins.
 * Appends new houses to state.map.houses.
 */
export function spawnHousesInZone(state: GameState, zoneId: number): void {
  const { tiles, towers, zones } = state.map;
  const towerTiles = buildTowerTileSet(towers);

  // Build set of blocked tiles: all player walls, interior, cannons (alive + dead debris), grunts
  const blocked = collectOccupiedTiles(state, HOUSE_SPAWN_BLOCKED);

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

/** Build set of all 2×2 tower tile keys. */
function buildTowerTileSet(towers: readonly Tower[]): Set<number> {
  const towerTiles = new Set<number>();
  for (const t of towers) {
    forEachTowerTile(t, (_r, _c, key) => towerTiles.add(key));
  }
  return towerTiles;
}

/** Check if a position is a valid house candidate (grass, correct zone, away from water and towers). */
function isValidHousePos(
  tiles: readonly Tile[][],
  zones: readonly number[][],
  towerTiles: Set<number>,
  r: number,
  c: number,
  zoneId: number,
): boolean {
  if (tiles[r]![c] !== TILE_GRASS) return false;
  if (zones[r]![c] !== zoneId) return false;
  if (towerTiles.has(packTile(r, c))) return false;
  // All 8 neighbors must be grass (1-tile margin from water/edge)
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++)
      if (tiles[r + dr]![c + dc] !== TILE_GRASS) return false;
  // Not adjacent to a tower (1 tile gap)
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++)
      if (towerTiles.has(packTile(r + dr, c + dc))) return false;
  return true;
}

/** True if (r,c) is too close to any existing house. */
function isHouseTooClose(
  houses: readonly House[],
  r: number,
  c: number,
): boolean {
  return houses.some(
    (h) => manhattanDistance(h.row, h.col, r, c) < HOUSE_MIN_DISTANCE,
  );
}

/**
 * Shrink gaps until the wall ring is valid (full ring check including corners).
 * Tries to identify the specific side causing invalidity; falls back to shrinking
 * the largest gap. Mutates `gaps` in place.
 */
function shrinkGapsUntilValid(isValid: GapsValidator, gaps: Gaps): Gaps {
  let maxIter = CASTLE_SHRINK_MAX_ITER;
  while (!isValid(gaps) && maxIter-- > 0) {
    let shrunk = false;
    for (const side of ALL_SIDES) {
      if (gaps[side] <= 0) continue;
      const trial: Gaps = [...gaps];
      trial[side]--;
      if (isValid(trial)) {
        gaps[side] = trial[side];
        shrunk = true;
        break;
      }
    }
    if (!shrunk) {
      // Shrink the side with the largest gap
      const sorted = [...ALL_SIDES].sort((a, b) => gaps[b] - gaps[a]);
      for (const side of sorted) {
        if (gaps[side] > 0) {
          gaps[side]--;
          break;
        }
      }
    }
  }
  return gaps;
}

/**
 * Extend gaps to reach the target budget, preferring the shorter axis first.
 * Each extension is validated against the wall ring check. Mutates `gaps` in place.
 */
function extendGapsToTarget(
  isValid: GapsValidator,
  budget: number,
  gaps: Gaps,
): Gaps {
  while (gaps[Side.L] + gaps[Side.R] + gaps[Side.T] + gaps[Side.B] < budget) {
    let extended = false;

    // If horizontal axis is short, try extending horizontally first
    const hTotal = gaps[Side.L] + gaps[Side.R];
    const vTotal = gaps[Side.T] + gaps[Side.B];
    const directions: CastleSide[] =
      hTotal <= vTotal
        ? [Side.R, Side.L, Side.B, Side.T]
        : [Side.B, Side.T, Side.R, Side.L];

    for (const dir of directions) {
      const trial: Gaps = [...gaps];
      trial[dir]++;
      if (isValid(trial)) {
        gaps[dir] = trial[dir];
        extended = true;
        break;
      }
    }

    if (!extended) break;
  }
  return gaps;
}
