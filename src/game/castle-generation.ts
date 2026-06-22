/**
 * Rebuild & Ruin — Castle & House Generation
 *
 * Castle wall construction (initial walls around a selected tower),
 * clumsy-builder cosmetic noise, and house spawning.
 */

import {
  BOARD_LOCAL_SITE,
  deriveBoardLocalSeed,
} from "../shared/core/ai-seed.ts";
import {
  HOUSE_MIN_DISTANCE,
  MODIFIER_ID,
  type ModifierId,
} from "../shared/core/game-constants.ts";
import type {
  Castle,
  GameMap,
  House,
  Tower,
} from "../shared/core/geometry-types.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  type Tile,
  type TileKey,
} from "../shared/core/grid.ts";
import { isPlayerSeated } from "../shared/core/player-types.ts";
import {
  computeFloodedTiles,
  DIRS_4,
  forEachTowerTile,
  inBounds,
  isGrass,
  isWater,
  manhattanDistance,
  packTile,
  setWater,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { GameState } from "../shared/core/types.ts";
import type { ZoneCell, ZoneId } from "../shared/core/zone-id.ts";
import { Rng } from "../shared/platform/rng.ts";
import {
  collectOccupiedTiles,
  HOUSE_SPAWN_BLOCKED,
} from "../shared/sim/board-occupancy.ts";

type CastleSide = (typeof Side)[keyof typeof Side];

/** Gap sizes per side: [L, R, T, B]. */
type Gaps = [number, number, number, number];

type GapsValidator = (gap: Gaps) => boolean;

/** Castle gap directions: indices into a Gaps tuple. */
const Side = { L: 0, R: 1, T: 2, B: 3 } as const;
const ALL_SIDES: readonly CastleSide[] = [Side.L, Side.R, Side.T, Side.B];
const HOUSE_SPAWN_MARGIN = 2;
/**
 * Houses a zone starts with (game start + after a life-loss reselect, where
 * `resetZoneState` clears the zone). DOS Rampart seeds 10/zone; scaled to 12
 * for this port's larger 44×28 grid (~1.23× the DOS 40×25 area) to keep the
 * house density matched. Reverse-engineered from 14 recorded games — every
 * full recording opens at exactly 10/zone, no variation.
 */
const INITIAL_HOUSES_PER_ZONE = 12;
/**
 * New houses added to each surviving zone every round (the population grows;
 * houses are NOT capped — they accumulate, reaching 30+/zone in a long game).
 * DOS reverse-engineered growth is ~+2/zone/round (per-zone deltas were always
 * 0/1/2, never ≥3, mode 2, mean ≈1.6 with detection occlusion; the cleanest
 * zones approach a steady +2). Additive, not proportional to current count.
 */
const HOUSES_GROWTH_PER_ROUND = 2;
/** Clumsy builder: chance per corner to add a bump wall tile. */
const CLUMSY_CORNER_CHANCE = 1 / 12;
/** Clumsy builder: chance per wall tile to add an adjacent tile. */
const CLUMSY_WALL_CHANCE = 1 / 10;
const CASTLE_SHRINK_MAX_ITER = 20;
/** 50% chance to reverse castle-wall build animation direction (visual variety). */
const CASTLE_RING_REVERSE_CHANCE = 0.5;

/** Tile grid as the castle planner should see it: when high_tide is
 *  active, flooded grass is projected back to water so the auto-built
 *  ring + interior don't land on tiles the renderer paints as water and
 *  the player can't build over. Returns the live tiles array unchanged
 *  when no projection is needed (zero allocation). The parameter is a
 *  structural slice satisfied by both `GameState` and `BuildViewState`. */
export function effectivePlanTiles(state: {
  readonly modern: { readonly activeModifier: ModifierId | null } | null;
  readonly map: GameMap;
}): readonly Tile[][] {
  if (state.modern?.activeModifier !== MODIFIER_ID.HIGH_TIDE) {
    return state.map.tiles;
  }
  const flooded = computeFloodedTiles(state.map);
  if (flooded.size === 0) return state.map.tiles;
  const cloned: Tile[][] = state.map.tiles.map((row) => [...row]);
  for (const key of flooded) {
    const { row, col } = unpackTile(key);
    setWater(cloned, row, col);
  }
  return cloned;
}

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
  const otherTowerTiles = new Set<TileKey>();
  if (allTowers) {
    for (const other of allTowers) {
      if (other === tower) continue;
      forEachTowerTile(other, (_r, _c, key) => otherTowerTiles.add(key));
    }
  }

  // Check if a proposed wall ring is fully valid (all wall tiles on grass & on-map).
  // Towers are 2×2: tc..tc+1 cols, tr..tr+1 rows (TOWER_SIZE in game-constants.ts).
  // Interior is defined by gaps: cols [tc-gL .. tc+1+gR], rows [tr-gT .. tr+1+gB].
  // Wall ring is 1 tile outside that.
  function isWallRingValid(gap: Gaps): boolean {
    const intLeft = tc - gap[Side.L];
    const intRight = tc + 1 + gap[Side.R];
    const intTop = tr - gap[Side.T];
    const intBottom = tr + 1 + gap[Side.B];
    const wallLeft = intLeft - 1;
    const wallRight = intRight + 1;
    const wallTop = intTop - 1;
    const wallBottom = intBottom + 1;

    for (let r = wallTop; r <= wallBottom; r++) {
      for (let c = wallLeft; c <= wallRight; c++) {
        // Skip interior tiles
        if (r >= intTop && r <= intBottom && c >= intLeft && c <= intRight)
          continue;
        // Off-map = blocked
        if (!inBounds(r, c)) return false;
        // Water = blocked
        if (isWater(tiles, r, c)) return false;
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
    for (let gap = 0; gap <= MAX_CASTLE_GAP; gap++) {
      // Check the wall column/row at distance g+1 from the tower edge
      const wallPos =
        side === Side.L
          ? tc - gap - 1
          : side === Side.R
            ? tc + 2 + gap
            : side === Side.T
              ? tr - gap - 1
              : tr + 2 + gap;

      if (isHorizontal) {
        if (wallPos < 0 || wallPos >= GRID_COLS) return gap;
        if (isWater(tiles, tr, wallPos) || isWater(tiles, tr + 1, wallPos))
          return gap;
        if (
          otherTowerTiles.has(packTile(tr, wallPos)) ||
          otherTowerTiles.has(packTile(tr + 1, wallPos))
        )
          return gap;
      } else {
        if (wallPos < 0 || wallPos >= GRID_ROWS) return gap;
        if (isWater(tiles, wallPos, tc) || isWater(tiles, wallPos, tc + 1))
          return gap;
        if (
          otherTowerTiles.has(packTile(wallPos, tc)) ||
          otherTowerTiles.has(packTile(wallPos, tc + 1))
        )
          return gap;
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
  const initial: Gaps = [
    Math.min(IDEAL_GAP, quickMax[Side.L]),
    Math.min(IDEAL_GAP, quickMax[Side.R]),
    Math.min(IDEAL_GAP, quickMax[Side.T]),
    Math.min(IDEAL_GAP, quickMax[Side.B]),
  ];

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
  const wallLeft = left - 1;
  const wallRight = right + 1;
  const wallTop = top - 1;
  const wallBottom = bottom + 1;

  for (let r = wallTop; r <= wallBottom; r++) {
    for (let c = wallLeft; c <= wallRight; c++) {
      if (!inBounds(r, c)) continue;
      // Is this on the wall ring (not interior)?
      if (r >= top && r <= bottom && c >= left && c <= right) continue;
      // Only place walls on grass
      if (!isGrass(tiles, r, c)) continue;
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
  walls: Set<TileKey>,
  castle: Castle,
  tiles: readonly Tile[][],
  rng: Rng,
  allTowers?: readonly Tower[],
): void {
  const { left, right, top, bottom } = castle;
  const wallLeft = left - 1;
  const wallRight = right + 1;
  const wallTop = top - 1;
  const wallBottom = bottom + 1;

  const towerTiles = new Set<TileKey>();
  for (const tower of allTowers ?? [castle.tower]) {
    forEachTowerTile(tower, (_r, _c, key) => towerTiles.add(key));
  }
  const isTower = (r: number, c: number) => towerTiles.has(packTile(r, c));

  // Scale mistake probability with castle perimeter — small castles can't afford errors
  // Top+bottom rows counted fully, left+right columns minus corners to avoid double-counting
  const perimeter =
    2 * (wallRight - wallLeft + 1) + 2 * (wallBottom - wallTop - 1);
  // Reference perimeter (~22 for a margin-2 castle around a centroid tower).
  // Mistakes scale linearly: half-size castle → half the per-tile chance.
  const REF_PERIMETER = 22;
  const clumsyScale = Math.min(1, perimeter / REF_PERIMETER);

  // Identify the 4 corners of the wall ring
  const corners: [number, number][] = [
    [wallTop, wallLeft],
    [wallTop, wallRight],
    [wallBottom, wallLeft],
    [wallBottom, wallRight],
  ];

  // For each corner, ~1/12 chance (scaled) to add an extra wall tile
  // adjacent to the corner (cardinal direction inward), creating a bump.
  for (const [cr, cc] of corners) {
    if (!rng.bool(CLUMSY_CORNER_CHANCE * clumsyScale)) continue;
    const key = packTile(cr, cc);
    if (!walls.has(key)) continue;
    // Pick one of the two cardinal-inward neighbors (toward interior)
    const dr = cr === wallTop ? 1 : -1;
    const dc = cc === wallLeft ? 1 : -1;
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
    const { row, col } = unpackTile(key);

    // Collect candidate neighbors (4-connected) that aren't already walls or tower
    const candidates: [number, number][] = [];
    for (const [dr, dc] of DIRS_4) {
      const nr = row + dr;
      const nc = col + dc;
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
    const { row, col } = unpackTile(key);
    let neighbors = 0;
    for (const [dr, dc] of DIRS_4) {
      const nr = row + dr;
      const nc = col + dc;
      if (!inBounds(nr, nc)) continue;
      if (walls.has(packTile(nr, nc))) neighbors++;
    }
    if (neighbors === 0) {
      walls.delete(key);
    }
  }
}

/**
 * Seed a freshly-(re)built zone up to the initial house count. Called after
 * castle construction — game start (all zones empty) and the reselect after a
 * life loss (where `resetZoneState` cleared the loser's zone). Zones that have
 * accumulated growth above the base are left untouched, so an unrelated
 * player's reselect never resets a healthy neighbour.
 */
export function seedInitialHouses(state: GameState): void {
  for (const player of state.players) {
    if (!isPlayerSeated(player)) continue;
    const zone = player.homeTower.zone;
    const aliveInZone = state.map.houses.filter(
      (h) => h.zone === zone && h.alive,
    ).length;
    if (aliveInZone < INITIAL_HOUSES_PER_ZONE) {
      // Remove dead houses in zone first to free up positions
      state.map.houses = state.map.houses.filter(
        (h) => h.zone !== zone || h.alive,
      );
      spawnHousesInZone(state, zone, INITIAL_HOUSES_PER_ZONE - aliveInZone);
    }
  }
}

/**
 * Grow each surviving zone's population by a fixed number of houses. Called
 * once per round at battle-done (before the next build). Houses accumulate
 * across rounds without a cap — matching DOS Rampart, where the house field
 * grows ~+2/zone/round all game. Dead houses (destroyed in battle) are dropped
 * first so the new ones can reuse their spots.
 */
export function growZoneHouses(state: GameState): void {
  for (const player of state.players) {
    if (!isPlayerSeated(player)) continue;
    const zone = player.homeTower.zone;
    state.map.houses = state.map.houses.filter(
      (h) => h.zone !== zone || h.alive,
    );
    spawnHousesInZone(state, zone, HOUSES_GROWTH_PER_ROUND);
  }
}

/**
 * Order castle wall tiles for the build animation.
 * Walks the clean ring in perimeter order (CW or CCW), then interleaves
 * any extra tiles from clumsy builders right after their ring neighbor.
 *
 * Three tile sets in play (may overlap):
 *   ringSet    — ideal 1-tile-wide perimeter ring before clumsy builders
 *   finalWalls — all wall tiles that survived clumsy builders (ring ∩ survivors + extras)
 *   extras     — tiles added by clumsy builders that are NOT in the original ring
 *
 * activeRing is ringSet ∩ finalWalls: ring tiles that survived the sweep.
 */
export function orderCastleWallsForAnimation(
  castle: Castle,
  ringTiles: readonly [number, number][],
  finalWalls: ReadonlySet<TileKey>,
  rng: Rng,
): TileKey[] {
  // Pack the ideal ring into a fast-lookup set
  const ringSet = new Set<TileKey>();
  for (const [r, c] of ringTiles) ringSet.add(packTile(r, c));

  // Walk the ring in perimeter order (randomly CW or CCW)
  const ringWalk = buildPerimeterWalk(castle, ringSet);
  if (rng.bool(CASTLE_RING_REVERSE_CHANCE)) ringWalk.reverse();

  // Extras = clumsy-builder tiles outside the original ring
  const extras = new Set<TileKey>();
  for (const k of finalWalls) {
    if (!ringSet.has(k)) extras.add(k);
  }

  // Ring tiles that survived the clumsy-builder sweep (≤1 neighbor removal)
  const activeRing = ringWalk.filter((k) => finalWalls.has(k));

  return interleaveExtras(activeRing, extras, finalWalls);
}

/**
 * Spawn up to `count` new houses in a single zone, avoiding walls, cannons,
 * towers, and their margins. Appends to state.map.houses (existing houses are
 * kept). Places fewer than `count` if the zone runs out of valid spots — the
 * natural cap that produces the original's late-game +1/+0 rounds in crowded
 * zones. Private — only called internally during castle finalization.
 */
function spawnHousesInZone(
  state: GameState,
  zoneId: ZoneId,
  count: number,
): void {
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

  // Shuffle once so ties in distance are broken by random order. R5b: the
  // candidate count is board-derived, so shuffle on a private Rng (keyed by
  // zone) — the shared cursor must not advance by a board-dependent count.
  const localRng = new Rng(
    deriveBoardLocalSeed(
      state.rng.seed,
      state.round,
      BOARD_LOCAL_SITE.HOUSE_REFILL,
      zoneId,
    ),
  );
  localRng.shuffle(candidates);

  const existingHouses = state.map.houses;

  // Furthest-point sampling: greedily pick the candidate that maximizes
  // its minimum distance to all already-placed houses, spreading them evenly.
  for (let placed = 0; placed < count && candidates.length > 0; placed++) {
    let bestIdx = -1;
    let bestDist = -1;
    for (let i = 0; i < candidates.length; i++) {
      const [r, c] = candidates[i]!;
      const dist = minDistToHouses(existingHouses, r, c);
      if (dist < HOUSE_MIN_DISTANCE) continue;
      if (dist > bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    const [r, c] = candidates[bestIdx]!;
    existingHouses.push({ row: r, col: c, zone: zoneId, alive: true });
    candidates.splice(bestIdx, 1);
  }
}

function buildTowerTileSet(towers: readonly Tower[]): Set<TileKey> {
  const towerTiles = new Set<TileKey>();
  for (const tower of towers) {
    forEachTowerTile(tower, (_r, _c, key) => towerTiles.add(key));
  }
  return towerTiles;
}

/** Check if a position is a valid house candidate (grass, correct zone, away from water and towers). */
function isValidHousePos(
  tiles: readonly Tile[][],
  zones: readonly ZoneCell[][],
  towerTiles: ReadonlySet<TileKey>,
  r: number,
  c: number,
  zoneId: ZoneId,
): boolean {
  if (!isGrass(tiles, r, c)) return false;
  if (zones[r]![c] !== zoneId) return false;
  if (towerTiles.has(packTile(r, c))) return false;
  // All 8 neighbors must be grass (1-tile margin from water/edge)
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++)
      if (!isGrass(tiles, r + dr, c + dc)) return false;
  // Not adjacent to a tower (1 tile gap)
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++)
      if (towerTiles.has(packTile(r + dr, c + dc))) return false;
  return true;
}

/** Minimum manhattan distance from (r,c) to any existing house (Infinity if none). */
function minDistToHouses(
  houses: readonly House[],
  r: number,
  c: number,
): number {
  let min = Infinity;
  for (const h of houses) {
    const dist = manhattanDistance(h.row, h.col, r, c);
    if (dist < min) min = dist;
  }
  return min;
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

/** Walk the castle perimeter clockwise: top→right→bottom→left. */
function buildPerimeterWalk(
  castle: Castle,
  ringSet: ReadonlySet<TileKey>,
): TileKey[] {
  const wallLeft = castle.left - 1,
    wallRight = castle.right + 1,
    wallTop = castle.top - 1,
    wallBottom = castle.bottom + 1;

  const walk: TileKey[] = [];
  // Top edge (left to right)
  for (let c = wallLeft; c <= wallRight; c++) {
    const key = packTile(wallTop, c);
    if (ringSet.has(key)) walk.push(key);
  }
  // Right edge (top+1 to bottom)
  for (let r = wallTop + 1; r <= wallBottom; r++) {
    const key = packTile(r, wallRight);
    if (ringSet.has(key)) walk.push(key);
  }
  // Bottom edge (right-1 to left)
  for (let c = wallRight - 1; c >= wallLeft; c--) {
    const key = packTile(wallBottom, c);
    if (ringSet.has(key)) walk.push(key);
  }
  // Left edge (bottom-1 to top+1)
  for (let r = wallBottom - 1; r > wallTop; r--) {
    const key = packTile(r, wallLeft);
    if (ringSet.has(key)) walk.push(key);
  }
  return walk;
}

/** After each ring tile, insert any adjacent extra tiles, then append remainders. */
function interleaveExtras(
  activeRing: readonly TileKey[],
  extras: ReadonlySet<TileKey>,
  finalWalls: ReadonlySet<TileKey>,
): TileKey[] {
  const ordered: TileKey[] = [];
  const placed = new Set<TileKey>();
  for (const k of activeRing) {
    if (placed.has(k)) continue;
    ordered.push(k);
    placed.add(k);
    const { row, col } = unpackTile(k);
    for (const [dr, dc] of DIRS_4) {
      const nr = row + dr;
      const nc = col + dc;
      if (!inBounds(nr, nc)) continue;
      const neighborKey = packTile(nr, nc);
      if (extras.has(neighborKey) && !placed.has(neighborKey)) {
        ordered.push(neighborKey);
        placed.add(neighborKey);
      }
    }
  }
  // Safety: add any remaining tiles not yet placed
  for (const k of finalWalls) {
    if (!placed.has(k)) ordered.push(k);
  }
  return ordered;
}
