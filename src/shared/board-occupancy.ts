import type { BurningPit, Grunt } from "./battle-types.ts";
import type { BonusSquare } from "./geometry-types.ts";
import type { ValidPlayerSlot } from "./player-slot.ts";
import type { FreshInterior, Player } from "./player-types.ts";
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
import type { GameViewState } from "./system-interfaces.ts";

/** Epoch tracking is lazy: undefined = not active for this player.
 *  Initialized on first markWallsDirty() call. */
const wallsEpoch = new WeakMap<Player, number>();
const interiorEpoch = new WeakMap<Player, number>();
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

export function isTileOwnedByPlayer(player: Player, key: number): boolean {
  assertInteriorFresh(player);
  return player.interior.has(key) || player.walls.has(key);
}

/** Remove a wall tile from all players. Used during battle (grunt attacks). */
export function removeWallFromAllPlayers(
  state: GameViewState,
  key: number,
): void {
  for (const player of state.players) deletePlayerWallBattle(player, key);
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

export function collectAllCannonTiles(
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

export function hasTowerAt(
  state: GameViewState,
  r: number,
  c: number,
): boolean {
  return state.map.towers.some((tower) => isTowerTile(tower, r, c));
}

export function hasCannonAt(
  state: GameViewState,
  r: number,
  c: number,
  options?: { excludeBalloonCannons?: boolean },
): boolean {
  return state.players.some((player) =>
    player.cannons.some((cannon) => {
      if (options?.excludeBalloonCannons && isBalloonCannon(cannon))
        return false;
      return isCannonTile(cannon, r, c);
    }),
  );
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
    (player) => player.id !== playerId && !player.eliminated,
  );
}

export function addPlayerWall(player: Player, key: number): void {
  mutableWalls(player).add(key);
  markWallsDirty(player);
}

/** Batch-add wall keys and mark dirty once. Use instead of a loop of .add() calls.
 *  WARNING: Leaves interior stale. Caller MUST call recheckTerritoryOnly(state) before
 *  any code reads player.interior. Enforced at runtime by assertInteriorFresh(). */
export function addPlayerWalls(player: Player, keys: Iterable<number>): void {
  const walls = mutableWalls(player);
  for (const key of keys) walls.add(key);
  markWallsDirty(player);
}

/** Delete a wall during battle. Intentionally skips markWallsDirty — interior is
 *  stale during battle by design; recheckTerritoryOnly runs at the next phase start.
 *  WARNING: Leaves interior stale. No recheckTerritoryOnly needed until next build phase. */
export function deletePlayerWallBattle(player: Player, key: number): void {
  mutableWalls(player).delete(key);
}

/** Batch-delete wall keys during a modifier (e.g. crumbling walls).
 *  Intentionally skips markWallsDirty — modifier runs between phases. */
export function deletePlayerWallsBatch(
  player: Player,
  keys: readonly number[],
): void {
  const walls = mutableWalls(player);
  for (const key of keys) walls.delete(key);
}

/** Clear all walls and mark dirty. Used when resetting a player's board state.
 *  WARNING: Leaves interior stale. Caller MUST call recheckTerritoryOnly(state) before
 *  any code reads player.interior. Enforced at runtime by assertInteriorFresh(). */
export function clearPlayerWalls(player: Player): void {
  mutableWalls(player).clear();
  markWallsDirty(player);
}

/** Remove isolated debris walls (≤1 orthogonal neighbor) and mark dirty.
 *  Used during wall sweep at build phase transitions.
 *  WARNING: Leaves interior stale. Caller MUST call recheckTerritoryOnly(state) before
 *  any code reads player.interior. Enforced at runtime by assertInteriorFresh(). */
export function sweepIsolatedWalls(player: Player): void {
  removeIsolatedWalls(mutableWalls(player));
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
 *  Called by recomputeInterior inside recheckTerritoryOnly — do NOT call from other code.
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

/** Return a player's interior after asserting it's fresh.
 *  Use this in build/cannon game logic — it guarantees the set reflects the
 *  current wall state. During battle, use `getBattleInterior()` instead
 *  (interior is intentionally stale while walls are being destroyed). */
export function getInterior(player: Player): FreshInterior {
  assertInteriorFresh(player);
  return player.interior;
}

/** Return a player's interior WITHOUT freshness assertion.
 *  Battle-phase only: interior is intentionally stale during battle because
 *  walls destroyed by cannonballs are not reflected until the next build phase.
 *  Do NOT use outside battle code — use `getInterior()` everywhere else. */
export function getBattleInterior(player: Player): ReadonlySet<number> {
  return player.interior;
}

/** Assert that a player's interior is not stale (walls haven't changed since
 *  the last recheckTerritoryOnly). Throws if stale — this is a programming error,
 *  not a runtime condition. No-op if epochs were never initialized (e.g. tests
 *  that don't call markWallsDirty). */
export function assertInteriorFresh(player: Player): void {
  const currentWallsEpoch = wallsEpoch.get(player);
  if (currentWallsEpoch === undefined) return; // epoch tracking not active for this player
  const currentInteriorEpoch = interiorEpoch.get(player) ?? -1;
  if (currentInteriorEpoch < currentWallsEpoch) {
    throw new Error(
      `Stale interior for player ${player.id}: walls epoch ${currentWallsEpoch} > interior epoch ${currentInteriorEpoch}. ` +
        `Call recheckTerritoryOnly() after wall mutations before reading interior.`,
    );
  }
}

/** Add a wall key and mark dirty. Ensures the freshness invariant is maintained.
 *  WARNING: Leaves interior stale. Caller MUST call recheckTerritoryOnly(state) before
 *  any code reads player.interior. Enforced at runtime by assertInteriorFresh(). */
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
