import type { BurningPit, Cannon, Grunt } from "./battle-types.ts";
import type { BonusSquare } from "./geometry-types.ts";
import { hasCannonAt, hasTowerAt } from "./occupancy-queries.ts";
import { assertInteriorFresh, markWallsDirty } from "./player-interior.ts";
import type { ValidPlayerSlot } from "./player-slot.ts";
import { isPlayerAlive, type Player } from "./player-types.ts";
import {
  cannonSize,
  computeCannonTileSet,
  countWallNeighbors,
  DIRS_4,
  forEachTowerTile,
  hasPitAt,
  inBounds,
  isAtTile,
  isBalloonCannon,
  isTowerTile,
  isWater,
  packTile,
  unpackTile,
} from "./spatial.ts";
import type { GameViewState } from "./system-interfaces.ts";

/** Pre-built tile-key Sets for fast O(1) occupancy checks.
 *  Build once via `buildOccupancyCache`, then pass to `canPlacePiece`
 *  to avoid per-tile linear scans over towers/cannons/grunts. */
export interface OccupancyCache {
  readonly towerKeys: ReadonlySet<number>;
  readonly cannonKeys: ReadonlySet<number>;
  readonly gruntKeys: ReadonlySet<number>;
}

/** Preset: tiles that block bonus square placement.
 *  Does NOT include interior: bonus squares CAN appear inside territory
 *  (the separate `enclosed` check in replenishBonusSquares filters those).
 *  Includes bonusSquares: prevents stacking multiple on one tile. */
export const BONUS_PLACEMENT_BLOCKED = {
  includeWalls: true,
  includeCannons: true,
  includeTowers: true,
  includeHouses: true,
  includeGrunts: true,
  includePits: true,
  includeBonusSquares: true,
} as const;
/** Preset: tiles that block house spawning (minimal set). */
export const HOUSE_SPAWN_BLOCKED = {
  includeWalls: true,
  includeInterior: true,
  includeCannons: true,
  includeGrunts: true,
  includePits: true,
  includeBonusSquares: true,
} as const;

export function isTileOwnedByPlayer(player: Player, key: number): boolean {
  assertInteriorFresh(player);
  return player.interior.has(key) || player.walls.has(key);
}

export function collectOccupiedTiles(
  state: GameViewState & {
    readonly burningPits: readonly BurningPit[];
    readonly bonusSquares: readonly BonusSquare[];
    readonly grunts: readonly Grunt[];
  },
  options?: {
    includeWalls?: boolean;
    includeInterior?: boolean;
    includeCannons?: boolean;
    excludeBalloonCannons?: boolean;
    includeTowers?: boolean;
    includeHouses?: boolean;
    includeDeadHouses?: boolean;
    includePits?: boolean;
    includeBonusSquares?: boolean;
    includeGrunts?: boolean;
  },
): Set<number> {
  const occupied = new Set<number>();

  if (options?.includeWalls) {
    for (const key of collectAllWalls(state)) occupied.add(key);
  }

  if (options?.includeInterior) {
    for (const key of collectAllInterior(state)) occupied.add(key);
  }

  if (options?.includeCannons) {
    for (const key of collectAllCannonTiles(state, {
      excludeBalloonCannons: options.excludeBalloonCannons,
    })) {
      occupied.add(key);
    }
  }

  if (options?.includeTowers) {
    for (const tower of state.map.towers) {
      forEachTowerTile(tower, (_r, _c, key) => occupied.add(key));
    }
  }

  if (options?.includeHouses) {
    for (const house of state.map.houses) {
      if (!options.includeDeadHouses && !house.alive) continue;
      occupied.add(packTile(house.row, house.col));
    }
  }

  if (options?.includePits) {
    for (const pit of state.burningPits)
      occupied.add(packTile(pit.row, pit.col));
  }

  if (options?.includeBonusSquares) {
    for (const bonus of state.bonusSquares)
      occupied.add(packTile(bonus.row, bonus.col));
  }

  if (options?.includeGrunts) {
    for (const grunt of state.grunts)
      occupied.add(packTile(grunt.row, grunt.col));
  }

  return occupied;
}

/** Snapshot each player's wall set (independent copies). */
export function snapshotAllWalls(state: GameViewState): Set<number>[] {
  return state.players.map((player) => new Set(player.walls));
}

export function collectAllWalls(state: GameViewState): Set<number> {
  const allWalls = new Set<number>();
  for (const player of state.players) {
    for (const key of player.walls) allWalls.add(key);
  }
  return allWalls;
}

export function collectAllInterior(state: GameViewState): Set<number> {
  const allInterior = new Set<number>();
  for (const player of state.players) {
    for (const key of player.interior) allInterior.add(key);
  }
  return allInterior;
}

export function hasWallAt(state: GameViewState, r: number, c: number): boolean {
  const key = packTile(r, c);
  return hasWallMatching(state, key, () => true);
}

export function hasEnemyWallAt(
  state: GameViewState,
  playerId: ValidPlayerSlot,
  r: number,
  c: number,
): boolean {
  const key = packTile(r, c);
  return hasWallMatching(state, key, (player) => player.id !== playerId);
}

export function hasInteriorAt(state: GameViewState, key: number): boolean {
  return state.players.some((player) => {
    assertInteriorFresh(player);
    return player.interior.has(key);
  });
}

export function hasGruntAt(
  grunts: readonly Grunt[],
  r: number,
  c: number,
  exclude?: Grunt,
): boolean {
  return grunts.some((grunt) => grunt !== exclude && isAtTile(grunt, r, c));
}

export function hasAliveHouseAt(
  state: GameViewState,
  r: number,
  c: number,
): boolean {
  return state.map.houses.some((house) => house.alive && isAtTile(house, r, c));
}

export function findLivingTowerIndexAt(
  state: GameViewState & { readonly towerAlive: readonly boolean[] },
  r: number,
  c: number,
): number | null {
  for (let i = 0; i < state.map.towers.length; i++) {
    if (!state.towerAlive[i]) continue;
    if (isTowerTile(state.map.towers[i]!, r, c)) return i;
  }
  return null;
}

export function computeCardinalObstacleMask(
  state: GameViewState & { readonly burningPits: readonly BurningPit[] },
  row: number,
  col: number,
  options?: { excludeBalloonCannons?: boolean },
): [boolean, boolean, boolean, boolean] {
  const obstacles: [boolean, boolean, boolean, boolean] = [
    false,
    false,
    false,
    false,
  ];
  for (let dirIdx = 0; dirIdx < 4; dirIdx++) {
    const [dr, dc] = DIRS_4[dirIdx]!;
    const nr = row + dr;
    const nc = col + dc;
    if (!inBounds(nr, nc)) {
      obstacles[dirIdx] = true;
      continue;
    }
    if (isWater(state.map.tiles, nr, nc)) {
      obstacles[dirIdx] = true;
      continue;
    }
    if (hasTowerAt(state, nr, nc)) {
      obstacles[dirIdx] = true;
      continue;
    }
    if (hasPitAt(state.burningPits, nr, nc)) {
      obstacles[dirIdx] = true;
      continue;
    }
    if (
      hasCannonAt(state, nr, nc, {
        excludeBalloonCannons: options?.excludeBalloonCannons,
      })
    ) {
      obstacles[dirIdx] = true;
      continue;
    }
  }
  return obstacles;
}

/** Return the player id that owns the zone at (row, col), or 0 if no owner found.
 *  Uses playerZones (stable across elimination) rather than homeTower (nulled on elimination). */
export function zoneOwnerIdAt(
  state: GameViewState & { readonly playerZones: readonly number[] },
  row: number,
  col: number,
): ValidPlayerSlot {
  const zone = state.map.zones[row]?.[col] ?? -1;
  for (let pid = 0; pid < state.playerZones.length; pid++) {
    if (state.playerZones[pid] === zone) return pid as ValidPlayerSlot;
  }
  return 0 as ValidPlayerSlot;
}

export function buildOccupancyCache(
  state: GameViewState & { readonly grunts: readonly Grunt[] },
): OccupancyCache {
  const towerKeys = new Set<number>();
  for (const tower of state.map.towers) {
    forEachTowerTile(tower, (_r, _c, key) => towerKeys.add(key));
  }
  const cannonKeys = new Set<number>();
  for (const player of state.players) {
    for (const cannon of player.cannons) {
      for (const key of computeCannonTileSet(cannon)) cannonKeys.add(key);
    }
  }
  const gruntKeys = new Set<number>();
  for (const grunt of state.grunts) {
    gruntKeys.add(packTile(grunt.row, grunt.col));
  }
  return { towerKeys, cannonKeys, gruntKeys };
}

/** Return a player's owned towers that are still alive. */
export function filterAliveOwnedTowers(
  player: Player,
  state: { readonly towerAlive: readonly boolean[] },
) {
  return player.ownedTowers.filter((tower) => state.towerAlive[tower.index]!);
}

/** Return all players that are not `playerId` and not eliminated. */
export function filterActiveEnemies(
  state: GameViewState,
  playerId: ValidPlayerSlot,
) {
  return state.players.filter(
    (player) => player.id !== playerId && isPlayerAlive(player),
  );
}

export function addPlayerWall(player: Player, key: number): void {
  mutableWalls(player).add(key);
  markWallsDirty(player);
}

/** Batch-add wall keys and mark dirty once. Use instead of a loop of .add() calls.
 *  WARNING: Leaves interior stale. Caller MUST call recheckTerritory(state) before
 *  any code reads player.interior. Enforced at runtime by assertInteriorFresh(). */
export function addPlayerWalls(player: Player, keys: Iterable<number>): void {
  const walls = mutableWalls(player);
  for (const key of keys) walls.add(key);
  markWallsDirty(player);
}

/** Clear all walls and mark dirty. Used when resetting a player's board state.
 *  WARNING: Leaves interior stale. Caller MUST call recheckTerritory(state) before
 *  any code reads player.interior. Enforced at runtime by assertInteriorFresh(). */
export function clearPlayerWalls(player: Player): void {
  mutableWalls(player).clear();
  markWallsDirty(player);
}

/** Remove isolated debris walls (≤1 orthogonal neighbor) and mark dirty.
 *  Used during wall sweep at build phase transitions.
 *  WARNING: Leaves interior stale. Caller MUST call recheckTerritory(state) before
 *  any code reads player.interior. Enforced at runtime by assertInteriorFresh(). */
export function sweepIsolatedWalls(player: Player): void {
  removeIsolatedWalls(mutableWalls(player));
  markWallsDirty(player);
}

/** Check whether all tiles of a cannon are inside the player's enclosed territory.
 *  Freshness of `player.interior` is asserted — callers that read during battle
 *  (when interior is intentionally stale) should still get the build-time snapshot. */
export function isCannonEnclosed(cannon: Cannon, player: Player): boolean {
  assertInteriorFresh(player);
  const sz = cannonSize(cannon.mode);
  for (let dr = 0; dr < sz; dr++) {
    for (let dc = 0; dc < sz; dc++) {
      if (!player.interior.has(packTile(cannon.row + dr, cannon.col + dc)))
        return false;
    }
  }
  return true;
}

/** Return a player's interior WITHOUT freshness assertion.
 *  Battle-phase only: interior is intentionally stale during battle because
 *  walls destroyed by cannonballs are not reflected until the next build phase.
 *  Do NOT use outside battle code — use `getInterior()` everywhere else. */
export function getBattleInterior(player: Player): ReadonlySet<number> {
  return player.interior;
}

function collectAllCannonTiles(
  state: GameViewState,
  options?: { excludeBalloonCannons?: boolean },
): Set<number> {
  const cannonTiles = new Set<number>();
  for (const player of state.players) {
    for (const cannon of player.cannons) {
      if (options?.excludeBalloonCannons && isBalloonCannon(cannon)) continue;
      for (const key of computeCannonTileSet(cannon)) cannonTiles.add(key);
    }
  }
  return cannonTiles;
}

/**
 * Sweep one layer of debris wall tiles (0 or 1 orthogonal neighbor).
 * Collects all isolated tiles first, then removes them in one batch.
 */
function removeIsolatedWalls(walls: Set<number>): void {
  const toRemove: number[] = [];
  for (const key of walls) {
    const { r, c } = unpackTile(key);
    if (countWallNeighbors(walls, r, c) <= 1) toRemove.push(key);
  }
  for (const key of toRemove) walls.delete(key);
}

/** Cast ReadonlySet → Set for internal mutation. Only used by wall helpers in this file. */
function mutableWalls(player: Player): Set<number> {
  return player.walls as Set<number>;
}

function hasWallMatching(
  state: GameViewState,
  key: number,
  predicate: (player: Player) => boolean,
): boolean {
  return state.players.some(
    (player) => predicate(player) && player.walls.has(key),
  );
}
