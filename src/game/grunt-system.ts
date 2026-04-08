/**
 * Grunt lifecycle — spawning, respawn, tower attacks, and blocked tracking.
 *
 * Movement and pathfinding live in grunt-movement.ts.
 */

import { MESSAGE, type TowerKilledMessage } from "../../server/protocol.ts";
import type { Grunt } from "../shared/battle-types.ts";
import {
  hasGruntAt,
  hasInteriorAt,
  hasWallAt,
  removeWallFromAllPlayers,
  zoneOwnerIdAt,
} from "../shared/board-occupancy.ts";
import {
  FIRST_GRUNT_SPAWN_ROUND,
  GRUNT_ATTACK_DURATION,
  GRUNT_WALL_ATTACK_CHANCE,
  GRUNT_WALL_ATTACK_MIN_BATTLES,
  INTERBATTLE_GRUNT_SPAWN_ATTEMPTS,
  INTERBATTLE_GRUNT_SPAWN_CHANCE,
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

  let head = 0;
  while (head < queue.length) {
    const { row: r, col: c } = queue[head++]!;

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

/** Spawn a group of grunts on a player's zone, clustered together so they naturally target the same tower.
 *  Uses breach queue when wall breaches exist. */
export function spawnGruntGroupOnZone(
  state: GameState,
  playerId: ValidPlayerSlot,
  count: number,
): void {
  const player = state.players[playerId];
  if (!isPlayerSeated(player)) return;
  if (tryQueueAtBreach(state, player, count)) return;

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
      const neighborKey = packTile(nr, nc);
      if (visited.has(neighborKey)) continue;
      visited.add(neighborKey);
      if (!canUseGroupSpawnTile(state, zone, occupied, nr, nc, neighborKey))
        continue;
      pushGrunt(nr, nc);
      queue.push({ row: nr, col: nc });
      if (placed >= count) break;
    }
  }
}

/** Spawn grunts distributed evenly across alive towers in a player's zone.
 *  Uses the same bank/edge spawn logic as regular grunt spawning, then
 *  round-robin assigns each position to the nearest alive tower.
 *  Uses breach queue when wall breaches exist. */
export function spawnGruntSurgeOnZone(
  state: GameState,
  playerId: ValidPlayerSlot,
  totalCount: number,
): void {
  const player = state.players[playerId];
  if (!isPlayerSeated(player)) return;
  if (tryQueueAtBreach(state, player, totalCount)) return;

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
          // Destroy wall but stay in place
          // Interior intentionally stale during battle; recheckTerritoryOnly() runs at next build phase.
          removeWallFromAllPlayers(state, bestWallKey);
          grunt.attackingWall = false;
        }
        continue;
      }
      // No wall found — stop wall attack
      grunt.attackingWall = false;
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

/** Queue interbattle grunts for staggered breach spawning during build phase.
 *  If wall breaches exist, grunts are queued and drip-fed one-per-tick.
 *  If no breaches (no walls or wide open), grunts spawn immediately.
 *  PRECONDITION: interior must be fresh (recheckTerritoryOnly already called). */
export function queueInterbattleGrunts(state: GameState): void {
  if (state.round < FIRST_GRUNT_SPAWN_ROUND) return;

  for (const player of state.players.filter(isPlayerSeated)) {
    let spawnCount = 0;
    for (let idx = 0; idx < INTERBATTLE_GRUNT_SPAWN_ATTEMPTS; idx++) {
      if (state.rng.bool(INTERBATTLE_GRUNT_SPAWN_CHANCE)) spawnCount++;
    }
    if (spawnCount === 0) continue;

    // tryQueueAtBreach handles breach detection + queuing; falls back to instant
    if (!tryQueueAtBreach(state, player, spawnCount)) {
      for (let spawnIdx = 0; spawnIdx < spawnCount; spawnIdx++) {
        spawnGruntOnZone(state, player.id);
      }
    }
  }
}

/** Spawn a single grunt on the given player's zone.
 *  Uses breach queue when wall breaches exist. */
export function spawnGruntOnZone(
  state: GameState,
  playerId: ValidPlayerSlot,
): void {
  const player = state.players[playerId];
  if (!isPlayerSeated(player)) return;
  if (tryQueueAtBreach(state, player, 1)) return;
  const spawnPos = findGruntSpawnPositions(state, player, 1);
  for (const pos of spawnPos) {
    addGrunt(state, pos.row, pos.col);
  }
}

/** Drain one grunt from the breach spawn queue per call. Called each grunt tick
 *  during build phase. Skips sealed breaches (player repaired the wall),
 *  waits on occupied breaches (previous grunt hasn't moved yet). */
export function tickBreachSpawnQueue(state: GameState): void {
  const queue = state.gruntSpawnQueue;
  let idx = 0;

  while (idx < queue.length) {
    const entry = queue[idx]!;

    if (!isGruntPassableTile(state, entry.row, entry.col)) {
      // Breach sealed by wall repair — drop this entry
      queue.splice(idx, 1);
      continue;
    }

    if (hasGruntAt(state.grunts, entry.row, entry.col)) {
      // Occupied by previous grunt — try next breach position
      idx++;
      continue;
    }

    // Spawn one grunt and exit
    queue.splice(idx, 1);
    addGrunt(state, entry.row, entry.col);
    return;
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
    blockedRounds: 0,
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

/** Try to queue `count` grunts at the player's wall breaches.
 *  Returns true if breaches were found and grunts were queued.
 *  Returns false if no breaches exist (caller should fall back to instant spawn). */
function tryQueueAtBreach(
  state: GameState,
  player: Player,
  count: number = 1,
): boolean {
  if (player.walls.size === 0) return false;
  const breaches = findBreachTiles(state, player);
  if (breaches.length === 0) return false;
  for (let idx = 0; idx < count; idx++) {
    const breach = breaches[idx % breaches.length]!;
    state.gruntSpawnQueue.push({
      row: breach.row,
      col: breach.col,
      victimPlayerId: player.id,
    });
  }
  return true;
}

/** Find breach spawn tiles — the outside entry point of gaps in a player's walls.
 *  First detects chokepoints (grass tiles flanked by barriers on opposite sides),
 *  then returns the passable neighbor on the outside (away from the tower)
 *  so grunts visually enter through the gap rather than popping inside. */
function findBreachTiles(state: GameState, player: Player): TilePos[] {
  const zone = player.homeTower?.zone;
  if (zone === undefined) return [];

  const towerRow = player.homeTower!.row;
  const towerCol = player.homeTower!.col;

  const isBarrier = (row: number, col: number): boolean => {
    if (!inBounds(row, col)) return true;
    if (isWater(state.map.tiles, row, col)) return true;
    return player.walls.has(packTile(row, col));
  };

  const spawnTiles: TilePos[] = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      if (state.map.zones[row]![col] !== zone) continue;
      const key = packTile(row, col);
      if (player.walls.has(key)) continue;
      if (!isGrass(state.map.tiles, row, col)) continue;
      if (hasInteriorAt(state, key)) continue;

      // Must have at least one wall neighbor
      let hasWallNeighbor = false;
      for (const [dr, dc] of DIRS_4) {
        if (
          inBounds(row + dr, col + dc) &&
          player.walls.has(packTile(row + dr, col + dc))
        ) {
          hasWallNeighbor = true;
          break;
        }
      }
      if (!hasWallNeighbor) continue;

      // Flanked by barriers on opposite sides = chokepoint (the gap itself)
      const verticalFlanked =
        isBarrier(row - 1, col) && isBarrier(row + 1, col);
      const horizontalFlanked =
        isBarrier(row, col - 1) && isBarrier(row, col + 1);
      if (!verticalFlanked && !horizontalFlanked) continue;

      // Find the outside neighbor: the passable cardinal neighbor farthest from the tower.
      // Grunts spawn there and walk through the gap toward the tower.
      const outside = findOutsideNeighbor(
        state,
        player,
        row,
        col,
        towerRow,
        towerCol,
      );
      if (outside) spawnTiles.push(outside);
    }
  }

  return deduplicateBreaches(spawnTiles);
}

/** Pick the cardinal neighbor of a gap tile that is farthest from the tower
 *  and passable for grunt spawning. This is the "outside" entry point. */
function findOutsideNeighbor(
  state: GameState,
  player: Player,
  gapRow: number,
  gapCol: number,
  towerRow: number,
  towerCol: number,
): TilePos | undefined {
  let best: TilePos | undefined;
  let bestDist = -1;
  for (const [dr, dc] of DIRS_4) {
    const nr = gapRow + dr;
    const nc = gapCol + dc;
    if (!inBounds(nr, nc)) continue;
    if (!isGrass(state.map.tiles, nr, nc)) continue;
    if (player.walls.has(packTile(nr, nc))) continue;
    // Pick the neighbor farthest from the tower (= outside direction)
    const dist = manhattanDistance(nr, nc, towerRow, towerCol);
    if (dist > bestDist) {
      bestDist = dist;
      best = { row: nr, col: nc };
    }
  }
  return best;
}

/** Keep only breach tiles with minimum spacing to avoid clustering. */
function deduplicateBreaches(breaches: readonly TilePos[]): TilePos[] {
  const result: TilePos[] = [];
  for (const breach of breaches) {
    const tooClose = result.some(
      (existing) =>
        manhattanDistance(existing.row, existing.col, breach.row, breach.col) <
        GRUNT_SPAWN_MIN_DISTANCE,
    );
    if (!tooClose) result.push(breach);
  }
  return result;
}
