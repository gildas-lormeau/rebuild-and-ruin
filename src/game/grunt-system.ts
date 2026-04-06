/**
 * Grunt lifecycle — spawning, respawn, tower attacks, and blocked tracking.
 *
 * Movement and pathfinding live in grunt-movement.ts.
 */

import { MESSAGE } from "../../server/protocol.ts";
import type { Grunt } from "../shared/battle-types.ts";
import {
  hasGruntAt,
  hasInteriorAt,
  hasWallAt,
  removeWallFromAllPlayers,
  zoneOwnerIdAt,
} from "../shared/board-occupancy.ts";
import {
  GRUNT_ATTACK_DURATION,
  GRUNT_WALL_ATTACK_CHANCE,
  GRUNT_WALL_ATTACK_MIN_BATTLES,
} from "../shared/game-constants.ts";
import type { TilePos } from "../shared/geometry-types.ts";
import { GRID_COLS, GRID_ROWS } from "../shared/grid.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import { isPlayerSeated, type Player } from "../shared/player-types.ts";
import {
  DIRS_4,
  distanceToTower,
  inBounds,
  isGrass,
  isWater,
  manhattanDistance,
  packTile,
  unpackTile,
} from "../shared/spatial.ts";
import type { GameState } from "../shared/types.ts";
import {
  adjacentLivingTowerIndex,
  getDeadZones,
  getGruntTargetTower,
  getLiveTargetTower,
  isAdjacentToLivingTower,
  isGruntPassableTile,
} from "./grunt-movement.ts";

/**
 * Grunts adjacent to an alive tower start a 3-second attack timer.
 * When the timer reaches 0, the tower is killed.
 * Called each battle tick with dt in seconds.
 */
interface GruntAttackEvent {
  type: "tower_killed";
  towerIdx: number;
}

/** Search radius for finding nearest water tile. */
const WATER_SEARCH_RADIUS = 5;
/** Minimum Manhattan distance between spawn candidates so grunts don't cluster on arrival. */
const GRUNT_SPAWN_MIN_DISTANCE = 2;

/** Spawn a grunt near (posRow, posCol) if there is at least one other alive player.
 *  Optimization: skips the spawn if excludePlayerId is the only non-eliminated player
 *  (the grunt would have no valid target tower and sit idle). */
export function spawnGruntNearPos(
  state: GameState,
  excludePlayerId: ValidPlayerSlot,
  posRow: number,
  posCol: number,
): void {
  if (
    state.players.every(
      (player) => player.id === excludePlayerId || player.eliminated,
    )
  )
    return;
  const pos = findGruntSpawnNear(state, posRow, posCol);
  if (pos) addGrunt(state, pos.row, pos.col);
}

/** Find the nearest free grass tile for a grunt spawn (BFS from position). Returns null if none found. */
export function findGruntSpawnNear(
  state: GameState,
  posRow: number,
  posCol: number,
): TilePos | null {
  const visited = new Set<number>();
  const queue: TilePos[] = [{ row: posRow, col: posCol }];
  visited.add(packTile(posRow, posCol));

  while (queue.length > 0) {
    const { row: r, col: c } = queue.shift()!;

    if (isValidGruntSpawnTile(state, r, c)) {
      return { row: r, col: c };
    }

    for (const [dr, dc] of DIRS_4) {
      const nr = r + dr,
        nc = c + dc;
      enqueueUnvisitedTile(visited, queue, nr, nc);
    }
  }
  return null;
}

/** Spawn a single grunt immediately on the given player's zone. */
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
}

/** Spawn a group of grunts on a player's zone, clustered together so they naturally target the same tower. */
export function spawnGruntGroupOnZone(
  state: GameState,
  playerId: ValidPlayerSlot,
  count: number,
): void {
  const player = state.players[playerId];
  if (!isPlayerSeated(player)) return;
  const zone = player.homeTower.zone;

  // Find one anchor position, then cluster remaining grunts on adjacent tiles
  const anchorPos = findGruntSpawnPositions(state, player, 1);
  if (anchorPos.length === 0) return;
  const anchor = anchorPos[0]!;
  const occupied = new Set<number>();
  let placed = 0;

  const pushGrunt = (r: number, c: number) => {
    occupied.add(packTile(r, c));
    addGrunt(state, r, c);
    placed++;
  };
  pushGrunt(anchor.row, anchor.col);

  // Place remaining grunts on adjacent free tiles (BFS outward from anchor)
  const queue: TilePos[] = [{ row: anchor.row, col: anchor.col }];
  const visited = new Set<number>([packTile(anchor.row, anchor.col)]);
  while (placed < count && queue.length > 0) {
    const { row: r, col: c } = queue.shift()!;
    for (const [dr, dc] of DIRS_4) {
      const nr = r + dr,
        nc = c + dc;
      const nKey = packTile(nr, nc);
      if (visited.has(nKey)) continue;
      visited.add(nKey);
      if (!canUseGroupSpawnTile(state, zone, occupied, nr, nc, nKey)) continue;
      pushGrunt(nr, nc);
      queue.push({ row: nr, col: nc });
      if (placed >= count) break;
    }
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
  for (let ti = 0; ti < state.map.towers.length; ti++) {
    const tower = state.map.towers[ti]!;
    if (tower.zone !== zone || !state.towerAlive[ti]) continue;
    zoneTowers.push({ row: tower.row, col: tower.col });
  }
  if (zoneTowers.length === 0) return;

  // Reuse bank/edge spawn logic (border-first, then water proximity)
  const positions = findGruntSpawnPositions(state, player, totalCount);

  // Round-robin towers, for each pick the nearest available position
  const used = new Set<number>();
  for (let gi = 0; gi < positions.length; gi++) {
    const tower = zoneTowers[gi % zoneTowers.length]!;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let pi = 0; pi < positions.length; pi++) {
      if (used.has(pi)) continue;
      const pos = positions[pi]!;
      const dist = distanceToTower(tower, pos.row, pos.col);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = pi;
      }
    }
    if (bestIdx < 0) break;
    used.add(bestIdx);
    const pick = positions[bestIdx]!;
    addGrunt(state, pick.row, pick.col);
  }
}

export function gruntAttackTowers(
  state: GameState,
  dt: number,
): GruntAttackEvent[] {
  const deadZones = getDeadZones(state);
  const events: GruntAttackEvent[] = [];
  for (const grunt of state.grunts) {
    // Wall attack: executing decision made by rollGruntWallAttacks() at battle start
    if (grunt.wallAttack) {
      const target = getGruntTargetTower(state, grunt);
      const bestWallKey = pickAdjacentWallKeyForAttack(
        state,
        grunt.row,
        grunt.col,
        target,
      );
      if (bestWallKey >= 0) {
        if (tickGruntAttackTimer(grunt, dt)) {
          // Destroy wall but stay in place
          // Interior intentionally stale during battle; recheckTerritoryOnly() runs at next build phase.
          removeWallFromAllPlayers(state, bestWallKey);
          grunt.wallAttack = false;
        }
        continue;
      }
      // No wall found — stop wall attack
      grunt.wallAttack = false;
    }

    // Check if adjacent to an alive tower (skip eliminated players)
    const adjacentTowerIndex = adjacentLivingTowerIndex(
      state,
      grunt.row,
      grunt.col,
      deadZones,
    );
    if (adjacentTowerIndex !== null) {
      if (tickGruntAttackTimer(grunt, dt)) {
        state.towerAlive[adjacentTowerIndex] = false;
        events.push({
          type: MESSAGE.TOWER_KILLED,
          towerIdx: adjacentTowerIndex,
        });
      }
    } else {
      // Reset timer if no longer adjacent to a tower
      grunt.attackTimer = undefined;
    }
  }
  return events;
}

/**
 * Called at end of battle: update blockedBattles counter for each grunt.
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
      grunt.blockedBattles = 0;
    } else {
      grunt.blockedBattles += 1;
    }
    // Clear wall attack state (decision does not persist across rounds)
    grunt.wallAttack = false;
  }
}

/**
 * Called at start of battle: blocked grunts (≥2 battles) with alive target
 * have 1/4 chance to attack an adjacent wall.
 */
/** wallAttack lifecycle: rollGruntWallAttacks (set) → gruntAttackTowers (execute) →
 *  updateGruntBlockedBattles (clear). All three run during BATTLE phase only. */
export function rollGruntWallAttacks(state: GameState): void {
  for (const grunt of state.grunts) {
    if (!canAttemptWallAttack(state, grunt)) continue;

    if (state.rng.bool(GRUNT_WALL_ATTACK_CHANCE)) {
      grunt.wallAttack = true;
    }
  }
}

/** Add a grunt at (row, col). Validates position is in-bounds and on passable grass.
 *  victimPlayerId is derived from the zone owner at spawn.
 *  lockGruntTarget() is the source of truth — it reassigns victimPlayerId
 *  based on the actual target tower's zone (e.g. during frozen river crossings). */
function addGrunt(state: GameState, row: number, col: number): void {
  if (!inBounds(row, col) || !isGrass(state.map.tiles, row, col)) return;
  state.grunts.push({
    row,
    col,
    victimPlayerId: zoneOwnerIdAt(state, row, col),
    blockedBattles: 0,
  });
}

function enqueueUnvisitedTile(
  visited: Set<number>,
  queue: TilePos[],
  row: number,
  col: number,
): void {
  if (!inBounds(row, col)) return;
  const key = packTile(row, col);
  if (visited.has(key)) return;
  visited.add(key);
  queue.push({ row, col });
}

function canUseGroupSpawnTile(
  state: GameState,
  zone: number,
  occupied: ReadonlySet<number>,
  row: number,
  col: number,
  key: number,
): boolean {
  if (occupied.has(key)) return false;
  if (state.map.zones[row]?.[col] !== zone) return false;
  return isValidGruntSpawnTile(state, row, col);
}

/** Find spawn positions for grunts in an enemy's zone, along the river bank. */
function findGruntSpawnPositions(
  state: GameState,
  enemy: Player,
  count: number,
): TilePos[] {
  const zone = enemy.homeTower?.zone;
  if (zone === undefined) return [];

  // Collect available grass tiles in zone, sorted by proximity to water
  const candidates: {
    row: number;
    col: number;
    waterDist: number;
    borderDist: number;
  }[] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (state.map.zones[r]![c] !== zone) continue;
      if (!isValidGruntSpawnTile(state, r, c)) continue;

      const waterDist = minWaterDistance(state, r, c);
      const borderDist = Math.min(r, c, GRID_ROWS - 1 - r, GRID_COLS - 1 - c);
      candidates.push({ row: r, col: c, waterDist, borderDist });
    }
  }

  // Prefer tiles near water (bank) first, then map borders as tiebreaker
  candidates.sort(
    (a, b) => a.waterDist - b.waterDist || a.borderDist - b.borderDist,
  );

  const result: TilePos[] = [];
  for (const cand of candidates) {
    if (result.length >= count) break;
    const tooClose = result.some(
      (r) =>
        manhattanDistance(r.row, r.col, cand.row, cand.col) <
        GRUNT_SPAWN_MIN_DISTANCE,
    );
    if (tooClose) continue;
    result.push({ row: cand.row, col: cand.col });
  }

  return result;
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
  grunt: Pick<Grunt, "blockedBattles">,
): boolean {
  return grunt.blockedBattles >= GRUNT_WALL_ATTACK_MIN_BATTLES;
}

function hasAdjacentWall(state: GameState, row: number, col: number): boolean {
  return adjacentWallKeys(state, row, col).length > 0;
}

function tickGruntAttackTimer(grunt: Grunt, dt: number): boolean {
  if (grunt.attackTimer === undefined) {
    grunt.attackTimer = GRUNT_ATTACK_DURATION;
  }
  grunt.attackTimer -= dt;
  if (grunt.attackTimer <= 0) {
    grunt.attackTimer = undefined;
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
