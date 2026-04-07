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
import { FID } from "../shared/feature-defs.ts";
import {
  BURNING_PIT_DURATION,
  FIRST_GRUNT_SPAWN_ROUND,
  MODIFIER_FIRST_ROUND,
  MODIFIER_ROLL_CHANCE,
  type ModifierId,
} from "../shared/game-constants.ts";
import { GRID_COLS, GRID_ROWS } from "../shared/grid.ts";
import { IMPLEMENTED_MODIFIERS } from "../shared/modifier-defs.ts";
import { isPlayerSeated } from "../shared/player-types.ts";
import {
  DIRS_4,
  isGrass,
  isWater,
  packTile,
  setWater,
  unpackTile,
} from "../shared/spatial.ts";
import { type GameState, hasFeature } from "../shared/types.ts";
import { spawnGruntSurgeOnZone } from "./grunt-system.ts";

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
const CRUMBLE_FRACTION = 0.09;
const CRUMBLE_MIN = 2;
const CRUMBLE_MAX = 6;
/** Sinkhole: BFS cluster size range. */
const SINKHOLE_MIN_SIZE = 2;
const SINKHOLE_MAX_SIZE = 3;
/** Sinkhole: probability each BFS neighbor joins the cluster. */
const SINKHOLE_FATTEN_CHANCE = 0.4;
/** Sinkhole: cumulative cap across all rounds (prevents excessive map destruction). */
const SINKHOLE_MAX_TOTAL = 24;

/** Roll a modifier for the current round. Returns null if no modifier fires.
 *  Must be called at a deterministic point using state.rng for online sync. */
export function rollModifier(state: GameState): ModifierId | null {
  if (!hasFeature(state, FID.MODIFIERS)) return null;
  if (state.round < MODIFIER_FIRST_ROUND) return null;
  if (!state.rng.bool(MODIFIER_ROLL_CHANCE)) return null;

  const candidates = IMPLEMENTED_MODIFIERS.filter(
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

/** Apply wildfire: one scar per active zone, ~10 tiles each.
 *  Avoids towers, cannons, and water. Returns all scar tile keys for the reveal banner. */
export function applyWildfire(state: GameState): ReadonlySet<number> {
  const activeZones = state.players
    .filter(isPlayerSeated)
    .map((player) => player.homeTower.zone);
  const allScar = new Set<number>();
  for (const zone of activeZones) {
    const scar = generateWildfireScar(state, zone);
    for (const key of scar) allScar.add(key);
  }
  if (allScar.size === 0) return allScar;
  applyWildfireScar(state, allScar);
  return allScar;
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
        const neighborKey = nr! * cols + nc!;
        return !player.walls.has(neighborKey) && !interior.has(neighborKey);
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
  if (!hasFeature(state, FID.MODIFIERS)) return;
  if (state.modern!.frozenTiles) {
    state.grunts = state.grunts.filter(
      (gr) => !state.modern!.frozenTiles!.has(packTile(gr.row, gr.col)),
    );
  }
  state.modern!.frozenTiles = null;
}

/** Apply sinkhole: one cluster per active zone, permanently converting grass to water.
 *  Destroys walls, houses, grunts, bonus squares, and burning pits on affected tiles.
 *  Returns the set of all sinkhole tile keys for the reveal banner. */
export function applySinkhole(state: GameState): ReadonlySet<number> {
  const modern = state.modern!;
  const existing = modern.sinkholeTiles?.size ?? 0;
  if (existing >= SINKHOLE_MAX_TOTAL) return new Set();

  // One cluster per active zone — same tile count for fairness
  const activeZones = state.players
    .filter(isPlayerSeated)
    .map((player) => player.homeTower.zone);
  const budget = Math.min(
    state.rng.int(SINKHOLE_MIN_SIZE, SINKHOLE_MAX_SIZE),
    Math.floor((SINKHOLE_MAX_TOTAL - existing) / activeZones.length),
  );
  if (budget <= 0) return new Set();
  const allSunk = new Set<number>();

  for (const zone of activeZones) {
    const cluster = generateSinkholeCluster(state, budget, zone);
    for (const key of cluster) allSunk.add(key);
  }
  if (allSunk.size === 0) return allSunk;

  // Mutate tiles to water
  const tiles = state.map.tiles;
  for (const key of allSunk) {
    const { r, c } = unpackTile(key);
    setWater(tiles, r, c);
  }

  // Destroy structures on sinkhole tiles (reuses wildfire's pattern)
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

/** Re-apply sinkhole tile mutations on a map regenerated from seed.
 *  Called during checkpoint restore and full-state recovery. Idempotent. */
export function reapplySinkholeTiles(state: GameState): void {
  const sinkhole = state.modern?.sinkholeTiles;
  if (!sinkhole || sinkhole.size === 0) return;
  const tiles = state.map.tiles;
  for (const key of sinkhole) {
    const { r, c } = unpackTile(key);
    setWater(tiles, r, c);
  }
  state.map.mapVersion++;
}

/** Generate a sinkhole cluster via BFS flood-fill from a random seed tile.
 *  Retries with a new seed if the cluster is undersized (e.g., boxed in by obstacles). */
function generateSinkholeCluster(
  state: GameState,
  budget: number,
  zone: number,
): Set<number> {
  const canSink = buildCanSinkPredicate(state, zone);

  // Collect candidates (interior tiles only — skip map border)
  const candidates: { row: number; col: number }[] = [];
  for (let r = 1; r < GRID_ROWS - 1; r++) {
    for (let c = 1; c < GRID_COLS - 1; c++) {
      if (canSink(r, c)) candidates.push({ row: r, col: c });
    }
  }
  if (candidates.length === 0) return new Set();

  let best = new Set<number>();
  for (let attempt = 0; attempt < 3; attempt++) {
    const cluster = growSinkholeFromSeed(state, canSink, candidates, budget);
    if (cluster.size >= budget) return cluster;
    if (cluster.size > best.size) best = cluster;
  }
  return best;
}

/** BFS-grow a sinkhole cluster from a random seed tile. */
function growSinkholeFromSeed(
  state: GameState,
  canSink: (row: number, col: number) => boolean,
  candidates: readonly { row: number; col: number }[],
  budget: number,
): Set<number> {
  const seed = state.rng.pick(candidates);
  const cluster = new Set<number>();
  cluster.add(packTile(seed.row, seed.col));

  const frontier = [seed];
  while (cluster.size < budget && frontier.length > 0) {
    const idx = state.rng.int(0, frontier.length - 1);
    const tile = frontier[idx]!;
    frontier[idx] = frontier[frontier.length - 1]!;
    frontier.pop();

    for (const [dr, dc] of DIRS_4) {
      const nr = tile.row + dr;
      const nc = tile.col + dc;
      const key = packTile(nr, nc);
      if (cluster.has(key)) continue;
      if (!canSink(nr, nc)) continue;
      if (!state.rng.bool(SINKHOLE_FATTEN_CHANCE)) continue;
      cluster.add(key);
      frontier.push({ row: nr, col: nc });
      if (cluster.size >= budget) break;
    }
  }
  return cluster;
}

/** Build a predicate for whether a tile can become a sinkhole in a specific zone. */
function buildCanSinkPredicate(
  state: GameState,
  targetZone: number,
): (row: number, col: number) => boolean {
  const tiles = state.map.tiles;
  const zones = state.map.zones;
  const existingSinkhole = state.modern?.sinkholeTiles ?? new Set<number>();
  return (row: number, col: number): boolean => {
    if (!isGrass(tiles, row, col)) return false;
    if (zones[row]?.[col] !== targetZone) return false;
    if (existingSinkhole.has(packTile(row, col))) return false;
    if (hasTowerAt(state, row, col)) return false;
    if (hasCannonAt(state, row, col)) return false;
    // 1-tile gap from map edges, towers, and water so players can wall around
    if (row <= 1 || row >= GRID_ROWS - 2 || col <= 1 || col >= GRID_COLS - 2)
      return false;
    for (const [dr, dc] of DIRS_4) {
      if (isWater(tiles, row + dr, col + dc)) return false;
      if (hasTowerAt(state, row + dr, col + dc)) return false;
    }
    return true;
  };
}

/** Generate the scar shape: random-walk a cardinal spine, then fatten it.
 *  Retries with a new seed if the walk gets stuck (e.g., boxed in by water/towers). */
function generateWildfireScar(state: GameState, zone: number): Set<number> {
  const canBurn = buildCanBurnPredicate(state, zone);

  // Collect seed candidates (interior tiles only — skip map border)
  const candidates: { row: number; col: number }[] = [];
  for (let r = 1; r < state.map.tiles.length - 1; r++) {
    for (let c = 1; c < state.map.tiles[0]!.length - 1; c++) {
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

/** Build a predicate for whether a tile can burn in a specific zone. */
function buildCanBurnPredicate(
  state: GameState,
  targetZone: number,
): (row: number, col: number) => boolean {
  const tiles = state.map.tiles;
  const zones = state.map.zones;
  const burningSet = new Set(
    state.burningPits.map((pit) => packTile(pit.row, pit.col)),
  );
  const rows = tiles.length;
  const cols = tiles[0]!.length;
  return (row: number, col: number): boolean => {
    if (!isGrass(tiles, row, col)) return false;
    if (zones[row]?.[col] !== targetZone) return false;
    if (burningSet.has(packTile(row, col))) return false;
    if (hasTowerAt(state, row, col)) return false;
    if (hasCannonAt(state, row, col)) return false;
    // 1-tile gap from map edges and water so players can enclose the scar
    if (row <= 1 || row >= rows - 2 || col <= 1 || col >= cols - 2)
      return false;
    for (const [dr, dc] of DIRS_4) {
      if (isWater(tiles, row + dr, col + dc)) return false;
    }
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
    (bonus) => !scar.has(packTile(bonus.row, bonus.col)),
  );
  state.burningPits.push(...newPits);
}
