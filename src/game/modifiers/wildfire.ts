/**
 * Wildfire modifier — one burning scar per active zone, ~10 tiles each.
 */

import { GRID_COLS, GRID_ROWS } from "../../shared/core/grid.ts";
import { DIRS_4, packTile } from "../../shared/core/spatial.ts";
import type { GameState } from "../../shared/core/types.ts";
import { applyFireScar, buildCanBurnPredicate } from "./fire-helpers.ts";
import { getActiveZones } from "./modifier-eligibility.ts";
import type { ModifierImpl } from "./modifier-types.ts";

/** Spine length for wildfire scar (fattened neighbors bring total to ~10). */
const WILDFIRE_SPINE_LENGTH = 4;
/** Wildfire: probability the fire continues in its main direction (vs random). */
const WILDFIRE_MAIN_DIR_BIAS = 0.7;
/** Wildfire: probability each spine-neighbor tile catches fire during fattening. */
const WILDFIRE_FATTEN_CHANCE = 0.35;
export const wildfireImpl: ModifierImpl = {
  apply: (state: GameState) => ({
    changedTiles: [...applyWildfire(state)],
    gruntsSpawned: 0,
  }),
  needsRecheck: true,
};

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
