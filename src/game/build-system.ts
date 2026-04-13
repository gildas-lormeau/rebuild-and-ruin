/**
 * Build/repair phase — piece placement, territory claiming (flood-fill).
 *
 * AI placement strategy lives in ai-strategy.ts.
 */

import type { BurningPit, Grunt } from "../shared/core/battle-types.ts";
import {
  addPlayerWalls,
  BONUS_PLACEMENT_BLOCKED,
  collectAllInterior,
  collectOccupiedTiles,
  getInterior,
  hasCannonAt,
  hasGruntAt,
  hasTowerAt,
  hasWallAt,
  isTileOwnedByPlayer,
  markInteriorFresh,
  type OccupancyCache,
} from "../shared/core/board-occupancy.ts";
import {
  BONUS_SQUARE_MIN_DISTANCE,
  BONUS_SQUARES_PER_ZONE,
  CASTLE_BONUS_TABLE,
  DESTROY_GRUNT_POINTS,
  ENCLOSED_GRUNT_RESPAWN_CHANCE,
  TERRITORY_POINT_TIERS,
  TOWER_SIZE,
} from "../shared/core/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import type { TilePos } from "../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, type Tile } from "../shared/core/grid.ts";
import type { PieceShape } from "../shared/core/pieces.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import {
  type FreshInterior,
  isPlayerEliminated,
  isPlayerSeated,
  type Player,
} from "../shared/core/player-types.ts";
import {
  computeOutside,
  DIRS_8,
  hasPitAt,
  inBounds,
  isGrass,
  isWater,
  manhattanDistance,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { GameViewState } from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import { spawnGruntNearPos, spawnGruntOnZone } from "./grunt-system.ts";
import { topZonesBySize } from "./map-generation.ts";
import {
  canPlaceOverBurningPit,
  onPiecePlaced,
  territoryScoreMult,
  wallOverlapAllowance,
} from "./upgrade-system.ts";
import { restorationCrewInstantRevive } from "./upgrades/restoration-crew.ts";

/** Validate + apply piece placement. Returns true if placed. */
export function placePiece(
  state: GameState,
  playerId: ValidPlayerSlot,
  piece: PieceShape,
  row: number,
  col: number,
): boolean {
  if (isPlayerEliminated(state.players[playerId])) return false;
  if (!canPlacePiece(state, playerId, piece.offsets, row, col)) return false;
  applyPiecePlacement(state, playerId, piece.offsets, row, col);
  return true;
}

/** Validate piece placement on the grid from raw offsets.
 *  Checks: grass, playerZone, ALL towers (not just owned), grunts, cannons, burning pits.
 *  Does NOT check interior (enclosed territory) — pieces can go on open grass.
 *
 *  CONTRAST with canPlaceCannon() in cannon-system.ts:
 *    - Cannon: checks INTERIOR (enclosed territory) + owned towers only
 *    - Piece:  checks GRASS + zone + ALL towers (no interior check)
 *  Copying validation from one to the other produces wrong results. */
export function canPlacePiece(
  state: GameViewState & {
    readonly grunts: readonly Grunt[];
    readonly burningPits: readonly BurningPit[];
  },
  playerId: ValidPlayerSlot,
  offsets: readonly [number, number][],
  row: number,
  col: number,
  excludeInterior?: ReadonlySet<number>,
  cache?: OccupancyCache,
): boolean {
  const player = state.players[playerId];
  if (!player) return false;
  const playerZone = player.homeTower?.zone;
  const overlapAllowance = wallOverlapAllowance(player);
  const allowPitOverlap = canPlaceOverBurningPit(player);
  let wallOverlaps = 0;
  for (const [dr, dc] of offsets) {
    const r = row + dr;
    const c = col + dc;
    if (!inBounds(r, c)) return false;
    if (!isGrass(state.map.tiles, r, c)) return false;
    // Must be within the player's zone
    if (playerZone !== undefined && state.map.zones[r]![c] !== playerZone)
      return false;
    const key = packTile(r, c);

    // AI callers pass excludeInterior to prevent placing inside enclosed zones
    if (excludeInterior && excludeInterior.has(key)) return false;

    if (hasWallAt(state, r, c)) {
      if (player.walls.has(key) && wallOverlaps < overlapAllowance) {
        wallOverlaps++;
      } else {
        return false;
      }
    }
    if (cache) {
      if (cache.towerKeys.has(key)) return false;
      if (cache.cannonKeys.has(key)) return false;
      if (cache.gruntKeys.has(key)) return false;
    } else {
      if (hasTowerAt(state, r, c)) return false;
      if (hasCannonAt(state, r, c)) return false;
      if (hasGruntAt(state.grunts, r, c)) return false;
    }

    if (hasPitAt(state.burningPits, r, c) && !allowPitOverlap) return false;

    // Bonus squares CAN be covered (you lose the bonus) — no block here
  }
  return true;
}

/** Apply a piece placement to the board. Marks walls dirty after mutation.
 *  WARNING: Leaves interior stale. Caller MUST call recheckTerritory(state) before
 *  any code reads player.interior. Enforced at runtime by assertInteriorFresh().
 *  Used by host and watcher (no validation). */
export function applyPiecePlacement(
  state: GameState,
  playerId: ValidPlayerSlot,
  offsets: readonly [number, number][],
  row: number,
  col: number,
): void {
  if (isPlayerEliminated(state.players[playerId])) return;
  const player = state.players[playerId]!;
  const destroyedHousePositions: TilePos[] = [];
  const pieceKeys = new Set(
    offsets.map(([dr, dc]) => packTile(row + dr, col + dc)),
  );
  addPlayerWalls(player, pieceKeys);
  emitGameEvent(state.bus, GAME_EVENT.WALL_PLACED, {
    playerId,
    tileKeys: [...pieceKeys],
  });
  for (const house of state.map.houses) {
    if (!house.alive) continue;
    const houseKey = packTile(house.row, house.col);
    if (pieceKeys.has(houseKey)) {
      house.alive = false;
      destroyedHousePositions.push({ row: house.row, col: house.col });
    }
  }
  state.bonusSquares = state.bonusSquares.filter(
    (b) => !pieceKeys.has(packTile(b.row, b.col)),
  );
  onPiecePlaced(state, player, pieceKeys);
  recheckTerritory(state);
  for (const pos of destroyedHousePositions) {
    spawnGruntNearPos(state, playerId, pos.row, pos.col);
  }
}

/** Reclaim territory for all players after a wall mutation during active build phase.
 *  Sub-functions: recomputeInterior → updateOwnedTowers → removeEnclosedGrunts →
 *  destroyEnclosedHouses → captureEnclosedBonusSquares → sweepMisplacedGrunts.
 *  Call after each piece placement or wall change during build phase.
 *  Do NOT use at end-of-build — use finalizeTerritoryWithScoring() instead (adds tower revival + scoring). */
export function recheckTerritory(state: GameState): void {
  // Pass 1: recompute ALL interiors before any grunt/house operations.
  // Grunt respawn (pass 2) calls hasInteriorAt which asserts freshness for
  // every player — all interiors must be fresh before any cross-player reads.
  for (const player of state.players) {
    recomputeInterior(state, player);
  }
  // Pass 2: territory-dependent operations (safe — all interiors are fresh).
  for (const player of state.players) {
    const interior = getInterior(player);
    updateOwnedTowers(state, player);
    removeEnclosedGruntsAndRespawn(state, player, interior);
    destroyEnclosedHousesAndSpawnGrunts(state, player, interior);
    captureEnclosedBonusSquares(state, player, interior);
  }
  sweepMisplacedGrunts(state);
}

/** End-of-build territory finalization. Same as recheckTerritory() plus:
 *  - Awards territory/enclosure scoring points
 *  - Resolves pending tower revives (towerPendingRevive → alive if still enclosed)
 *  - Clears unenclosed pending revives
 *  Called exactly once at end of build phase from finalizeBuildPhase(). */
export function finalizeTerritoryWithScoring(state: GameState): void {
  // Pass 1: recompute ALL interiors (same rationale as recheckTerritory).
  for (const player of state.players) {
    recomputeInterior(state, player);
  }
  // Pass 2: territory-dependent operations + scoring.
  for (const player of state.players) {
    const interior = getInterior(player);
    updateOwnedTowers(state, player);
    reviveEnclosedTowers(state, player);
    removeEnclosedGruntsAndRespawn(state, player, interior);
    destroyEnclosedHousesAndSpawnGrunts(state, player, interior);
    captureEnclosedBonusSquares(state, player, interior);
    awardEndOfBuildPoints(state, player, interior.size);
  }
  // ── Post-loop: global finalization ──
  sweepMisplacedGrunts(state);
  clearUnenclosedPendingRevives(state);
}

/**
 * Replenish bonus squares to maintain BONUS_SQUARES_PER_ZONE per zone.
 * Placed on free grass tiles with 1-tile gap from borders and river,
 * never inside enclosed areas.
 */
export function replenishBonusSquares(state: GameState): void {
  const { map } = state;
  const { tiles, zones } = map;

  // Identify the 3 main zones, skip zones of eliminated players
  const eliminatedZones = new Set(
    state.players
      .filter((player) => isPlayerEliminated(player))
      .map((player) => state.playerZones[player.id]),
  );
  const mainZones = topZonesBySize(map, 3)
    .map(({ zone }) => zone)
    .filter((zone) => !eliminatedZones.has(zone));

  // Build sets of enclosed and occupied tiles
  const enclosed = collectAllInterior(state);
  const occupied = collectOccupiedTiles(state, BONUS_PLACEMENT_BLOCKED);

  for (const zoneId of mainZones) {
    const existing = state.bonusSquares.filter(
      (bonus) => bonus.zone === zoneId,
    ).length;
    const needed = BONUS_SQUARES_PER_ZONE - existing;
    if (needed <= 0) continue;

    const candidates = findBonusSpawnCandidates(
      tiles,
      zones,
      zoneId,
      occupied,
      enclosed,
    );

    state.rng.shuffle(candidates);

    let placed = 0;
    for (const [r, c] of candidates) {
      if (placed >= needed) break;
      // Ensure minimum distance from every existing bonus square
      const tooClose = state.bonusSquares.some(
        (bonus) =>
          manhattanDistance(bonus.row, bonus.col, r, c) <
          BONUS_SQUARE_MIN_DISTANCE,
      );
      if (tooClose) continue;
      occupied.add(packTile(r, c));
      state.bonusSquares.push({ row: r, col: c, zone: zoneId });
      placed++;
    }
  }
}

/** Remove bonus squares that are covered by walls. */
export function removeBonusSquaresCoveredByWalls(
  state: GameState,
  walls: ReadonlySet<number>,
): void {
  state.bonusSquares = state.bonusSquares.filter(
    (bonusSquare) => !walls.has(packTile(bonusSquare.row, bonusSquare.col)),
  );
}

/** Recompute interior + ownedTowers for every player. Used by checkpoint
 *  rehydration and deserialization paths where the full player wall set
 *  has just been replaced and all interiors need to be re-flooded. */
export function recomputeAllTerritory(state: GameState): void {
  for (const player of state.players) {
    recomputeTerritoryFromWalls(state, player);
  }
}

/** Detect walls added by a controller tick and return them as offset pairs.
 *  Used by the runtime to broadcast AI wall placements to network peers. */
export function diffNewWalls(
  state: GameState,
  playerId: ValidPlayerSlot,
  wallSnapshot: ReadonlySet<number>,
): [number, number][] {
  const player = state.players[playerId]!;
  if (player.walls.size <= wallSnapshot.size) return [];
  const offsets: [number, number][] = [];
  for (const key of player.walls) {
    if (!wallSnapshot.has(key)) {
      const { r, c } = unpackTile(key);
      offsets.push([r, c]);
    }
  }
  return offsets;
}

/** Recompute interior and ownedTowers from walls — no side effects.
 *  Used by checkpoint restore where grunts/houses/bonus are already correct. */
/** Private — callers outside this file should use `recomputeAllTerritory`. */
function recomputeTerritoryFromWalls(state: GameState, player: Player): void {
  recomputeInterior(state, player);
  updateOwnedTowers(state, player);
}

/** Collect valid grass tiles for bonus square placement in a single zone. */
function findBonusSpawnCandidates(
  tiles: readonly (readonly Tile[])[],
  zones: readonly (readonly number[])[],
  zoneId: number,
  occupied: ReadonlySet<number>,
  enclosed: ReadonlySet<number>,
): [number, number][] {
  const candidates: [number, number][] = [];
  // 1-tile padding from map edges — bonus squares must be enclosable
  for (let r = 1; r < GRID_ROWS - 1; r++) {
    for (let c = 1; c < GRID_COLS - 1; c++) {
      if (!isGrass(tiles, r, c)) continue;
      if (zones[r]![c] !== zoneId) continue;
      const key = packTile(r, c);
      if (occupied.has(key)) continue;
      if (enclosed.has(key)) continue;
      // Must not be adjacent to map edge or water (unenclosable)
      if (
        DIRS_8.some(([dr, dc]) => {
          const nr = r + dr,
            nc = c + dc;
          return !inBounds(nr, nc) || isWater(tiles, nr, nc);
        })
      )
        continue;
      candidates.push([r, c]);
    }
  }
  return candidates;
}

function awardEndOfBuildPoints(
  state: GameState,
  player: Player,
  territorySize: number,
): void {
  // Territory points (tiered by interior size)
  const territoryMult = territoryScoreMult(player);
  for (const [threshold, points] of TERRITORY_POINT_TIERS) {
    if (territorySize >= threshold) {
      player.score += points * territoryMult;
      break;
    }
  }

  // Castle bonus (home castle = 2 units, others = 1 unit)
  const castleUnits = countCastleBonusUnits(state, player);
  if (castleUnits > 0) {
    const idx = Math.min(castleUnits, CASTLE_BONUS_TABLE.length - 1);
    player.score += CASTLE_BONUS_TABLE[idx]!;
  }
}

function countCastleBonusUnits(state: GameState, player: Player): number {
  let castleUnits = 0;
  for (const tower of player.ownedTowers) {
    if (state.towerAlive[tower.index]!) {
      castleUnits += tower === player.homeTower ? 2 : 1;
    }
  }
  return castleUnits;
}

/** Destroy houses enclosed by a player's territory and spawn a grunt per enemy.
 *  PRECONDITION: interior must be fresh (via recomputeInterior). */
function destroyEnclosedHousesAndSpawnGrunts(
  state: GameState,
  player: Player,
  interior: FreshInterior,
): void {
  for (const house of state.map.houses) {
    if (!house.alive) continue;
    const hKey = packTile(house.row, house.col);
    if (!interior.has(hKey)) continue;

    house.alive = false;
    for (const enemy of state.players) {
      if (enemy.id === player.id || !isPlayerSeated(enemy)) continue;
      spawnGruntOnZone(state, enemy.id);
    }
  }
}

/** Remove grunts enclosed by a player's territory (awards points).
 *  Each enclosed grunt has 50% chance to respawn on an enemy's zone.
 *  PRECONDITION: interior must be fresh (via recomputeInterior). */
function removeEnclosedGruntsAndRespawn(
  state: GameState,
  player: Player,
  interior: FreshInterior,
): void {
  const kept: Grunt[] = [];
  const enclosed: Grunt[] = [];
  for (const grunt of state.grunts) {
    if (interior.has(packTile(grunt.row, grunt.col))) {
      enclosed.push(grunt);
    } else {
      kept.push(grunt);
    }
  }
  if (enclosed.length === 0) return;

  state.grunts = kept;
  player.score += enclosed.length * DESTROY_GRUNT_POINTS;

  const enemies = state.players.filter(
    (other) => other.id !== player.id && isPlayerSeated(other),
  );
  if (enemies.length === 0) return;

  // Each enclosed grunt has 50% chance to respawn, alternating between enemies
  let enemyIdx = 0;
  for (let i = 0; i < enclosed.length; i++) {
    if (!state.rng.bool(ENCLOSED_GRUNT_RESPAWN_CHANCE)) continue;
    const enemy = enemies[enemyIdx % enemies.length]!;
    spawnGruntOnZone(state, enemy.id);
    enemyIdx++;
  }
}

/** Remove tower indices from towerPendingRevive if no longer enclosed by any player.
 *  Called at end of build to prevent reviving towers that lost enclosure. */
function clearUnenclosedPendingRevives(state: GameState): void {
  const toRemove: number[] = [];
  for (const towerIdx of state.towerPendingRevive) {
    if (towerIdx < 0 || towerIdx >= state.map.towers.length) {
      toRemove.push(towerIdx);
      continue;
    }
    const isEnclosed = state.players.some((player) =>
      player.ownedTowers.includes(state.map.towers[towerIdx]!),
    );
    if (!isEnclosed) toRemove.push(towerIdx);
  }
  for (const towerIdx of toRemove) state.towerPendingRevive.delete(towerIdx);
}

/** Recompute a player's interior via inverse flood-fill from map edges.
 *  Grass tiles not reachable through non-wall tiles become interior (territory).
 *  Calls markInteriorFresh() — after this, getInterior(player) is safe. */
function recomputeInterior(state: GameState, player: Player): void {
  const fresh = new Set<number>();
  const outside = computeOutside(player.walls);
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const key = packTile(r, c);
      if (!outside.has(key) && !player.walls.has(key)) {
        if (isGrass(state.map.tiles, r, c)) {
          fresh.add(key);
        }
      }
    }
  }
  player.interior = markInteriorFresh(player, fresh);
}

/** Find towers enclosed by a player's territory and update ownedTowers list. */
function updateOwnedTowers(state: GameState, player: Player): void {
  player.ownedTowers = [];
  for (const tower of state.map.towers) {
    if (!isTowerOwnedByPlayer(tower, player)) continue;
    player.ownedTowers.push(tower);
  }
}

/** Process delayed tower revival for a single player (end-of-build-phase only).
 *  Dead towers enclosed for two consecutive build phases are revived.
 *  Dead towers enclosed for only one phase are marked pending.
 *  Restoration Crew: the first newly-pending tower skips the wait and
 *  revives immediately (the upgrade is consumed on use). */
function reviveEnclosedTowers(state: GameState, player: Player): void {
  for (const tower of player.ownedTowers) {
    if (state.towerAlive[tower.index]) continue;
    if (state.towerPendingRevive.has(tower.index)) {
      state.towerAlive[tower.index] = true;
      state.towerPendingRevive.delete(tower.index);
    } else if (restorationCrewInstantRevive(player)) {
      state.towerAlive[tower.index] = true;
    } else {
      state.towerPendingRevive.add(tower.index);
    }
  }
}

/** Award bonus square points for squares enclosed by a player's territory. */
function captureEnclosedBonusSquares(
  state: GameState,
  player: Player,
  interior: FreshInterior,
): void {
  const territorySize = interior.size;
  state.bonusSquares = state.bonusSquares.filter((bonus) => {
    const bonusSquareKey = packTile(bonus.row, bonus.col);
    if (interior.has(bonusSquareKey)) {
      player.score += territoryBonusSquarePoints(territorySize);
      return false;
    }
    return true;
  });
}

/** SNES Rampart formula: 10×√territory, quantized to nearest 100, clamped [100,1000]. */
function territoryBonusSquarePoints(territorySize: number): number {
  const raw = Math.floor((10 * Math.sqrt(territorySize)) / 100) * 100;
  return Math.max(100, Math.min(1000, raw));
}

/** Check if all tiles in a tower's footprint are owned by the given player. */
function isTowerOwnedByPlayer(tower: TilePos, player: Player): boolean {
  // Towers occupy a TOWER_SIZE×TOWER_SIZE footprint — check all tiles
  for (let dr = 0; dr < TOWER_SIZE; dr++) {
    for (let dc = 0; dc < TOWER_SIZE; dc++) {
      if (
        !isTileOwnedByPlayer(player, packTile(tower.row + dr, tower.col + dc))
      )
        return false;
    }
  }
  return true;
}

/** Remove grunts that landed on any player's territory during processing. */
function sweepMisplacedGrunts(state: GameState): void {
  state.grunts = state.grunts.filter((grunt) => {
    const gruntKey = packTile(grunt.row, grunt.col);
    return !state.players.some((player) =>
      isTileOwnedByPlayer(player, gruntKey),
    );
  });
}
