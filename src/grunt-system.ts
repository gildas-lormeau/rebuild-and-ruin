/**
 * Grunt system — spawning, movement, pathfinding, and tower attacks.
 */

import { MESSAGE } from "../server/protocol.ts";
import {
  collectOccupiedTiles,
  findLivingTowerIndexAt,
  GRUNT_SPAWN_BLOCKED,
  hasAliveHouseAt,
  hasCannonAt,
  hasGruntAt,
  hasInteriorAt,
  hasTowerAt,
  hasWallAt,
  removeWallFromAllPlayers,
} from "./board-occupancy.ts";
import {
  GRUNT_ATTACK_DURATION,
  GRUNT_WALL_ATTACK_CHANCE,
  GRUNT_WALL_ATTACK_MIN_BATTLES,
  NO_TOWER_INDEX,
  TOWER_SIZE,
} from "./game-constants.ts";
import type { TilePos } from "./geometry-types.ts";
import { GRID_COLS, GRID_ROWS } from "./grid.ts";
import {
  DIRS_4,
  distanceToTower,
  hasPitAt,
  inBounds,
  isGrass,
  isWater,
  manhattanDistance,
  packTile,
  unpackTile,
} from "./spatial.ts";
import {
  type GameState,
  type Grunt,
  isPlayerActive,
  type Player,
} from "./types.ts";

/**
 * Grunts adjacent to an alive tower start a 3-second attack timer.
 * When the timer reaches 0, the tower is killed.
 * Called each battle tick with dt in seconds.
 */
interface GruntAttackEvent {
  type: typeof MESSAGE.TOWER_KILLED;
  towerIdx: number;
}

/** Search radius for finding nearest water tile. */
const WATER_SEARCH_RADIUS = 5;
/** Minimum Manhattan distance between spawn candidates so grunts don't cluster on arrival. */
const GRUNT_SPAWN_MIN_DISTANCE = 2;
/** Manhattan radius for checking if another grunt targeting the same tower is queued nearby. */
const GRUNT_BLOCKED_NEARBY_DISTANCE = 2;

export function spawnGruntNearPos(
  state: GameState,
  destroyerId: number,
  posRow: number,
  posCol: number,
): void {
  if (state.players.every((p) => p.id === destroyerId || p.eliminated)) return;
  const pos = findGruntSpawnNear(state, posRow, posCol);
  if (pos) addGrunt(state, pos.row, pos.col, destroyerId);
}

/**
 * Spawn a grunt near a position (BFS to find nearest free tile).
 * The grunt targets the player identified by destroyerId.
 */
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

    const tileKey = packTile(r, c);
    if (
      inBounds(r, c) &&
      isGruntPassableTile(state, r, c) &&
      !hasInteriorAt(state, tileKey) &&
      !hasGruntAt(state, r, c)
    ) {
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
export function spawnGruntOnZone(state: GameState, playerId: number): void {
  const player = state.players[playerId];
  if (!isPlayerActive(player)) return;
  const spawnPos = findGruntSpawnPositions(state, player, 1);
  for (const pos of spawnPos) {
    addGrunt(state, pos.row, pos.col, playerId);
  }
}

/** Spawn a group of grunts on a player's zone, clustered together so they naturally target the same tower. */
export function spawnGruntGroupOnZone(
  state: GameState,
  playerId: number,
  count: number,
): void {
  const player = state.players[playerId];
  if (!isPlayerActive(player)) return;
  const zone = player.homeTower.zone;

  // Find one anchor position, then cluster remaining grunts on adjacent tiles
  const anchorPos = findGruntSpawnPositions(state, player, 1);
  if (anchorPos.length === 0) return;
  const anchor = anchorPos[0]!;
  const occupied = new Set<number>();
  let placed = 0;

  const pushGrunt = (r: number, c: number) => {
    occupied.add(packTile(r, c));
    addGrunt(state, r, c, playerId);
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

/**
 * Tick grunt movement during battle phase. Each grunt moves 1 step toward
 * the nearest enemy tower. When blocked by another grunt, tries orthogonal
 * moves to go around, producing natural encirclement of towers.
 * Returns true if any grunt moved (for animation purposes).
 *
 * INVARIANT: targets must be locked before movement. The two-pass order is:
 * 1. lockGruntTarget() for all grunts (assigns targetTowerIdx/targetPlayerId)
 * 2. Sort by distance, then move each grunt toward its locked target
 * These passes must not be interleaved — a grunt's target must not change mid-move.
 */
export function tickGrunts(state: GameState): boolean {
  let anyMoved = false;

  // Pass 1: Lock all targets before sorting — all mutation happens here, once per grunt
  for (const grunt of state.grunts) {
    lockGruntTarget(state, grunt);
  }

  // Sort grunts by distance to their target (closest first) so they don't block each other
  const sorted = [...state.grunts].sort((a, b) => {
    const ta = gruntTargetPos(state, a);
    const tb = gruntTargetPos(state, b);
    const da = ta ? distanceToTower(ta, a.row, a.col) : Infinity;
    const db = tb ? distanceToTower(tb, b.row, b.col) : Infinity;
    return da - db;
  });

  for (const grunt of sorted) {
    if (moveOneGrunt(state, grunt)) anyMoved = true;
  }

  return anyMoved;
}

export function gruntAttackTowers(
  state: GameState,
  dt: number,
): GruntAttackEvent[] {
  const events: GruntAttackEvent[] = [];
  for (const grunt of state.grunts) {
    // Wall attack: blocked grunts that decided to attack a wall
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
          removeWallFromAllPlayers(state, bestWallKey);
          grunt.wallAttack = false;
        }
        continue;
      }
      // No wall found — stop wall attack
      grunt.wallAttack = false;
    }

    // Check if adjacent to an alive tower
    const adjacentTowerIndex = adjacentLivingTowerIndex(
      state,
      grunt.row,
      grunt.col,
    );
    if (adjacentTowerIndex >= 0) {
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

    // Check if adjacent to target tower
    const adjacent = isAdjacentToLivingTower(
      state,
      grunt.row,
      grunt.col,
      liveTarget.towerIndex,
    );

    if (adjacent) {
      grunt.blockedBattles = 0;
    } else {
      grunt.blockedBattles = (grunt.blockedBattles ?? 0) + 1;
    }
    // Clear wall attack state for next round
    grunt.wallAttack = false;
  }
}

/**
 * Called at start of battle: blocked grunts (≥2 battles) with alive target
 * have 1/4 chance to attack an adjacent wall.
 */
export function rollGruntWallAttacks(state: GameState): void {
  for (const grunt of state.grunts) {
    if (!canAttemptWallAttack(state, grunt)) continue;

    if (state.rng.bool(GRUNT_WALL_ATTACK_CHANCE)) {
      grunt.wallAttack = true;
    }
  }
}

/** Move a single grunt toward its target. Returns true if it moved. */
function moveOneGrunt(state: GameState, grunt: Grunt): boolean {
  // Already adjacent to alive target tower — stay put unless blocking a friend
  if (grunt.targetTowerIdx !== undefined) {
    const t = getGruntTargetTower(state, grunt);
    if (t && state.towerAlive[grunt.targetTowerIdx]!) {
      const adjacent = isAdjacentToLivingTower(
        state,
        grunt.row,
        grunt.col,
        grunt.targetTowerIdx,
      );
      if (adjacent) {
        // Slide along the tower perimeter to make room for grunts behind us
        if (hasNonAdjacentBlockedAlly(state, grunt)) {
          const slide = findAdjacentSlideTarget(state, grunt);
          if (slide) {
            applyGruntMove(grunt, slide.row, slide.col);
            return true;
          }
        }
        return false;
      }
    }
    // Dead target tower — stop once adjacent to its footprint
    if (t && !state.towerAlive[grunt.targetTowerIdx]!) {
      if (distanceToTower(t, grunt.row, grunt.col) <= 1) return false;
    }
  }

  const candidates = gruntCandidateMoves(state, grunt);
  for (const candidate of candidates) {
    const { row: nr, col: nc } = candidate;
    if (!canGruntMoveToCandidate(state, grunt, nr, nc)) continue;
    applyGruntMove(grunt, nr, nc);
    return true;
  }
  return false;
}

function addGrunt(
  state: GameState,
  row: number,
  col: number,
  targetPlayerId: number,
): void {
  state.grunts.push({ row, col, targetPlayerId });
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
  occupied: Set<number>,
  row: number,
  col: number,
  key: number,
): boolean {
  if (!inBounds(row, col)) return false;
  if (!isGrass(state.map.tiles, row, col)) return false;
  if (state.map.zones[row]![col] !== zone) return false;
  if (!isGruntPassableTile(state, row, col)) return false;
  if (occupied.has(key)) return false;
  if (hasGruntAt(state, row, col)) return false;
  if (hasInteriorAt(state, key)) return false;
  return true;
}

/** Find spawn positions for grunts in an enemy's zone, along the river bank. */
function findGruntSpawnPositions(
  state: GameState,
  enemy: Player,
  count: number,
): TilePos[] {
  const zone = enemy.homeTower?.zone;
  if (zone === undefined) return [];

  const blocked = collectOccupiedTiles(state, GRUNT_SPAWN_BLOCKED);

  // Collect available grass tiles in zone, sorted by proximity to water
  const candidates: {
    row: number;
    col: number;
    waterDist: number;
    borderDist: number;
  }[] = [];
  for (let r = 1; r < GRID_ROWS - 1; r++) {
    for (let c = 1; c < GRID_COLS - 1; c++) {
      if (!isGrass(state.map.tiles, r, c)) continue;
      if (state.map.zones[r]![c] !== zone) continue;
      if (isGruntBlocked(state, r, c)) continue;
      const key = packTile(r, c);
      if (blocked.has(key)) continue;

      // Distance to nearest water
      const waterDist = minWaterDistance(state, r, c);
      // Distance to nearest map border
      const borderDist = Math.min(r, c, GRID_ROWS - 1 - r, GRID_COLS - 1 - c);
      candidates.push({ row: r, col: c, waterDist, borderDist });
    }
  }

  // Prefer tiles near map borders first, then closest to water (bank)
  candidates.sort(
    (a, b) => a.borderDist - b.borderDist || a.waterDist - b.waterDist,
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
        const d = Math.abs(dr) + Math.abs(dc);
        if (d < minWaterDist) minWaterDist = d;
      }
    }
  }
  return minWaterDist;
}

/**
 * Lock a grunt onto its nearest tower target if not already locked.
 * Mutates grunt.targetTowerIdx and grunt.targetPlayerId.
 * Call once per grunt before any sorting or movement.
 */
function lockGruntTarget(state: GameState, grunt: Grunt): void {
  if (grunt.targetTowerIdx !== undefined) return;

  const gruntZone = state.map.zones[grunt.row]?.[grunt.col] ?? -1;
  let bestDist = Infinity;
  let bestIdx = NO_TOWER_INDEX;

  for (let i = 0; i < state.map.towers.length; i++) {
    const t = state.map.towers[i]!;
    if (!state.towerAlive[i]) continue;
    if (t.zone !== gruntZone) continue;
    const dist = distanceToTower(t, grunt.row, grunt.col);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  if (bestIdx === NO_TOWER_INDEX) return;
  grunt.targetTowerIdx = bestIdx;

  // Correct targetPlayerId to match zone owner (in case of mismatch from spawn)
  const towerZone = state.map.towers[bestIdx]!.zone;
  const zoneOwner = state.players.find((p) => p.homeTower?.zone === towerZone);
  if (zoneOwner && zoneOwner.id !== grunt.targetPlayerId) {
    grunt.targetPlayerId = zoneOwner.id;
  }
}

/**
 * Ranked candidate moves for a grunt.
 * 1. Forward moves (reduce distance to target), sorted closest first
 * 2. Orthogonal moves (same distance), for going around blockers
 * tickGrunts tries them in order, skipping grunt-occupied tiles.
 */
function gruntCandidateMoves(state: GameState, grunt: Grunt): TilePos[] {
  const target = gruntTargetPos(state, grunt);
  if (!target) return [];

  const towerDist = (r: number, c: number) => distanceToTower(target, r, c);

  const curDist = towerDist(grunt.row, grunt.col);
  const forward: { row: number; col: number; dist: number }[] = [];
  const sideways: { row: number; col: number; dist: number }[] = [];

  for (const [dr, dc] of DIRS_4) {
    const nr = grunt.row + dr;
    const nc = grunt.col + dc;
    if (!inBounds(nr, nc)) continue;

    // Skip impassable tiles (but towers are checked separately in tickGrunts)
    if (!isGruntPassableTile(state, nr, nc)) continue;

    const newDist = towerDist(nr, nc);
    if (newDist < curDist) {
      forward.push({ row: nr, col: nc, dist: newDist });
    } else {
      // Allow sideways moves that don't move away on the moving axis
      if (isSidewaysAxisAllowed(target, grunt.row, grunt.col, nr, nc, dr)) {
        sideways.push({ row: nr, col: nc, dist: newDist });
      }
    }
  }

  forward.sort((a, b) => a.dist - b.dist);
  sideways.sort((a, b) => a.dist - b.dist);

  const moves: TilePos[] = [];

  // 1. Forward moves
  for (const m of forward) moves.push({ row: m.row, col: m.col });

  // 2. Sideways moves: pacing back and forth along obstacles
  for (const m of sideways) moves.push({ row: m.row, col: m.col });

  return moves;
}

/**
 * Return the target tower position for a grunt.
 * Pure read — grunt must already be locked via lockGruntTarget.
 */
function gruntTargetPos(state: GameState, grunt: Grunt): TilePos | null {
  const t = getGruntTargetTower(state, grunt);
  return t ? { row: t.row, col: t.col } : null;
}

/** Check if a sideways move is acceptable (doesn't increase distance to target).
 *  Towers are 2×2: distance is 0 if within [target.row, target.row+1] / [target.col, target.col+1],
 *  else Manhattan distance to nearest edge tile. */
function isSidewaysAxisAllowed(
  target: TilePos,
  fromRow: number,
  fromCol: number,
  toRow: number,
  toCol: number,
  stepRow: number,
): boolean {
  // Distance to nearest edge of 2×2 tower footprint (0 if adjacent/overlapping)
  const rowDist = Math.max(0, target.row - fromRow, fromRow - (target.row + 1));
  const colDist = Math.max(0, target.col - fromCol, fromCol - (target.col + 1));
  const movingRow = stepRow !== 0;
  const nRowDist = Math.max(0, target.row - toRow, toRow - (target.row + 1));
  const nColDist = Math.max(0, target.col - toCol, toCol - (target.col + 1));
  const axisAway = movingRow ? nRowDist > rowDist : nColDist > colDist;
  const axisDistZero = movingRow ? rowDist === 0 : colDist === 0;
  return !axisAway || axisDistZero;
}

function isAdjacentToLivingTower(
  state: GameState,
  row: number,
  col: number,
  towerIndex: number,
): boolean {
  return adjacentLivingTowerIndex(state, row, col) === towerIndex;
}

function adjacentLivingTowerIndex(
  state: GameState,
  row: number,
  col: number,
): number {
  for (const [dr, dc] of DIRS_4) {
    const towerIndex = findLivingTowerIndexAt(state, row + dr, col + dc);
    if (towerIndex >= 0) return towerIndex;
  }
  return -1;
}

function canAttemptWallAttack(state: GameState, grunt: Grunt): boolean {
  return (
    hasBlockedBattlesForWallAttack(grunt) &&
    getLiveTargetTower(state, grunt) !== null &&
    hasAdjacentWall(state, grunt.row, grunt.col)
  );
}

function getLiveTargetTower(
  state: GameState,
  grunt: Pick<Grunt, "targetTowerIdx">,
) {
  const tower = getGruntTargetTower(state, grunt);
  if (!tower || grunt.targetTowerIdx === undefined) return null;
  if (!state.towerAlive[grunt.targetTowerIdx]!) return null;
  return { towerIndex: grunt.targetTowerIdx, tower };
}

function getGruntTargetTower(
  state: GameState,
  grunt: Pick<Grunt, "targetTowerIdx">,
) {
  if (grunt.targetTowerIdx === undefined) return null;
  return state.map.towers[grunt.targetTowerIdx] ?? null;
}

function hasBlockedBattlesForWallAttack(
  grunt: Pick<Grunt, "blockedBattles">,
): boolean {
  return (grunt.blockedBattles ?? 0) >= GRUNT_WALL_ATTACK_MIN_BATTLES;
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
  let bestWallKey = -1;
  let bestDist = Infinity;
  for (const wallKey of adjacentWallKeys(state, row, col)) {
    if (!target) return wallKey;
    const { r: nr, c: nc } = unpackTile(wallKey);
    const d = manhattanDistance(nr, nc, target.row, target.col);
    if (d < bestDist) {
      bestDist = d;
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

/** True if a nearby ally grunt (same target) is NOT yet adjacent to the tower — triggers slide behavior. */
function hasNonAdjacentBlockedAlly(state: GameState, grunt: Grunt): boolean {
  if (grunt.targetTowerIdx === undefined) return false;
  for (const other of state.grunts) {
    if (other === grunt) continue;
    if (other.targetTowerIdx !== grunt.targetTowerIdx) continue;
    // Is the other grunt NOT adjacent to the tower?
    if (
      isCardinalAdjacentToTower(
        state,
        other.row,
        other.col,
        grunt.targetTowerIdx,
      )
    )
      continue;
    // Is it close enough to be blocked by us?
    if (
      manhattanDistance(grunt.row, grunt.col, other.row, other.col) <=
      GRUNT_BLOCKED_NEARBY_DISTANCE
    )
      return true;
  }
  return false;
}

/** Find an unoccupied tile still adjacent to the target tower to slide to. */
function findAdjacentSlideTarget(
  state: GameState,
  grunt: Grunt,
): TilePos | null {
  if (grunt.targetTowerIdx === undefined) return null;
  for (const [dr, dc] of DIRS_4) {
    const nr = grunt.row + dr,
      nc = grunt.col + dc;
    if (!inBounds(nr, nc)) continue;
    if (!isGruntPassableTile(state, nr, nc)) continue;
    if (hasGruntAt(state, nr, nc, grunt)) continue;
    if (hasInteriorAt(state, packTile(nr, nc))) continue;
    // Must still be adjacent to the target tower
    if (!isCardinalAdjacentToTower(state, nr, nc, grunt.targetTowerIdx))
      continue;
    return { row: nr, col: nc };
  }
  return null;
}

function isGruntPassableTile(
  state: GameState,
  row: number,
  col: number,
): boolean {
  return !isGruntBlocked(state, row, col) && !hasWallAt(state, row, col);
}

/** Check if a tile is blocked for grunt movement (impassable obstacle). */
function isGruntBlocked(state: GameState, r: number, c: number): boolean {
  if (!inBounds(r, c)) return true;
  if (!isGrass(state.map.tiles, r, c)) return true;
  if (hasCannonAt(state, r, c)) return true;
  if (hasAliveHouseAt(state, r, c)) return true;
  if (hasTowerAt(state, r, c)) return true;
  // Burning pits block
  if (hasPitAt(state.burningPits, r, c)) return true;
  return false;
}

/** Check if a tile is adjacent to any tile of a 2x2 tower (cardinal only). */
function isCardinalAdjacentToTower(
  state: GameState,
  row: number,
  col: number,
  towerIndex: number,
): boolean {
  const tower = state.map.towers[towerIndex];
  if (!tower) return false;
  // A tile is cardinally adjacent if any of its 4 neighbors is a tower tile
  for (const [dr, dc] of DIRS_4) {
    const nr = row + dr,
      nc = col + dc;
    if (
      nr >= tower.row &&
      nr <= tower.row + TOWER_SIZE - 1 &&
      nc >= tower.col &&
      nc <= tower.col + TOWER_SIZE - 1
    ) {
      return true;
    }
  }
  return false;
}

function canGruntMoveToCandidate(
  state: GameState,
  grunt: Grunt,
  row: number,
  col: number,
): boolean {
  // Don't move onto towers — stop adjacent
  if (findLivingTowerIndexAt(state, row, col) >= 0) return false;
  // Don't move onto another grunt
  if (hasGruntAt(state, row, col, grunt)) return false;
  // Don't move into enclosed territory (interior may be stale after wall destruction)
  if (hasInteriorAt(state, packTile(row, col))) return false;
  return true;
}

function applyGruntMove(grunt: Grunt, row: number, col: number): void {
  const dr = row - grunt.row;
  const dc = col - grunt.col;
  grunt.facing = Math.atan2(dc, -dr);
  grunt.row = row;
  grunt.col = col;
}
