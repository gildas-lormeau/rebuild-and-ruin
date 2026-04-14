/**
 * Sinkhole modifier — one water cluster per active zone, permanently converting grass.
 * Destroys walls, houses, grunts, bonus squares, and burning pits on affected tiles.
 */

import { GRID_COLS, GRID_ROWS } from "../../shared/core/grid.ts";
import {
  hasCannonAt,
  hasTowerAt,
} from "../../shared/core/occupancy-queries.ts";
import { removeWallFromAllPlayers } from "../../shared/core/player-walls.ts";
import {
  DIRS_8,
  isGrass,
  isWater,
  packTile,
  setGrass,
  setWater,
  unpackTile,
} from "../../shared/core/spatial.ts";
import type { GameState } from "../../shared/core/types.ts";
import {
  getActiveZones,
  getProtectedCastleTiles,
} from "./modifier-eligibility.ts";
import type { ModifierImpl, ModifierTileData } from "./modifier-types.ts";

/** A sinkhole shape is a list of (row, col) offsets from a top-left anchor.
 *  Only shapes that render as recognizable pools through the SDF terrain
 *  pipeline are allowed: short straight runs, 3-cell L corners, and 2×2
 *  squares. T- and +-junctions are intentionally absent — the inside corner
 *  of a junction has too low a peak distance for the SDF to color it as
 *  water, so it would render as a brown blob with disconnected blue dots. */
type SinkholeShape = readonly (readonly [number, number])[];

/** A concrete shape placement: which template, anchored where on the grid. */
type ShapePlacement = { shape: SinkholeShape; row: number; col: number };

/** Sinkhole: shape size range (per zone). Only shapes from SINKHOLE_SHAPES
 *  are used — we never grow free-form clusters because the SDF renderer
 *  can't make a brown banana with bead junctions look like a lake. */
const SINKHOLE_MIN_SIZE = 2;
const SINKHOLE_MAX_SIZE = 4;
/** Sinkhole: cumulative cap across all rounds (prevents excessive map destruction). */
const SINKHOLE_MAX_TOTAL = 36;
const SINKHOLE_SHAPES: ReadonlyMap<number, readonly SinkholeShape[]> = new Map([
  [
    2,
    [
      [
        [0, 0],
        [0, 1],
      ], // horizontal pair
      [
        [0, 0],
        [1, 0],
      ], // vertical pair
    ],
  ],
  [
    3,
    [
      [
        [0, 0],
        [0, 1],
        [0, 2],
      ], // horizontal line
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ], // vertical line
      [
        [0, 0],
        [0, 1],
        [1, 0],
      ], // ⌐ corner
      [
        [0, 0],
        [0, 1],
        [1, 1],
      ], // ¬ corner
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ], // L corner
      [
        [0, 1],
        [1, 0],
        [1, 1],
      ], // ⌟ corner
    ],
  ],
  [
    4,
    [
      [
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
      ], // 2×2 square
    ],
  ],
]);
export const sinkholeImpl: ModifierImpl = {
  apply: (state: GameState) => ({
    changedTiles: [...applySinkhole(state)],
    gruntsSpawned: 0,
  }),
  needsRecheck: true,
  zoneReset: resetSinkholeTilesForZone,
  restore: (state: GameState, data: ModifierTileData) => {
    state.modern!.sinkholeTiles = data.sinkholeTiles
      ? new Set(data.sinkholeTiles)
      : null;
    reapplySinkholeTiles(state);
  },
};

/** Re-apply sinkhole tile mutations on a map regenerated from seed.
 *  Called during checkpoint restore and full-state recovery. Idempotent. */
function reapplySinkholeTiles(state: GameState): void {
  const sinkhole = state.modern?.sinkholeTiles;
  if (!sinkhole || sinkhole.size === 0) return;
  const tiles = state.map.tiles;
  for (const key of sinkhole) {
    const { r, c } = unpackTile(key);
    setWater(tiles, r, c);
  }
  state.map.mapVersion++;
}

/** Per-zone tile revert for sinkhole (zones[r][c] === zone → grass). */
function resetSinkholeTilesForZone(state: GameState, zone: number): void {
  const sinkhole = state.modern?.sinkholeTiles;
  if (!sinkhole) return;
  for (const key of sinkhole) {
    const { r, c } = unpackTile(key);
    if (state.map.zones[r]?.[c] === zone) {
      setGrass(state.map.tiles, r, c);
      sinkhole.delete(key);
    }
  }
  if (sinkhole.size === 0) state.modern!.sinkholeTiles = null;
  state.map.mapVersion++;
}

/** Apply sinkhole: one cluster per active zone, permanently converting grass to water. */
function applySinkhole(state: GameState): ReadonlySet<number> {
  const modern = state.modern;
  if (!modern) return new Set();
  const existing = modern.sinkholeTiles?.size ?? 0;
  if (existing >= SINKHOLE_MAX_TOTAL) return new Set();

  // One shape per active zone — same tile count for fairness
  const activeZones = getActiveZones(state);
  if (activeZones.length === 0) return new Set();
  const candidateBudget = Math.min(
    state.rng.int(SINKHOLE_MIN_SIZE, SINKHOLE_MAX_SIZE),
    Math.floor((SINKHOLE_MAX_TOTAL - existing) / activeZones.length),
  );
  if (candidateBudget < SINKHOLE_MIN_SIZE) return new Set();

  // Find the largest shape size where every active zone has at least one
  // valid placement. Fall back to smaller sizes if a zone is too crowded.
  let chosenSize = 0;
  let placementsPerZone: ShapePlacement[][] = [];
  for (let size = candidateBudget; size >= SINKHOLE_MIN_SIZE; size--) {
    const allZones = activeZones.map((zone) =>
      findValidShapePlacements(state, zone, size),
    );
    if (allZones.every((placements) => placements.length > 0)) {
      chosenSize = size;
      placementsPerZone = allZones;
      break;
    }
  }
  if (chosenSize === 0) return new Set();

  const allSunk = new Set<number>();
  for (let i = 0; i < activeZones.length; i++) {
    const placements = placementsPerZone[i]!;
    const pick = state.rng.pick(placements);
    for (const [dr, dc] of pick.shape) {
      allSunk.add(packTile(pick.row + dr, pick.col + dc));
    }
  }
  if (allSunk.size === 0) return allSunk;

  // Mutate tiles to water
  const tiles = state.map.tiles;
  for (const key of allSunk) {
    const { r, c } = unpackTile(key);
    setWater(tiles, r, c);
  }

  // Destroy structures on sinkhole tiles
  for (const key of allSunk) {
    const { r, c } = unpackTile(key);
    removeWallFromAllPlayers(state, key);
    for (const house of state.map.houses) {
      if (house.alive && house.row === r && house.col === c) {
        house.alive = false;
      }
    }
  }
  state.grunts = state.grunts.filter(
    (gr) => !allSunk.has(packTile(gr.row, gr.col)),
  );
  state.bonusSquares = state.bonusSquares.filter(
    (bonus) => !allSunk.has(packTile(bonus.row, bonus.col)),
  );
  state.burningPits = state.burningPits.filter(
    (pit) => !allSunk.has(packTile(pit.row, pit.col)),
  );

  // Track cumulative sinkhole tiles
  if (!modern.sinkholeTiles) modern.sinkholeTiles = new Set();
  for (const key of allSunk) modern.sinkholeTiles.add(key);

  state.map.mapVersion++;
  return allSunk;
}

/** Enumerate every legal anchor position for every allowed shape of the
 *  given size in the target zone. */
function findValidShapePlacements(
  state: GameState,
  zone: number,
  size: number,
): ShapePlacement[] {
  const canSink = buildCanSinkPredicate(state, zone);
  const shapes = SINKHOLE_SHAPES.get(size) ?? [];
  const placements: ShapePlacement[] = [];
  for (const shape of shapes) {
    for (let r = 1; r < GRID_ROWS - 1; r++) {
      for (let c = 1; c < GRID_COLS - 1; c++) {
        let fits = true;
        for (const [dr, dc] of shape) {
          if (!canSink(r + dr, c + dc)) {
            fits = false;
            break;
          }
        }
        if (fits) placements.push({ shape, row: r, col: c });
      }
    }
  }
  return placements;
}

/** Build a predicate for whether a tile can become a sinkhole in a specific zone. */
function buildCanSinkPredicate(
  state: GameState,
  targetZone: number,
): (row: number, col: number) => boolean {
  const tiles = state.map.tiles;
  const zones = state.map.zones;
  const existingSinkhole = state.modern?.sinkholeTiles ?? new Set<number>();
  const protectedTiles = getProtectedCastleTiles(state);
  return (row: number, col: number): boolean => {
    if (!isGrass(tiles, row, col)) return false;
    if (zones[row]?.[col] !== targetZone) return false;
    if (protectedTiles.has(packTile(row, col))) return false;
    if (existingSinkhole.has(packTile(row, col))) return false;
    if (hasTowerAt(state, row, col)) return false;
    if (hasCannonAt(state, row, col)) return false;
    // 1-tile gap from map edges, towers, and water so players can wall around
    if (row <= 1 || row >= GRID_ROWS - 2 || col <= 1 || col >= GRID_COLS - 2)
      return false;
    for (const [dr, dc] of DIRS_8) {
      if (isWater(tiles, row + dr, col + dc)) return false;
      if (hasTowerAt(state, row + dr, col + dc)) return false;
    }
    return true;
  };
}
