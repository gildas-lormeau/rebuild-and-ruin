/**
 * Shared board occupancy queries used by gameplay systems.
 *
 * These helpers centralize state-based tile checks so build, grunt, and AI
 * logic do not each re-implement the same scans across walls, units, houses,
 * towers, and cannons.
 *
 * ## Epoch tracking (stale-interior detection)
 *
 * Wall mutations and interior recomputation are tracked via epoch counters.
 * ALL wall mutations must go through the centralized helpers:
 *   - addPlayerWall / addPlayerWalls — build phase (marks dirty)
 *   - clearPlayerWalls              — board reset (marks dirty)
 *   - sweepIsolatedWalls            — debris sweep at phase transitions (marks dirty)
 *   - deletePlayerWallBattle        — battle destruction (intentionally no mark)
 *
 * Never call player.walls.add/delete/clear directly.
 *
 * After any dirty-marking mutation, call recheckTerritory(state) before reading
 * player.interior. assertInteriorFresh(player) throws if this is skipped.
 */

import {
  computeCannonTileSet,
  countWallNeighbors,
  DIRS_4,
  forEachTowerTile,
  hasPitAt,
  inBounds,
  isAtTile,
  isBalloonCannon,
  isCannonTile,
  isTowerTile,
  isWater,
  packTile,
  unpackTile,
} from "./spatial.ts";
import type { FreshInterior, GameState, Grunt, Player } from "./types.ts";

const wallsEpoch = new WeakMap<Player, number>();
const interiorEpoch = new WeakMap<Player, number>();
/** Preset: tiles that block grunt spawning (zone-based).
 *  Includes interior: grunts must spawn OUTSIDE enclosed territory.
 *  Does NOT include bonusSquares: grunts can spawn on bonus tiles. */
export const GRUNT_SPAWN_BLOCKED = {
  includeWalls: true,
  includeInterior: true,
  includeCannons: true,
  includeTowers: true,
  includeHouses: true,
  includeGrunts: true,
  includePits: true,
} as const;
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
} as const;

export function isTileOwnedByPlayer(
  player: Pick<Player, "id" | "interior" | "walls">,
  key: number,
): boolean {
  assertInteriorFresh(player as Player);
  return player.interior.has(key) || player.walls.has(key);
}

/** Remove a wall tile from all players. Used during battle (grunt attacks). */
export function removeWallFromAllPlayers(state: GameState, key: number): void {
  for (const player of state.players) deletePlayerWallBattle(player, key);
}

export function collectOccupiedTiles(
  state: GameState,
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
      excludeBalloon: options.excludeBalloonCannons,
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
export function snapshotAllWalls(state: GameState): Set<number>[] {
  return state.players.map((player) => new Set(player.walls));
}

export function collectAllWalls(state: GameState): Set<number> {
  const allWalls = new Set<number>();
  for (const player of state.players) {
    for (const key of player.walls) allWalls.add(key);
  }
  return allWalls;
}

export function collectAllInterior(state: GameState): Set<number> {
  const allInterior = new Set<number>();
  for (const player of state.players) {
    for (const key of player.interior) allInterior.add(key);
  }
  return allInterior;
}

export function collectAllCannonTiles(
  state: GameState,
  options?: { excludeBalloon?: boolean },
): Set<number> {
  const cannonTiles = new Set<number>();
  for (const player of state.players) {
    for (const cannon of player.cannons) {
      if (options?.excludeBalloon && isBalloonCannon(cannon)) continue;
      for (const key of computeCannonTileSet(cannon)) cannonTiles.add(key);
    }
  }
  return cannonTiles;
}

export function hasWallAt(state: GameState, r: number, c: number): boolean {
  const key = packTile(r, c);
  return hasWallMatching(state, key, () => true);
}

export function hasEnemyWallAt(
  state: GameState,
  playerId: number,
  r: number,
  c: number,
): boolean {
  const key = packTile(r, c);
  return hasWallMatching(state, key, (player) => player.id !== playerId);
}

export function hasInteriorAt(state: GameState, key: number): boolean {
  return state.players.some((player) => {
    assertInteriorFresh(player);
    return player.interior.has(key);
  });
}

export function hasGruntAt(
  state: GameState,
  r: number,
  c: number,
  exclude?: Grunt,
): boolean {
  return state.grunts.some(
    (grunt) => grunt !== exclude && isAtTile(grunt, r, c),
  );
}

export function hasAliveHouseAt(
  state: GameState,
  r: number,
  c: number,
): boolean {
  return state.map.houses.some((house) => house.alive && isAtTile(house, r, c));
}

export function findLivingTowerIndexAt(
  state: GameState,
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
  state: GameState,
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
  for (let di = 0; di < 4; di++) {
    const [dr, dc] = DIRS_4[di]!;
    const nr = row + dr;
    const nc = col + dc;
    if (!inBounds(nr, nc)) {
      obstacles[di] = true;
      continue;
    }
    if (isWater(state.map.tiles, nr, nc)) {
      obstacles[di] = true;
      continue;
    }
    if (hasTowerAt(state, nr, nc)) {
      obstacles[di] = true;
      continue;
    }
    if (hasPitAt(state.burningPits, nr, nc)) {
      obstacles[di] = true;
      continue;
    }
    if (
      hasCannonAt(state, nr, nc, {
        excludeBalloon: options?.excludeBalloonCannons,
      })
    ) {
      obstacles[di] = true;
      continue;
    }
  }
  return obstacles;
}

export function hasTowerAt(state: GameState, r: number, c: number): boolean {
  return state.map.towers.some((tower) => isTowerTile(tower, r, c));
}

export function hasCannonAt(
  state: GameState,
  r: number,
  c: number,
  options?: { excludeBalloon?: boolean },
): boolean {
  return state.players.some((player) =>
    player.cannons.some((cannon) => {
      if (options?.excludeBalloon && isBalloonCannon(cannon)) return false;
      return isCannonTile(cannon, r, c);
    }),
  );
}

/** Return a player's owned towers that are still alive. */
export function filterAliveOwnedTowers(player: Player, state: GameState) {
  return player.ownedTowers.filter((tower) => state.towerAlive[tower.index]!);
}

/** Return all players that are not `playerId` and not eliminated. */
export function filterActiveEnemies(state: GameState, playerId: number) {
  return state.players.filter(
    (player) => player.id !== playerId && !player.eliminated,
  );
}

/** Add a wall key and mark dirty. Ensures the freshness invariant is maintained. */
export function addPlayerWall(player: Player, key: number): void {
  player.walls.add(key);
  markWallsDirty(player);
}

/** Batch-add wall keys and mark dirty once. Use instead of a loop of .add() calls. */
export function addPlayerWalls(player: Player, keys: Iterable<number>): void {
  for (const key of keys) player.walls.add(key);
  markWallsDirty(player);
}

/** Delete a wall during battle. Intentionally skips markWallsDirty — interior is
 *  stale during battle by design; recheckTerritory runs at the next phase start. */
export function deletePlayerWallBattle(player: Player, key: number): void {
  player.walls.delete(key);
}

/** Clear all walls and mark dirty. Used when resetting a player's board state. */
export function clearPlayerWalls(player: Player): void {
  player.walls.clear();
  markWallsDirty(player);
}

/** Remove isolated debris walls (≤1 orthogonal neighbor) and mark dirty.
 *  Used during wall sweep at build phase transitions. */
export function sweepIsolatedWalls(player: Player): void {
  removeIsolatedWalls(player.walls);
  markWallsDirty(player);
}

/**
 * Sweep one layer of debris wall tiles (0 or 1 orthogonal neighbor).
 * Collects all isolated tiles first, then removes them in one batch.
 */
export function removeIsolatedWalls(walls: Set<number>): void {
  const toRemove: number[] = [];
  for (const key of walls) {
    const { r, c } = unpackTile(key);
    if (countWallNeighbors(walls, r, c) <= 1) toRemove.push(key);
  }
  for (const key of toRemove) walls.delete(key);
}

/** Mark a player's wall set as modified. Call after any .add/.delete/.clear
 *  on player.walls. Omitting this call is safe (assertion may false-negative)
 *  but including it catches stale-interior bugs. */
export function markWallsDirty(player: Player): void {
  wallsEpoch.set(player, (wallsEpoch.get(player) ?? 0) + 1);
}

/** Mark a player's interior as freshly recomputed and brand the set.
 *  Called by recomputeInterior inside recheckTerritory — do NOT call from other code.
 *  When `fresh` is provided, assigns it as the new interior (handles branded-type cast). */
export function markInteriorFresh(
  player: Player,
  fresh?: Set<number>,
): FreshInterior {
  if (fresh !== undefined) {
    (player as unknown as { interior: Set<number> }).interior = fresh;
  }
  interiorEpoch.set(player, wallsEpoch.get(player) ?? 0);
  return player.interior;
}

/** Assert that a player's interior is not stale (walls haven't changed since
 *  the last recheckTerritory). Throws if stale — this is a programming error,
 *  not a runtime condition. No-op if epochs were never initialized (e.g. tests
 *  that don't call markWallsDirty). */
export function assertInteriorFresh(player: Player): void {
  const we = wallsEpoch.get(player);
  if (we === undefined) return; // epoch tracking not active for this player
  const ie = interiorEpoch.get(player) ?? -1;
  if (ie < we) {
    throw new Error(
      `Stale interior for player ${player.id}: walls epoch ${we} > interior epoch ${ie}. ` +
        `Call recheckTerritory() after wall mutations before reading interior.`,
    );
  }
}

function hasWallMatching(
  state: GameState,
  key: number,
  predicate: (player: Player) => boolean,
): boolean {
  return state.players.some(
    (player) => predicate(player) && player.walls.has(key),
  );
}
