import { type Cannon, type Grunt, isBalloonCannon } from "./battle-types.ts";
import type { BonusSquare, TowerIdx } from "./geometry-types.ts";
import type { TileKey } from "./grid.ts";
import { hasCannonAt, hasTowerAt } from "./occupancy-queries.ts";
import { assertInteriorFresh } from "./player-interior.ts";
import type { ValidPlayerId } from "./player-slot.ts";
import { isPlayerAlive, type Player } from "./player-types.ts";
import {
  cannonSize,
  computeCannonTileSet,
  DIRS_4,
  forEachTowerTile,
  hasPitAt,
  inBounds,
  isAtTile,
  isTowerTile,
  isWater,
  packTile,
} from "./spatial.ts";
import type { GameViewState } from "./system-interfaces.ts";

/** Pre-built tile-key Sets for fast O(1) occupancy checks.
 *  Build once via `buildOccupancyCache`, then pass to `canPlacePiece`
 *  to avoid per-tile linear scans over towers/cannons/grunts. */
export interface OccupancyCache {
  readonly towerKeys: ReadonlySet<TileKey>;
  readonly cannonKeys: ReadonlySet<TileKey>;
  readonly gruntKeys: ReadonlySet<TileKey>;
  /** Union of every player's walls. Use for any-wall presence checks
   *  (e.g. wall-overlap validation in `canPlacePiece`); for own-wall checks,
   *  test `player.walls.has(key)` directly. */
  readonly wallKeys: ReadonlySet<TileKey>;
  readonly pitKeys: ReadonlySet<TileKey>;
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

export function isTileOwnedByPlayer(player: Player, key: TileKey): boolean {
  assertInteriorFresh(player);
  return player.interior.has(key) || player.walls.has(key);
}

export function collectOccupiedTiles(
  state: GameViewState & {
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
): Set<TileKey> {
  const occupied = new Set<TileKey>();

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
export function snapshotAllWalls(state: GameViewState): Set<TileKey>[] {
  return state.players.map((player) => new Set(player.walls));
}

export function collectAllWalls(state: GameViewState): Set<TileKey> {
  const allWalls = new Set<TileKey>();
  for (const player of state.players) {
    for (const key of player.walls) allWalls.add(key);
  }
  return allWalls;
}

export function collectAllInterior(state: GameViewState): Set<TileKey> {
  const allInterior = new Set<TileKey>();
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
  playerId: ValidPlayerId,
  r: number,
  c: number,
): boolean {
  const key = packTile(r, c);
  return hasWallMatching(state, key, (player) => player.id !== playerId);
}

export function hasInteriorAt(state: GameViewState, key: TileKey): boolean {
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

/** Tile keys of every alive house, as a Set for O(1) hit-testing. The AI's
 *  simulated-wall predictors use this to exclude piece tiles that land on
 *  houses (those tiles spawn a grunt instead of a wall — see
 *  `applyPiecePlacement`). */
export function collectAliveHouseKeys(
  state: GameViewState,
): ReadonlySet<TileKey> {
  const keys = new Set<TileKey>();
  for (const house of state.map.houses) {
    if (house.alive) keys.add(packTile(house.row, house.col));
  }
  return keys;
}

export function findLivingTowerIndexAt(
  state: GameViewState & { readonly towerAlive: readonly boolean[] },
  r: number,
  c: number,
): TowerIdx | null {
  for (let i = 0; i < state.map.towers.length; i++) {
    if (!state.towerAlive[i]) continue;
    if (isTowerTile(state.map.towers[i]!, r, c)) return i as TowerIdx;
  }
  return null;
}

export function computeCardinalObstacleMask(
  state: GameViewState,
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

export function buildOccupancyCache(
  state: GameViewState & {
    readonly grunts: readonly Grunt[];
  },
): OccupancyCache {
  const towerKeys = new Set<TileKey>();
  for (const tower of state.map.towers) {
    forEachTowerTile(tower, (_r, _c, key) => towerKeys.add(key));
  }
  const cannonKeys = new Set<TileKey>();
  for (const player of state.players) {
    for (const cannon of player.cannons) {
      for (const key of computeCannonTileSet(cannon)) cannonKeys.add(key);
    }
  }
  const gruntKeys = new Set<TileKey>();
  for (const grunt of state.grunts) {
    gruntKeys.add(packTile(grunt.row, grunt.col));
  }
  const wallKeys = new Set<TileKey>();
  for (const player of state.players) {
    for (const key of player.walls) wallKeys.add(key);
  }
  const pitKeys = new Set<TileKey>();
  for (const pit of state.burningPits) {
    pitKeys.add(packTile(pit.row, pit.col));
  }
  return { towerKeys, cannonKeys, gruntKeys, wallKeys, pitKeys };
}

export function filterAliveEnclosedTowers(
  player: Player,
  state: { readonly towerAlive: readonly boolean[] },
) {
  return player.enclosedTowers.filter(
    (tower) => state.towerAlive[tower.index]!,
  );
}

/** Return all players that are not `playerId` and not eliminated. */
export function filterActiveEnemies(
  state: GameViewState,
  playerId: ValidPlayerId,
) {
  return state.players.filter(
    (player) => player.id !== playerId && isPlayerAlive(player),
  );
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
export function getBattleInterior(player: Player): ReadonlySet<TileKey> {
  return player.interior;
}

function collectAllCannonTiles(
  state: GameViewState,
  options?: { excludeBalloonCannons?: boolean },
): Set<TileKey> {
  const cannonTiles = new Set<TileKey>();
  for (const player of state.players) {
    for (const cannon of player.cannons) {
      if (options?.excludeBalloonCannons && isBalloonCannon(cannon)) continue;
      for (const key of computeCannonTileSet(cannon)) cannonTiles.add(key);
    }
  }
  return cannonTiles;
}

function hasWallMatching(
  state: GameViewState,
  key: TileKey,
  predicate: (player: Player) => boolean,
): boolean {
  return state.players.some(
    (player) => predicate(player) && player.walls.has(key),
  );
}
