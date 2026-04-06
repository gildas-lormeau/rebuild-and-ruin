/**
 * Environmental round modifiers — modern mode only.
 *
 * Each modifier has a static definition (weight, announce/apply timing)
 * and an apply function that mutates GameState using existing subsystems.
 * Selection uses the synced RNG for online determinism.
 */

import type { BurningPit } from "../shared/battle-types.ts";
import {
  deletePlayerWallsBatch,
  getInterior,
  hasCannonAt,
  hasTowerAt,
  removeWallFromAllPlayers,
} from "../shared/board-occupancy.ts";
import {
  BURNING_PIT_DURATION,
  FIRST_GRUNT_SPAWN_ROUND,
  GAME_MODE_MODERN,
  MODIFIER_FIRST_ROUND,
  MODIFIER_ROLL_CHANCE,
  type ModifierId,
} from "../shared/game-constants.ts";
import { GRID_COLS, GRID_ROWS } from "../shared/grid.ts";
import { isPlayerSeated } from "../shared/player-types.ts";
import {
  DIRS_4,
  isGrass,
  isWater,
  packTile,
  unpackTile,
} from "../shared/spatial.ts";
import type { GameState } from "../shared/types.ts";
import { spawnGruntSurgeOnZone } from "./grunt-system.ts";

interface ModifierDef {
  readonly id: ModifierId;
  readonly label: string;
  readonly weight: number;
}

const MODIFIER_POOL: readonly ModifierDef[] = [
  { id: "wildfire", label: "Wildfire", weight: 3 },
  { id: "crumbling_walls", label: "Crumbling Walls", weight: 3 },
  { id: "grunt_surge", label: "Grunt Surge", weight: 2 },
  { id: "frozen_river", label: "Frozen River", weight: 2 },
];
/** Extra grunts per player during a grunt surge.
 *  Baseline is ~15 grunts per territory in a typical game,
 *  so 6-10 extra is a serious but not overwhelming spike. */
const GRUNT_SURGE_COUNT_MIN = 6;
const GRUNT_SURGE_COUNT_MAX = 10;
/** Spine length for wildfire scar (fattened neighbors bring total to ~10). */
const WILDFIRE_SPINE_LENGTH = 4;
/** Wildfire: probability the fire continues in its main direction (vs random). */
const WILDFIRE_MAIN_DIR_BIAS = 0.7;
/** Wildfire: probability each spine-neighbor tile catches fire during fattening. */
const WILDFIRE_FATTEN_CHANCE = 0.35;
/** Crumbling walls: fraction of outer walls destroyed. */
const CRUMBLE_FRACTION = 0.18;
const CRUMBLE_MIN = 3;
const CRUMBLE_MAX = 12;

/** Roll a modifier for the current round. Returns null if no modifier fires.
 *  Must be called at a deterministic point using state.rng for online sync. */
export function rollModifier(state: GameState): ModifierId | null {
  if (state.gameMode !== GAME_MODE_MODERN) return null;
  if (state.round < MODIFIER_FIRST_ROUND) return null;
  if (!state.rng.bool(MODIFIER_ROLL_CHANCE)) return null;

  const candidates = MODIFIER_POOL.filter(
    (mod) => mod.id !== state.modern?.lastModifierId,
  );
  if (candidates.length === 0) return null;

  const totalWeight = candidates.reduce((sum, mod) => sum + mod.weight, 0);
  let roll = state.rng.next() * totalWeight;
  for (const mod of candidates) {
    roll -= mod.weight;
    if (roll <= 0) return mod.id;
  }
  return candidates[candidates.length - 1]!.id;
}

/** Apply wildfire: burn an elongated scar of ~10 tiles via random walk.
 *  Only targets zones owned by alive players, avoids towers and cannons.
 *  Returns the set of scar tile keys for the reveal banner. */
export function applyWildfire(state: GameState): ReadonlySet<number> {
  const scar = generateWildfireScar(state);
  if (scar.size === 0) return scar;
  applyWildfireScar(state, scar);
  return scar;
}

/** Apply crumbling walls: destroy a fraction of each player's outermost walls.
 *  Returns the array of destroyed wall tile keys for the reveal banner. */
export function applyCrumblingWalls(state: GameState): readonly number[] {
  const tiles = state.map.tiles;
  const cols = tiles[0]!.length;
  const destroyed: number[] = [];

  for (const player of state.players) {
    if (player.eliminated || player.walls.size === 0) continue;

    // Outer walls: wall tiles with at least one non-wall non-interior neighbor
    const interior = getInterior(player);
    const outerWalls: number[] = [];
    for (const key of player.walls) {
      const r = Math.floor(key / cols);
      const c = key % cols;
      const neighbors = [
        [r - 1, c],
        [r + 1, c],
        [r, c - 1],
        [r, c + 1],
      ];
      const isOuter = neighbors.some(([nr, nc]) => {
        const nk = nr! * cols + nc!;
        return !player.walls.has(nk) && !interior.has(nk);
      });
      if (isOuter) outerWalls.push(key);
    }

    if (outerWalls.length === 0) continue;

    // Protect castle wall tiles from crumbling
    const destructible = outerWalls.filter(
      (k) => !player.castleWallTiles.has(k),
    );
    if (destructible.length === 0) continue;

    const count = Math.min(
      Math.max(CRUMBLE_MIN, Math.round(destructible.length * CRUMBLE_FRACTION)),
      CRUMBLE_MAX,
      destructible.length,
    );

    // Shuffle and pick first `count`
    state.rng.shuffle(destructible);
    const batch = destructible.slice(0, count);
    deletePlayerWallsBatch(player, batch);
    destroyed.push(...batch);
  }
  return destroyed;
}

/** Apply grunt surge: spawn extra grunts distributed across all alive towers.
 *  Returns the number of grunts spawned for the reveal banner. */
export function applyGruntSurge(state: GameState): number {
  if (state.round < FIRST_GRUNT_SPAWN_ROUND) return 0;
  const gruntsBefore = state.grunts.length;
  const extraCount = state.rng.int(
    GRUNT_SURGE_COUNT_MIN,
    GRUNT_SURGE_COUNT_MAX,
  );
  for (const player of state.players.filter(isPlayerSeated)) {
    spawnGruntSurgeOnZone(state, player.id, extraCount);
  }
  return state.grunts.length - gruntsBefore;
}

/** Apply frozen river: freeze the entire river, allowing grunts to walk
 *  across zones and target any tower. Lasts through battle + build phase.
 *  Returns the set of frozen tile keys for the reveal banner. */
export function applyFrozenRiver(state: GameState): ReadonlySet<number> {
  const frozen = new Set<number>();
  const tiles = state.map.tiles;
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (isWater(tiles, r, c)) frozen.add(packTile(r, c));
    }
  }
  if (frozen.size === 0) return frozen;
  state.modern!.frozenTiles = frozen;

  // Force all grunts to re-lock targets with zones open — grunts near the
  // river will pick cross-zone towers, grunts far away keep same-zone targets.
  for (const grunt of state.grunts) {
    grunt.targetTowerIdx = undefined;
  }
  return frozen;
}

/** Thaw frozen river: kill grunts stranded on water, clear frozen state. */
export function clearFrozenRiver(state: GameState): void {
  if (!state.modern) return;
  if (state.modern.frozenTiles) {
    state.grunts = state.grunts.filter(
      (gr) => !state.modern!.frozenTiles!.has(packTile(gr.row, gr.col)),
    );
  }
  state.modern.frozenTiles = null;
}

/** Generate the scar shape: random-walk a cardinal spine, then fatten it.
 *  Returns the set of tile keys to burn (empty if no valid seed found). */
function generateWildfireScar(state: GameState): Set<number> {
  const canBurn = buildCanBurnPredicate(state);

  // Collect seed candidates (interior tiles only — skip map border)
  const candidates: { row: number; col: number }[] = [];
  for (let r = 1; r < state.map.tiles.length - 1; r++) {
    for (let c = 1; c < state.map.tiles[0]!.length - 1; c++) {
      if (canBurn(r, c)) candidates.push({ row: r, col: c });
    }
  }
  if (candidates.length === 0) return new Set();

  // Walk a cardinal-only spine (~4 tiles, biased in one direction)
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

/** Build a predicate for whether a tile can burn (grass, active zone, not occupied). */
function buildCanBurnPredicate(
  state: GameState,
): (row: number, col: number) => boolean {
  const tiles = state.map.tiles;
  const zones = state.map.zones;
  const activeZones = new Set(
    state.players.filter(isPlayerSeated).map((pl) => pl.homeTower.zone),
  );
  const burningSet = new Set(
    state.burningPits.map((pit) => packTile(pit.row, pit.col)),
  );
  return (row: number, col: number): boolean => {
    if (!isGrass(tiles, row, col)) return false;
    const zone = zones[row]?.[col];
    if (zone === undefined || !activeZones.has(zone)) return false;
    if (burningSet.has(packTile(row, col))) return false;
    if (hasTowerAt(state, row, col)) return false;
    if (hasCannonAt(state, row, col)) return false;
    return true;
  };
}

/** Destroy walls, houses, grunts, and bonus squares on all scar tiles; create burning pits. */
function applyWildfireScar(state: GameState, scar: ReadonlySet<number>): void {
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
    (bs) => !scar.has(packTile(bs.row, bs.col)),
  );
  state.burningPits.push(...newPits);
}
