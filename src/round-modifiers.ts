/**
 * Environmental round modifiers — modern mode only.
 *
 * Each modifier has a static definition (weight, announce/apply timing)
 * and an apply function that mutates GameState using existing subsystems.
 * Selection uses the synced RNG for online determinism.
 */

import {
  hasCannonAt,
  hasTowerAt,
  removeWallFromAllPlayers,
} from "./board-occupancy.ts";
import {
  BURNING_PIT_DURATION,
  FIRST_GRUNT_SPAWN_ROUND,
  GAME_MODE_MODERN,
  MODIFIER_FIRST_ROUND,
  MODIFIER_ROLL_CHANCE,
  type ModifierId,
} from "./game-constants.ts";
import { spawnGruntSurgeOnZone } from "./grunt-system.ts";
import { DIRS_4, isGrass, packTile, unpackTile } from "./spatial.ts";
import { type BurningPit, type GameState, isPlayerSeated } from "./types.ts";

interface ModifierDef {
  readonly id: ModifierId;
  readonly label: string;
  readonly weight: number;
  /** When to show the banner subtitle. */
  readonly announcePhase:
    | typeof ANNOUNCE_BEFORE_CANNON
    | "before_build"
    | typeof ANNOUNCE_NONE;
}

const ANNOUNCE_BEFORE_CANNON = "before_cannon" as const;
const ANNOUNCE_NONE = "none" as const;
const MODIFIER_POOL: readonly ModifierDef[] = [
  {
    id: "wildfire",
    label: "Wildfire",
    weight: 3,
    announcePhase: ANNOUNCE_BEFORE_CANNON,
  },
  {
    id: "crumbling_walls",
    label: "Crumbling Walls",
    weight: 3,
    announcePhase: ANNOUNCE_NONE,
  },
  {
    id: "grunt_surge",
    label: "Grunt Surge",
    weight: 2,
    announcePhase: ANNOUNCE_BEFORE_CANNON,
  },
];
/** Extra grunts per player during a grunt surge.
 *  Baseline is ~15 grunts per territory in a typical game,
 *  so 8-12 extra is a serious but not overwhelming spike. */
const GRUNT_SURGE_MIN = 8;
const GRUNT_SURGE_MAX = 12;
/** Spine length for wildfire scar (fattened neighbors bring total to ~10). */
const WILDFIRE_SPINE_LENGTH = 4;
/** Crumbling walls: fraction of outer walls destroyed. */
const CRUMBLE_FRACTION = 0.18;
const CRUMBLE_MIN = 3;
const CRUMBLE_MAX = 12;
/** Banner phase constants for modifierBannerText callers. */
export const BANNER_PHASE_CANNON = "cannon" as const;

/** Roll a modifier for the current round. Returns null if no modifier fires.
 *  Must be called at a deterministic point using state.rng for online sync. */
export function rollModifier(state: GameState): ModifierId | null {
  if (state.gameMode !== GAME_MODE_MODERN) return null;
  if (state.round < MODIFIER_FIRST_ROUND) return null;
  if (!state.rng.bool(MODIFIER_ROLL_CHANCE)) return null;

  const candidates = MODIFIER_POOL.filter(
    (mod) => mod.id !== state.lastModifierId,
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

/** Returns banner subtitle for the given phase, or undefined if no announcement. */
export function modifierBannerText(
  modifierId: ModifierId | null,
  bannerPhase: typeof BANNER_PHASE_CANNON | "build",
): string | undefined {
  if (!modifierId) return undefined;
  const def = MODIFIER_POOL.find((mod) => mod.id === modifierId);
  if (!def) return undefined;
  const phase =
    bannerPhase === BANNER_PHASE_CANNON
      ? ANNOUNCE_BEFORE_CANNON
      : "before_build";
  if (def.announcePhase !== phase) return undefined;
  return `${def.label} incoming!`;
}

/** Apply wildfire: burn an elongated scar of ~10 tiles via random walk.
 *  Only targets zones owned by alive players, avoids towers and cannons. */
export function applyWildfire(state: GameState): void {
  const tiles = state.map.tiles;
  const zones = state.map.zones;

  // Zones that belong to alive players
  const activeZones = new Set(
    state.players.filter(isPlayerSeated).map((pl) => pl.homeTower.zone),
  );

  const burningSet = new Set(
    state.burningPits.map((pit) => packTile(pit.row, pit.col)),
  );

  // Valid tile for wildfire: grass, in active zone, not burning, not tower/cannon
  const canBurn = (row: number, col: number): boolean => {
    if (!isGrass(tiles, row, col)) return false;
    const zone = zones[row]?.[col];
    if (zone === undefined || !activeZones.has(zone)) return false;
    if (burningSet.has(packTile(row, col))) return false;
    if (hasTowerAt(state, row, col)) return false;
    if (hasCannonAt(state, row, col)) return false;
    return true;
  };

  // Collect seed candidates
  const candidates: { row: number; col: number }[] = [];
  for (let r = 1; r < tiles.length - 1; r++) {
    for (let c = 1; c < tiles[0]!.length - 1; c++) {
      if (canBurn(r, c)) candidates.push({ row: r, col: c });
    }
  }
  if (candidates.length === 0) return;

  // Phase 1: walk a cardinal-only spine (~6 tiles, no diagonals)
  const seed = state.rng.pick(candidates);
  const spine: { row: number; col: number }[] = [seed];
  const scar = new Set<number>();
  scar.add(packTile(seed.row, seed.col));
  let cr = seed.row;
  let cc = seed.col;
  // Pick a dominant cardinal direction for this fire
  let mainDir = state.rng.int(0, DIRS_4.length - 1);

  const maxAttempts = WILDFIRE_SPINE_LENGTH * 8;
  let attempts = 0;
  while (spine.length < WILDFIRE_SPINE_LENGTH && attempts++ < maxAttempts) {
    // 70% chance to keep the main direction — produces a clear line
    const dirIdx = state.rng.bool(0.7)
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
      // Blocked — try rotating the main direction
      mainDir = (mainDir + (state.rng.bool() ? 1 : 3)) % DIRS_4.length;
    }
  }

  // Phase 2: fatten the spine — each spine tile gets 0-2 cardinal
  // neighbors burned (50% chance per neighbor), giving a 2-3 tile wide scar
  for (const tile of spine) {
    for (const [dr, dc] of DIRS_4) {
      const nr = tile.row + dr;
      const nc = tile.col + dc;
      if (scar.has(packTile(nr, nc))) continue;
      if (!canBurn(nr, nc)) continue;
      if (state.rng.bool(0.35)) {
        scar.add(packTile(nr, nc));
      }
    }
  }

  // Apply the scar — destroy everything on the burned tiles
  const newPits: BurningPit[] = [];
  for (const key of scar) {
    const { r, c } = unpackTile(key);
    newPits.push({ row: r, col: c, roundsLeft: BURNING_PIT_DURATION });
    removeWallFromAllPlayers(state, key);
    // Destroy houses on this tile
    for (const house of state.map.houses) {
      if (house.alive && house.row === r && house.col === c) {
        house.alive = false;
      }
    }
  }
  // Kill grunts standing on burned tiles
  state.grunts = state.grunts.filter(
    (gr) => !scar.has(packTile(gr.row, gr.col)),
  );
  // Remove bonus squares on burned tiles
  state.bonusSquares = state.bonusSquares.filter(
    (bs) => !scar.has(packTile(bs.row, bs.col)),
  );
  state.burningPits.push(...newPits);
}

/** Apply crumbling walls: destroy a fraction of each player's outermost walls. */
export function applyCrumblingWalls(state: GameState): void {
  const tiles = state.map.tiles;
  const cols = tiles[0]!.length;

  for (const player of state.players) {
    if (player.eliminated || player.walls.size === 0) continue;

    // Outer walls: wall tiles with at least one non-wall non-interior neighbor
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
        return !player.walls.has(nk) && !player.interior.has(nk);
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
    for (let i = 0; i < count; i++) {
      player.walls.delete(destructible[i]!);
    }
  }
}

/** Apply grunt surge: spawn extra grunts distributed across all alive towers. */
export function applyGruntSurge(state: GameState): void {
  if (state.round < FIRST_GRUNT_SPAWN_ROUND) return;
  const extraCount = state.rng.int(GRUNT_SURGE_MIN, GRUNT_SURGE_MAX);
  for (const player of state.players.filter(isPlayerSeated)) {
    spawnGruntSurgeOnZone(state, player.id, extraCount);
  }
}
