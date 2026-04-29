/**
 * Fire modifiers — wildfire (one scar per zone, ~10 tiles each) and
 * dry lightning (random scattered burning pits on grass tiles per active zone).
 *
 * Merged from wildfire.ts + dry-lightning.ts + fire-helpers.ts so the shared
 * burn predicate and scar applicator sit at the same layer as their callers.
 */

import type { BurningPit } from "../../shared/core/battle-types.ts";
import { BURNING_PIT_DURATION } from "../../shared/core/game-constants.ts";
import { GRID_COLS, GRID_ROWS } from "../../shared/core/grid.ts";
import {
  hasCannonAt,
  hasTowerAt,
} from "../../shared/core/occupancy-queries.ts";
import { removeWallFromAllPlayers } from "../../shared/core/player-walls.ts";
import {
  DIRS_4,
  hasEnclosableMargin,
  isGrass,
  packTile,
  unpackTile,
} from "../../shared/core/spatial.ts";
import type { GameState } from "../../shared/core/types.ts";
import {
  getActiveZones,
  getProtectedCastleTiles,
} from "./modifier-eligibility.ts";
import type { ModifierImpl } from "./modifier-types.ts";

/** Dry lightning: random scattered strikes per active zone. */
const DRY_LIGHTNING_MIN = 3;
const DRY_LIGHTNING_MAX = 5;
/** Spine length for wildfire scar (fattened neighbors bring total to ~10). */
const WILDFIRE_SPINE_LENGTH = 4;
/** Wildfire: probability the fire continues in its main direction (vs random). */
const WILDFIRE_MAIN_DIR_BIAS = 0.7;
/** Wildfire: probability each spine-neighbor tile catches fire during fattening. */
const WILDFIRE_FATTEN_CHANCE = 0.35;
export const dryLightningImpl: ModifierImpl = {
  lifecycle: "instant",
  apply: (state: GameState) => ({
    changedTiles: [...applyDryLightning(state)],
    gruntsSpawned: 0,
  }),
};
export const wildfireImpl: ModifierImpl = {
  lifecycle: "instant",
  apply: (state: GameState) => ({
    changedTiles: [...applyWildfire(state)],
    gruntsSpawned: 0,
  }),
};

/** Apply dry lightning: scatter random burning pits on grass tiles per active zone. */
function applyDryLightning(state: GameState): ReadonlySet<number> {
  const activeZones = getActiveZones(state);
  const allStrikes = new Set<number>();
  for (const zone of activeZones) {
    const canBurn = buildCanBurnPredicate(state, zone);
    const candidates: number[] = [];
    for (let row = 1; row < GRID_ROWS - 1; row++) {
      for (let col = 1; col < GRID_COLS - 1; col++) {
        if (canBurn(row, col)) candidates.push(packTile(row, col));
      }
    }
    if (candidates.length === 0) continue;
    const count = Math.min(
      state.rng.int(DRY_LIGHTNING_MIN, DRY_LIGHTNING_MAX),
      candidates.length,
    );
    state.rng.shuffle(candidates);
    for (let idx = 0; idx < count; idx++) allStrikes.add(candidates[idx]!);
  }
  if (allStrikes.size === 0) return allStrikes;
  applyFireScar(state, allStrikes);
  return allStrikes;
}

/** Apply wildfire: one scar per active zone, ~10 tiles each.
 *  Avoids towers, cannons, and water. Returns all scar tile keys for the reveal banner. */
function applyWildfire(state: GameState): ReadonlySet<number> {
  const activeZones = getActiveZones(state);
  const allScar = new Set<number>();
  for (const zone of activeZones) {
    const scar = generateWildfireScar(state, zone);
    for (const key of scar) allScar.add(key);
  }
  if (allScar.size === 0) return allScar;
  applyFireScar(state, allScar);
  return allScar;
}

/** Destroy walls, houses, grunts, and bonus squares on all scar tiles; create burning pits. */
export function applyFireScar(
  state: GameState,
  scar: ReadonlySet<number>,
): void {
  const protectedTiles = getProtectedCastleTiles(state);
  if (protectedTiles.size > 0) {
    for (const key of scar) {
      if (protectedTiles.has(key)) {
        const { r, c } = unpackTile(key);
        throw new Error(
          `applyFireScar touched fresh-castle tile (${r},${c}) — buildCanBurnPredicate already rejects these, so the caller likely bypassed the predicate`,
        );
      }
    }
  }
  const newPits: BurningPit[] = [];
  for (const key of scar) {
    const { r, c } = unpackTile(key);
    newPits.push({ row: r, col: c, roundsLeft: BURNING_PIT_DURATION });
    removeWallFromAllPlayers(state, key);
    for (const house of state.map.houses) {
      if (house.alive && house.row === r && house.col === c) {
        house.alive = false;
      }
    }
  }
  state.grunts = state.grunts.filter(
    (gr) => !scar.has(packTile(gr.row, gr.col)),
  );
  state.bonusSquares = state.bonusSquares.filter(
    (bonus) => !scar.has(packTile(bonus.row, bonus.col)),
  );
  state.burningPits.push(...newPits);
}

/** Generate the scar shape: random-walk a cardinal spine, then fatten it.
 *  Retries with a new seed if the walk gets stuck (e.g., boxed in by water/towers). */
function generateWildfireScar(state: GameState, zone: number): Set<number> {
  const canBurn = buildCanBurnPredicate(state, zone);

  // Collect seed candidates (interior tiles only — skip map border)
  const candidates: { row: number; col: number }[] = [];
  for (let r = 1; r < GRID_ROWS - 1; r++) {
    for (let c = 1; c < GRID_COLS - 1; c++) {
      if (canBurn(r, c)) candidates.push({ row: r, col: c });
    }
  }
  if (candidates.length === 0) return new Set();

  let best = new Set<number>();
  for (let attempt = 0; attempt < 3; attempt++) {
    const scar = growWildfireFromSeed(state, canBurn, candidates);
    if (scar.size > best.size) best = scar;
    if (best.size >= WILDFIRE_SPINE_LENGTH) break;
  }
  return best;
}

/** Build a predicate for whether a tile can burn in a specific zone. Tiles
 *  protected by a fresh castle's grace period are rejected so scars never
 *  land on the castle tower or its wall ring. */
function buildCanBurnPredicate(
  state: GameState,
  targetZone: number,
): (row: number, col: number) => boolean {
  const protectedTiles = getProtectedCastleTiles(state);
  const tiles = state.map.tiles;
  const zones = state.map.zones;
  const burningSet = new Set(
    state.burningPits.map((pit) => packTile(pit.row, pit.col)),
  );
  return (row: number, col: number): boolean => {
    if (!isGrass(tiles, row, col)) return false;
    if (zones[row]?.[col] !== targetZone) return false;
    if (protectedTiles.has(packTile(row, col))) return false;
    if (burningSet.has(packTile(row, col))) return false;
    if (hasTowerAt(state, row, col)) return false;
    if (hasCannonAt(state, row, col)) return false;
    // 1-tile gap from map edges and water (all 8 directions) so players
    // can always enclose the scar on their territory
    if (!hasEnclosableMargin(tiles, row, col)) return false;
    return true;
  };
}

/** Grow a single wildfire scar from a random seed via cardinal walk + fatten. */
function growWildfireFromSeed(
  state: GameState,
  canBurn: (row: number, col: number) => boolean,
  candidates: readonly { row: number; col: number }[],
): Set<number> {
  const seed = state.rng.pick(candidates);
  const spine: { row: number; col: number }[] = [seed];
  const scar = new Set<number>();
  scar.add(packTile(seed.row, seed.col));
  let cr = seed.row;
  let cc = seed.col;
  let mainDir = state.rng.int(0, DIRS_4.length - 1);

  const maxAttempts = WILDFIRE_SPINE_LENGTH * 8;
  let attempts = 0;
  while (spine.length < WILDFIRE_SPINE_LENGTH && attempts++ < maxAttempts) {
    const dirIdx = state.rng.bool(WILDFIRE_MAIN_DIR_BIAS)
      ? mainDir
      : state.rng.int(0, DIRS_4.length - 1);
    const [dr, dc] = DIRS_4[dirIdx]!;
    const nr = cr + dr;
    const nc = cc + dc;

    if (canBurn(nr, nc) && !scar.has(packTile(nr, nc))) {
      scar.add(packTile(nr, nc));
      spine.push({ row: nr, col: nc });
      cr = nr;
      cc = nc;
    } else {
      mainDir = (mainDir + (state.rng.bool() ? 1 : 3)) % DIRS_4.length;
    }
  }

  // Fatten: each spine tile gets 0-2 cardinal neighbors, giving a 2-3 tile wide scar
  for (const tile of spine) {
    for (const [dr, dc] of DIRS_4) {
      const nr = tile.row + dr;
      const nc = tile.col + dc;
      if (scar.has(packTile(nr, nc))) continue;
      if (!canBurn(nr, nc)) continue;
      if (state.rng.bool(WILDFIRE_FATTEN_CHANCE)) {
        scar.add(packTile(nr, nc));
      }
    }
  }

  return scar;
}
