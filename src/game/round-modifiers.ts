/**
 * Environmental round modifiers — modern mode only.
 *
 * Each modifier has a static definition (weight, announce/apply timing)
 * and an apply function that mutates GameState using existing subsystems.
 * Selection uses the synced RNG for online determinism.
 */

import type { BurningPit } from "../shared/core/battle-types.ts";
import {
  deletePlayerWallsBatch,
  getInterior,
  hasCannonAt,
  hasTowerAt,
  removeWallFromAllPlayers,
} from "../shared/core/board-occupancy.ts";
import { FID } from "../shared/core/feature-defs.ts";
import {
  BURNING_PIT_DURATION,
  FIRST_GRUNT_SPAWN_ROUND,
  MODIFIER_FIRST_ROUND,
  MODIFIER_ID,
  MODIFIER_ROLL_CHANCE,
  type ModifierId,
} from "../shared/core/game-constants.ts";
import { GRID_COLS, GRID_ROWS } from "../shared/core/grid.ts";
import { IMPLEMENTED_MODIFIERS } from "../shared/core/modifier-defs.ts";
import {
  isPlayerEliminated,
  isPlayerSeated,
} from "../shared/core/player-types.ts";
import {
  cannonSize,
  DIRS_4,
  DIRS_8,
  isCannonAlive,
  isGrass,
  isWater,
  packTile,
  setGrass,
  setWater,
  unpackTile,
} from "../shared/core/spatial.ts";
import { type GameState, hasFeature } from "../shared/core/types.ts";
import { spawnGruntSurgeOnZone } from "./grunt-system.ts";

/** A sinkhole shape is a list of (row, col) offsets from a top-left anchor.
 *  Only shapes that render as recognizable pools through the SDF terrain
 *  pipeline are allowed: short straight runs, 3-cell L corners, and 2×2
 *  squares. T- and +-junctions are intentionally absent — the inside corner
 *  of a junction has too low a peak distance for the SDF to color it as
 *  water, so it would render as a brown blob with disconnected blue dots. */
type SinkholeShape = readonly (readonly [number, number])[];

/** A concrete shape placement: which template, anchored where on the grid. */
type ShapePlacement = { shape: SinkholeShape; row: number; col: number };

/** Checkpoint data shape — the subset of checkpoint fields this helper reads. */
interface ModifierTileData {
  readonly frozenTiles?: readonly number[] | null;
  readonly highTideTiles?: readonly number[] | null;
  readonly sinkholeTiles?: readonly number[] | null;
}

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
/** Sinkhole: shape size range (per zone). Only shapes from SINKHOLE_SHAPES
 *  are used — we never grow free-form clusters because the SDF renderer
 *  can't make a brown banana with bead junctions look like a lake. */
const SINKHOLE_MIN_SIZE = 2;
const SINKHOLE_MAX_SIZE = 4;
/** Sinkhole: cumulative cap across all rounds (prevents excessive map destruction). */
const SINKHOLE_MAX_TOTAL = 36;
/** Maximum trajectory jitter (degrees) applied by Dust Storm. */
const DUST_STORM_JITTER_DEG = 15;
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

/** Apply Dust Storm trajectory jitter to a target offset. Returns the
 *  perturbed (x, y) world position when Dust Storm is active, or the
 *  original target unchanged otherwise. RNG is consumed only when the
 *  modifier is active and the target is non-degenerate — preserving
 *  determinism with the original inline implementation. */
export function applyDustStormJitter(
  state: GameState,
  startX: number,
  startY: number,
  targetX: number,
  targetY: number,
): { x: number; y: number } {
  if (state.modern?.activeModifier !== MODIFIER_ID.DUST_STORM) {
    return { x: targetX, y: targetY };
  }
  const dx = targetX - startX;
  const dy = targetY - startY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return { x: targetX, y: targetY };
  const jitterRad =
    ((state.rng.next() * 2 - 1) * DUST_STORM_JITTER_DEG * Math.PI) / 180;
  const cosJ = Math.cos(jitterRad);
  const sinJ = Math.sin(jitterRad);
  return {
    x: startX + (dx * cosJ - dy * sinJ),
    y: startY + (dx * sinJ + dy * cosJ),
  };
}

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
  const destroyed: number[] = [];

  for (const player of state.players) {
    if (isPlayerEliminated(player) || player.walls.size === 0) continue;

    // Outer walls: wall tiles with at least one non-wall non-interior neighbor
    const interior = getInterior(player);
    const outerWalls: number[] = [];
    for (const key of player.walls) {
      const { r, c } = unpackTile(key);
      const isOuter = DIRS_4.some(([dr, dc]) => {
        const neighborKey = packTile(r + dr, c + dc);
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
  const modern = state.modern;
  if (!modern) return new Set();
  const frozen = new Set<number>();
  const tiles = state.map.tiles;
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (isWater(tiles, r, c)) frozen.add(packTile(r, c));
    }
  }
  if (frozen.size === 0) return frozen;
  modern.frozenTiles = frozen;

  // Force all grunts to re-lock targets with zones open — grunts near the
  // river will pick cross-zone towers, grunts far away keep same-zone targets.
  for (const grunt of state.grunts) {
    grunt.targetTowerIdx = undefined;
  }
  return frozen;
}

/** Thaw frozen river: kill grunts stranded on water, clear frozen state. */
export function clearFrozenRiver(state: GameState): void {
  const modern = state.modern;
  if (!modern || !hasFeature(state, FID.MODIFIERS)) return;
  if (modern.frozenTiles) {
    state.grunts = state.grunts.filter(
      (gr) => !modern.frozenTiles!.has(packTile(gr.row, gr.col)),
    );
  }
  modern.frozenTiles = null;
}

/** Apply high tide: flood grass tiles adjacent to water (river banks widen by 1 tile).
 *  Destroys walls, houses, grunts, bonus squares, and burning pits on flooded tiles.
 *  Returns the set of flooded tile keys for the reveal banner. */
export function applyHighTide(state: GameState): ReadonlySet<number> {
  const modern = state.modern;
  if (!modern) return new Set();
  const tiles = state.map.tiles;
  const flooded = new Set<number>();
  // Find all grass tiles that are 4-dir adjacent to water
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (!isGrass(tiles, r, c)) continue;
      if (hasTowerAt(state, r, c)) continue;
      for (const [dr, dc] of DIRS_4) {
        if (isWater(tiles, r + dr, c + dc)) {
          flooded.add(packTile(r, c));
          break;
        }
      }
    }
  }
  if (flooded.size === 0) return flooded;
  // Convert to water
  for (const key of flooded) {
    const { r, c } = unpackTile(key);
    setWater(tiles, r, c);
  }
  // Destroy structures on flooded tiles
  for (const key of flooded) {
    removeWallFromAllPlayers(state, key);
  }
  for (const key of flooded) {
    const { r, c } = unpackTile(key);
    for (const house of state.map.houses) {
      if (house.alive && house.row === r && house.col === c)
        house.alive = false;
    }
  }
  state.grunts = state.grunts.filter(
    (gr) => !flooded.has(packTile(gr.row, gr.col)),
  );
  state.bonusSquares = state.bonusSquares.filter(
    (bonus) => !flooded.has(packTile(bonus.row, bonus.col)),
  );
  state.burningPits = state.burningPits.filter(
    (pit) => !flooded.has(packTile(pit.row, pit.col)),
  );
  // Remove cannons on flooded tiles
  for (const player of state.players) {
    player.cannons = player.cannons.filter((cannon) => {
      const sz = cannonSize(cannon.mode);
      for (let dr = 0; dr < sz; dr++) {
        for (let dc = 0; dc < sz; dc++) {
          if (flooded.has(packTile(cannon.row + dr, cannon.col + dc)))
            return false;
        }
      }
      return true;
    });
  }
  modern.highTideTiles = flooded;
  state.map.mapVersion++;
  return flooded;
}

/** Revert high tide: restore flooded tiles back to grass. */
export function clearHighTide(state: GameState): void {
  const modern = state.modern;
  if (!modern || !hasFeature(state, FID.MODIFIERS)) return;
  if (!modern.highTideTiles) return;
  const tiles = state.map.tiles;
  for (const key of modern.highTideTiles) {
    const { r, c } = unpackTile(key);
    setGrass(tiles, r, c);
  }
  modern.highTideTiles = null;
  state.map.mapVersion++;
}

/** Apply sinkhole: one cluster per active zone, permanently converting grass to water.
 *  Destroys walls, houses, grunts, bonus squares, and burning pits on affected tiles.
 *  Returns the set of all sinkhole tile keys for the reveal banner. */
export function applySinkhole(state: GameState): ReadonlySet<number> {
  const modern = state.modern;
  if (!modern) return new Set();
  const existing = modern.sinkholeTiles?.size ?? 0;
  if (existing >= SINKHOLE_MAX_TOTAL) return new Set();

  // One shape per active zone — same tile count for fairness
  const activeZones = state.players
    .filter(isPlayerSeated)
    .map((player) => player.homeTower.zone);
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

/** Restore tile-mutating modifier state from checkpoint data (watcher +
 *  host-promotion path). Sets frozenTiles / highTideTiles / sinkholeTiles on
 *  state.modern from the checkpoint, then re-mutates the map tiles (which
 *  are regenerated from seed and thus need the modifier tiles reapplied).
 *
 *  No-op if the modifiers feature is not active for this match. */
export function applyCheckpointModifierTiles(
  state: GameState,
  data: ModifierTileData,
): void {
  if (!hasFeature(state, FID.MODIFIERS)) return;
  if ("frozenTiles" in data) {
    state.modern!.frozenTiles = data.frozenTiles
      ? new Set(data.frozenTiles)
      : null;
  }
  state.modern!.highTideTiles = data.highTideTiles
    ? new Set(data.highTideTiles)
    : null;
  state.modern!.sinkholeTiles = data.sinkholeTiles
    ? new Set(data.sinkholeTiles)
    : null;
  reapplyHighTideTiles(state);
  reapplySinkholeTiles(state);
}

/** Apply rubble clearing: remove all dead cannon debris and burning pits.
 *  Returns the tile keys of cleared positions for the reveal banner. */
export function applyRubbleClearing(state: GameState): readonly number[] {
  const cleared: number[] = [];
  // Collect dead cannon tile positions before removal
  for (const player of state.players) {
    if (isPlayerEliminated(player)) continue;
    for (const cannon of player.cannons) {
      if (isCannonAlive(cannon)) continue;
      const sz = cannonSize(cannon.mode);
      for (let dr = 0; dr < sz; dr++) {
        for (let dc = 0; dc < sz; dc++) {
          cleared.push(packTile(cannon.row + dr, cannon.col + dc));
        }
      }
    }
    player.cannons = player.cannons.filter(isCannonAlive);
  }
  // Collect burning pit positions before removal
  for (const pit of state.burningPits) {
    cleared.push(packTile(pit.row, pit.col));
  }
  state.burningPits.length = 0;
  return cleared;
}

/** Re-apply high tide tile mutations on a map regenerated from seed.
 *  Called during checkpoint restore and full-state recovery. Idempotent. */
/** Private — callers outside this file should use `applyCheckpointModifierTiles`. */
function reapplyHighTideTiles(state: GameState): void {
  const highTide = state.modern?.highTideTiles;
  if (!highTide || highTide.size === 0) return;
  const tiles = state.map.tiles;
  for (const key of highTide) {
    const { r, c } = unpackTile(key);
    setWater(tiles, r, c);
  }
  state.map.mapVersion++;
}

/** Re-apply sinkhole tile mutations on a map regenerated from seed.
 *  Called during checkpoint restore and full-state recovery. Idempotent. */
/** Private — callers outside this file should use `applyCheckpointModifierTiles`. */
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

/** Enumerate every legal anchor position for every allowed shape of the
 *  given size in the target zone. The result is small enough (a few hundred
 *  entries on a fresh map) that we can pick uniformly at random. */
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
  return (row: number, col: number): boolean => {
    if (!isGrass(tiles, row, col)) return false;
    if (zones[row]?.[col] !== targetZone) return false;
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
  return (row: number, col: number): boolean => {
    if (!isGrass(tiles, row, col)) return false;
    if (zones[row]?.[col] !== targetZone) return false;
    if (burningSet.has(packTile(row, col))) return false;
    if (hasTowerAt(state, row, col)) return false;
    if (hasCannonAt(state, row, col)) return false;
    // 1-tile gap from map edges and water so players can enclose the scar
    if (row <= 1 || row >= GRID_ROWS - 2 || col <= 1 || col >= GRID_COLS - 2)
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
