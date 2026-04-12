/**
 * Grunt lifecycle — spawning, respawn, tower attacks, and blocked tracking.
 *
 * Movement and pathfinding live in grunt-movement.ts.
 */

import {
  BATTLE_MESSAGE,
  type TowerKilledMessage,
} from "../shared/core/battle-events.ts";
import type { Grunt } from "../shared/core/battle-types.ts";
import {
  hasGruntAt,
  hasInteriorAt,
  hasWallAt,
  removeWallFromAllPlayers,
  zoneOwnerIdAt,
} from "../shared/core/board-occupancy.ts";
import {
  FIRST_GRUNT_SPAWN_ROUND,
  GRUNT_ATTACK_DURATION,
  GRUNT_WALL_ATTACK_CHANCE,
  GRUNT_WALL_ATTACK_MIN_BATTLES,
  INTERBATTLE_GRUNT_SPAWN_ATTEMPTS,
  INTERBATTLE_GRUNT_SPAWN_CHANCE,
} from "../shared/core/game-constants.ts";
import { GAME_EVENT } from "../shared/core/game-event-bus.ts";
import type { TilePos } from "../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS } from "../shared/core/grid.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import {
  isPlayerEliminated,
  isPlayerSeated,
  type Player,
} from "../shared/core/player-types.ts";
import {
  DIRS_4,
  distanceToTower,
  inBounds,
  isGrass,
  isWater,
  manhattanDistance,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { GameState } from "../shared/core/types.ts";
import {
  adjacentLivingTowerIndex,
  getDeadZones,
  getGruntTargetTower,
  getLiveTargetTower,
  isAdjacentToLivingTower,
  isGruntPassableTile,
} from "./grunt-movement.ts";

/** Search radius for finding nearest water tile. */
const WATER_SEARCH_RADIUS = 5;
/** Minimum Manhattan distance between spawn candidates so grunts don't cluster on arrival. */
const GRUNT_SPAWN_MIN_DISTANCE = 2;
/** Max ring radius when spawning a grunt near a destroyed house. */
const NEAR_SPAWN_RADIUS = 8;

/** Spawn a grunt near (posRow, posCol) on the same zone.
 *  Spirals outward from the position to find the closest valid tile.
 *  Skips if excludePlayerId is the only non-eliminated player. */
export function spawnGruntNearPos(
  state: GameState,
  excludePlayerId: ValidPlayerSlot,
  posRow: number,
  posCol: number,
): void {
  if (
    state.players.every(
      (player) => player.id === excludePlayerId || isPlayerEliminated(player),
    )
  )
    return;
  const pos = findGruntSpawnNear(state, posRow, posCol);
  if (pos) {
    addGrunt(state, pos.row, pos.col);
  } else {
    const victimId = state.players.find(
      (player) => player.id !== excludePlayerId && !player.eliminated,
    )?.id;
    if (victimId !== undefined) {
      state.bus.emit(GAME_EVENT.GRUNT_SPAWN_BLOCKED, {
        type: GAME_EVENT.GRUNT_SPAWN_BLOCKED,
        playerId: victimId,
        requested: 1,
        placed: 0,
      });
    }
  }
}

/** Find a spawn position near (posRow, posCol) by spiralling outward.
 *  Checks expanding rings up to NEAR_SPAWN_RADIUS.
 *  Only considers tiles in the same zone that pass isValidGruntSpawnTile. */
export function findGruntSpawnNear(
  state: GameState,
  posRow: number,
  posCol: number,
): TilePos | null {
  const zone = state.map.zones[posRow]?.[posCol];
  if (zone === undefined || zone < 0) return null;

  for (let radius = 1; radius <= NEAR_SPAWN_RADIUS; radius++) {
    let best: TilePos | undefined;
    let bestDist = Infinity;
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.abs(dr) !== radius && Math.abs(dc) !== radius) continue;
        const row = posRow + dr;
        const col = posCol + dc;
        if (!inBounds(row, col)) continue;
        if (state.map.zones[row]![col] !== zone) continue;
        if (!isValidGruntSpawnTile(state, row, col)) continue;
        const dist = manhattanDistance(row, col, posRow, posCol);
        if (dist < bestDist) {
          bestDist = dist;
          best = { row, col };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/** Spawn a group of grunts on a player's zone (bank-first). */
export function spawnGruntGroupOnZone(
  state: GameState,
  playerId: ValidPlayerSlot,
  count: number,
): void {
  const player = state.players[playerId];
  if (!isPlayerSeated(player)) return;
  const positions = findGruntSpawnPositions(state, player, count);
  for (const pos of positions) {
    addGrunt(state, pos.row, pos.col);
  }
  if (positions.length < count) {
    state.bus.emit(GAME_EVENT.GRUNT_SPAWN_BLOCKED, {
      type: GAME_EVENT.GRUNT_SPAWN_BLOCKED,
      playerId,
      requested: count,
      placed: positions.length,
    });
  }
}

/** Spawn grunts distributed evenly across alive towers in a player's zone.
 *  Uses the same bank/edge spawn logic as regular grunt spawning, then
 *  round-robin assigns each position to the nearest alive tower. */
export function spawnGruntSurgeOnZone(
  state: GameState,
  playerId: ValidPlayerSlot,
  totalCount: number,
): void {
  const player = state.players[playerId];
  if (!isPlayerSeated(player)) return;

  const zone = player.homeTower.zone;

  // Collect alive towers in this zone
  const zoneTowers: { row: number; col: number }[] = [];
  for (let towerIdx = 0; towerIdx < state.map.towers.length; towerIdx++) {
    const tower = state.map.towers[towerIdx]!;
    if (tower.zone !== zone || !state.towerAlive[towerIdx]) continue;
    zoneTowers.push({ row: tower.row, col: tower.col });
  }
  if (zoneTowers.length === 0) return;

  // Reuse bank/edge spawn logic (border-first, then water proximity)
  const positions = findGruntSpawnPositions(state, player, totalCount);

  // Round-robin towers, for each pick the nearest available position
  const used = new Set<number>();
  for (let gruntIdx = 0; gruntIdx < positions.length; gruntIdx++) {
    const tower = zoneTowers[gruntIdx % zoneTowers.length]!;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let posIdx = 0; posIdx < positions.length; posIdx++) {
      if (used.has(posIdx)) continue;
      const pos = positions[posIdx]!;
      const dist = distanceToTower(tower, pos.row, pos.col);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = posIdx;
      }
    }
    if (bestIdx < 0) break;
    used.add(bestIdx);
    const pick = positions[bestIdx]!;
    addGrunt(state, pick.row, pick.col);
  }
  if (positions.length < totalCount) {
    state.bus.emit(GAME_EVENT.GRUNT_SPAWN_BLOCKED, {
      type: GAME_EVENT.GRUNT_SPAWN_BLOCKED,
      playerId,
      requested: totalCount,
      placed: positions.length,
    });
  }
}

export function gruntAttackTowers(
  state: GameState,
  dt: number,
): TowerKilledMessage[] {
  const deadZones = getDeadZones(state);
  const events: TowerKilledMessage[] = [];
  for (const grunt of state.grunts) {
    // Wall attack: executing decision made by rollGruntWallAttacks() at battle start
    if (grunt.attackingWall) {
      const target = getGruntTargetTower(state, grunt);
      const bestWallKey = pickAdjacentWallKeyForAttack(
        state,
        grunt.row,
        grunt.col,
        target,
      );
      if (bestWallKey >= 0) {
        if (tickGruntAttackTimer(grunt, dt)) {
          // Destroy wall but stay in place.
          // Interior-staleness contract: see battle-system.ts applyImpactEvent JSDoc.
          removeWallFromAllPlayers(state, bestWallKey);
          grunt.attackingWall = false;
        }
        continue;
      }
      // No wall found — stop wall attack
      grunt.attackingWall = false;
    }

    // Grunts with a locked target only attack that specific tower.
    // Untargeted grunts (e.g. spawned by grunt-surge modifier at battle start)
    // attack any adjacent living tower.
    let attackTarget: number | undefined;
    if (grunt.targetTowerIdx !== undefined) {
      if (
        !deadZones.has(state.map.towers[grunt.targetTowerIdx]!.zone) &&
        isAdjacentToLivingTower(
          state,
          grunt.row,
          grunt.col,
          grunt.targetTowerIdx,
        )
      ) {
        attackTarget = grunt.targetTowerIdx;
      }
      // else: target dead or in dead zone — no retargeting (per game rules)
    } else {
      attackTarget =
        adjacentLivingTowerIndex(state, grunt.row, grunt.col, deadZones) ??
        undefined;
    }
    if (attackTarget !== undefined) {
      if (tickGruntAttackTimer(grunt, dt)) {
        state.towerAlive[attackTarget] = false;
        const towerEvent = {
          type: BATTLE_MESSAGE.TOWER_KILLED,
          towerIdx: attackTarget,
        } as const;
        events.push(towerEvent);
        state.bus.emit(BATTLE_MESSAGE.TOWER_KILLED, towerEvent);
      }
    } else {
      // Reset timer if no longer adjacent to attackable tower
      grunt.attackCountdown = undefined;
    }
  }
  return events;
}

/**
 * Called at end of battle: update blockedRounds counter for each grunt.
 * A grunt is "blocked" if it has an alive target tower but is not adjacent to it.
 */
export function updateGruntBlockedBattles(state: GameState): void {
  for (const grunt of state.grunts) {
    const liveTarget = getLiveTargetTower(state, grunt);
    if (!liveTarget) continue;

    const adjacent = isAdjacentToLivingTower(
      state,
      grunt.row,
      grunt.col,
      liveTarget.towerIndex,
    );

    if (adjacent) {
      grunt.blockedRounds = 0;
    } else {
      grunt.blockedRounds += 1;
    }
    // Clear wall attack state (decision does not persist across rounds)
    grunt.attackingWall = false;
  }
}

/**
 * Called at start of battle: blocked grunts (≥2 battles) with alive target
 * have 1/4 chance to attack an adjacent wall.
 */
/** attackingWall lifecycle: rollGruntWallAttacks (set) → gruntAttackTowers (execute) →
 *  updateGruntBlockedBattles (clear). All three run during BATTLE phase only. */
export function rollGruntWallAttacks(state: GameState): void {
  for (const grunt of state.grunts) {
    if (!canAttemptWallAttack(state, grunt)) continue;

    if (state.rng.bool(GRUNT_WALL_ATTACK_CHANCE)) {
      grunt.attackingWall = true;
    }
  }
}

/** Spawn interbattle grunts on each player's zone (bank-first).
 *  PRECONDITION: interior must be fresh (recheckTerritory already called). */
export function spawnInterbattleGrunts(state: GameState): void {
  if (state.round < FIRST_GRUNT_SPAWN_ROUND) return;

  for (const player of state.players.filter(isPlayerSeated)) {
    let spawnCount = 0;
    for (let idx = 0; idx < INTERBATTLE_GRUNT_SPAWN_ATTEMPTS; idx++) {
      if (state.rng.bool(INTERBATTLE_GRUNT_SPAWN_CHANCE)) spawnCount++;
    }
    if (spawnCount === 0) continue;
    for (let spawnIdx = 0; spawnIdx < spawnCount; spawnIdx++) {
      spawnGruntOnZone(state, player.id);
    }
  }
}

/** Spawn a single grunt on the given player's zone (bank-first). */
export function spawnGruntOnZone(
  state: GameState,
  playerId: ValidPlayerSlot,
): void {
  const player = state.players[playerId];
  if (!isPlayerSeated(player)) return;
  const spawnPos = findGruntSpawnPositions(state, player, 1);
  for (const pos of spawnPos) {
    addGrunt(state, pos.row, pos.col);
  }
  if (spawnPos.length === 0) {
    state.bus.emit(GAME_EVENT.GRUNT_SPAWN_BLOCKED, {
      type: GAME_EVENT.GRUNT_SPAWN_BLOCKED,
      playerId,
      requested: 1,
      placed: 0,
    });
  }
}

/** Add a grunt at (row, col). Validates position is in-bounds and on passable grass.
 *  victimPlayerId is derived from the zone owner at spawn.
 *  lockGruntTarget() is the source of truth — it reassigns victimPlayerId
 *  based on the actual target tower's zone (e.g. during frozen river crossings). */
function addGrunt(state: GameState, row: number, col: number): void {
  if (!inBounds(row, col) || !isGrass(state.map.tiles, row, col)) return;
  const victimPlayerId = zoneOwnerIdAt(state, row, col);
  state.grunts.push({ row, col, victimPlayerId, blockedRounds: 0 });
  state.bus.emit(GAME_EVENT.GRUNT_SPAWN, {
    type: GAME_EVENT.GRUNT_SPAWN,
    row,
    col,
    victimPlayerId,
  });
}

/** Find spawn positions for grunts in an enemy's zone.
 *  Priority: bank (adjacent to water, waterDist=1) → edge (row/col 0 or max) → nothing.
 *  Within each tier, tiles closer to targetRow/targetCol are preferred.
 *  If targetRow/targetCol are not provided, uses the zone's alive towers as targets. */
function findGruntSpawnPositions(
  state: GameState,
  enemy: Player,
  count: number,
  targetRow?: number,
  targetCol?: number,
): TilePos[] {
  const zone = enemy.homeTower?.zone;
  if (zone === undefined) return [];

  const bank: { row: number; col: number }[] = [];
  const edge: { row: number; col: number }[] = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      if (state.map.zones[row]![col] !== zone) continue;
      if (!isValidGruntSpawnTile(state, row, col)) continue;
      if (minWaterDistance(state, row, col) <= 1) {
        bank.push({ row, col });
      } else if (isEdgeTile(row, col)) {
        edge.push({ row, col });
      }
    }
  }

  // Determine sort target: explicit position or nearest alive tower center
  let sortRow = targetRow;
  let sortCol = targetCol;
  if (sortRow === undefined || sortCol === undefined) {
    const aliveTower = state.map.towers.find(
      (tower) =>
        tower.zone === zone &&
        state.towerAlive[state.map.towers.indexOf(tower)],
    );
    if (aliveTower) {
      sortRow = aliveTower.row + 1;
      sortCol = aliveTower.col + 1;
    }
  }

  // Sort each tier by distance to target (closest first)
  const sortByTarget = (
    arr: { row: number; col: number }[],
  ): { row: number; col: number }[] => {
    if (sortRow !== undefined && sortCol !== undefined) {
      const sr = sortRow;
      const sc = sortCol;
      arr.sort(
        (tileA, tileB) =>
          manhattanDistance(tileA.row, tileA.col, sr, sc) -
          manhattanDistance(tileB.row, tileB.col, sr, sc),
      );
    }
    return arr;
  };
  sortByTarget(bank);
  sortByTarget(edge);

  // Pick from bank first, then edge, with min spacing
  const result: TilePos[] = [];
  const pick = (candidates: readonly { row: number; col: number }[]) => {
    for (const cand of candidates) {
      if (result.length >= count) return;
      const tooClose = result.some(
        (existing) =>
          manhattanDistance(existing.row, existing.col, cand.row, cand.col) <
          GRUNT_SPAWN_MIN_DISTANCE,
      );
      if (tooClose) continue;
      result.push({ row: cand.row, col: cand.col });
    }
  };
  pick(bank);
  pick(edge);
  return result;
}

function isEdgeTile(row: number, col: number): boolean {
  return row <= 0 || col <= 0 || row >= GRID_ROWS - 1 || col >= GRID_COLS - 1;
}

/** Core validity check for grunt spawning. Rejects frozen water (grunts
 *  walk on ice but cannot spawn there), walls, interior territory, existing
 *  grunts, and all blocking obstacles (cannons, houses, towers, pits).
 *  Zone filtering and batch-dedup are layered on top by callers. */
function isValidGruntSpawnTile(
  state: GameState,
  row: number,
  col: number,
): boolean {
  if (!inBounds(row, col)) return false;
  if (!isGrass(state.map.tiles, row, col)) return false;
  if (!isGruntPassableTile(state, row, col)) return false;
  if (hasInteriorAt(state, packTile(row, col))) return false;
  return !hasGruntAt(state.grunts, row, col);
}

function minWaterDistance(state: GameState, row: number, col: number): number {
  let minWaterDist = Infinity;
  for (
    let dr = -WATER_SEARCH_RADIUS;
    dr <= WATER_SEARCH_RADIUS && minWaterDist > 1;
    dr++
  ) {
    for (
      let dc = -WATER_SEARCH_RADIUS;
      dc <= WATER_SEARCH_RADIUS && minWaterDist > 1;
      dc++
    ) {
      const nr = row + dr;
      const nc = col + dc;
      if (inBounds(nr, nc) && isWater(state.map.tiles, nr, nc)) {
        const distance = Math.abs(dr) + Math.abs(dc);
        if (distance < minWaterDist) minWaterDist = distance;
      }
    }
  }
  return minWaterDist;
}

function canAttemptWallAttack(state: GameState, grunt: Grunt): boolean {
  return (
    hasBlockedBattlesForWallAttack(grunt) &&
    getLiveTargetTower(state, grunt) !== null &&
    hasAdjacentWall(state, grunt.row, grunt.col)
  );
}

function hasBlockedBattlesForWallAttack(
  grunt: Pick<Grunt, "blockedRounds">,
): boolean {
  return grunt.blockedRounds >= GRUNT_WALL_ATTACK_MIN_BATTLES;
}

function hasAdjacentWall(state: GameState, row: number, col: number): boolean {
  return adjacentWallKeys(state, row, col).length > 0;
}

function tickGruntAttackTimer(grunt: Grunt, dt: number): boolean {
  if (grunt.attackCountdown === undefined) {
    grunt.attackCountdown = GRUNT_ATTACK_DURATION;
  }
  grunt.attackCountdown -= dt;
  if (grunt.attackCountdown <= 0) {
    grunt.attackCountdown = undefined;
    return true;
  }
  return false;
}

function pickAdjacentWallKeyForAttack(
  state: GameState,
  row: number,
  col: number,
  target: TilePos | null,
): number {
  const walls = adjacentWallKeys(state, row, col);
  if (!target) return walls[0] ?? -1;
  let bestWallKey = -1;
  let bestDist = Infinity;
  for (const wallKey of walls) {
    const { r: nr, c: nc } = unpackTile(wallKey);
    const distance = manhattanDistance(nr, nc, target.row, target.col);
    if (distance < bestDist) {
      bestDist = distance;
      bestWallKey = wallKey;
    }
  }
  return bestWallKey;
}

function adjacentWallKeys(
  state: GameState,
  row: number,
  col: number,
): number[] {
  const walls: number[] = [];
  for (const [dr, dc] of DIRS_4) {
    const nr = row + dr;
    const nc = col + dc;
    if (!inBounds(nr, nc)) continue;
    if (!hasWallAt(state, nr, nc)) continue;
    walls.push(packTile(nr, nc));
  }
  return walls;
}
