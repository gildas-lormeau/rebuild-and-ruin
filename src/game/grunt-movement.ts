/**
 * Grunt movement — pathfinding, target locking, candidate evaluation,
 * and spatial queries for grunt-tower adjacency.
 *
 * Extracted from grunt-system.ts so movement (the complex spatial logic)
 * is separated from lifecycle (spawn, respawn, attack tracking).
 *
 * External consumers: runtime-phase-ticks.ts, online-watcher-tick.ts
 * import tickGrunts from here. grunt-system.ts imports shared helpers
 * (adjacentLivingTowerIndex, getGruntTargetTower, etc.) for attack logic.
 */

import {
  findLivingTowerIndexAt,
  hasAliveHouseAt,
  hasCannonAt,
  hasGruntAt,
  hasInteriorAt,
  hasTowerAt,
  hasWallAt,
} from "../shared/board-occupancy.ts";
import { TOWER_SIZE } from "../shared/game-constants.ts";
import type { TilePos } from "../shared/geometry-types.ts";
import {
  DIRS_4,
  distanceToTower,
  hasPitAt,
  inBounds,
  isGrass,
  manhattanDistance,
  packTile,
} from "../shared/spatial.ts";
import type { GameState, Grunt } from "../shared/types.ts";

/** Manhattan radius for checking if another grunt targeting the same tower is queued nearby. */
const GRUNT_BLOCKED_NEARBY_DISTANCE = 2;

/**
 * Tick grunt movement during battle phase. Each grunt moves 1 step toward
 * the nearest enemy tower. When blocked by another grunt, tries orthogonal
 * moves to go around, producing natural encirclement of towers.
 * Returns true if any grunt moved (for animation purposes).
 *
 * INVARIANT: targets must be locked before movement. The two-pass order is:
 * 1. lockGruntTarget() for all grunts (assigns targetTowerIdx/victimPlayerId)
 * 2. Sort by distance, then move each grunt toward its locked target
 * These passes must not be interleaved — a grunt's target must not change mid-move.
 * Enforced by the single call site in this function; no external API exposes
 * lock+move separately.
 */
export function tickGrunts(state: GameState): boolean {
  let anyMoved = false;
  const deadZones = getDeadZones(state);

  // Pass 1: Lock all targets before sorting — all mutation happens here, once per grunt
  for (const grunt of state.grunts) {
    lockGruntTarget(state, grunt, deadZones);
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

/** Zones owned by eliminated players — grunts must never target or attack their towers. */
export function getDeadZones(state: GameState): ReadonlySet<number> {
  const zones = new Set<number>();
  for (const pl of state.players) {
    if (!pl.eliminated) continue;
    const zone = state.playerZones[pl.id];
    if (zone !== undefined) zones.add(zone);
  }
  return zones;
}

export function getLiveTargetTower(
  state: GameState,
  grunt: Pick<Grunt, "targetTowerIdx">,
) {
  const tower = getGruntTargetTower(state, grunt);
  if (!tower || grunt.targetTowerIdx === undefined) return null;
  if (!state.towerAlive[grunt.targetTowerIdx]!) return null;
  return { towerIndex: grunt.targetTowerIdx, tower };
}

/**
 * Lock a grunt onto its nearest tower target if not already locked.
 * Mutates grunt.targetTowerIdx and grunt.victimPlayerId.
 * Call once per grunt before any sorting or movement.
 */
function lockGruntTarget(
  state: GameState,
  grunt: Grunt,
  deadZones: ReadonlySet<number>,
): void {
  // Drop stale target if it points at an eliminated player's zone
  if (grunt.targetTowerIdx !== undefined) {
    const targetZone = state.map.towers[grunt.targetTowerIdx]?.zone;
    if (targetZone !== undefined && deadZones.has(targetZone)) {
      grunt.targetTowerIdx = undefined;
    } else {
      return;
    }
  }

  const gruntZone = state.map.zones[grunt.row]?.[grunt.col] ?? -1;
  const frozenActive = state.modern?.frozenTiles != null;

  let bestDist = Infinity;
  let bestIdx: number | null = null;

  for (let i = 0; i < state.map.towers.length; i++) {
    const tower = state.map.towers[i]!;
    if (!state.towerAlive[i]) continue;
    if (deadZones.has(tower.zone)) continue;
    // Frozen river: flee to enemy territory (skip own zone)
    // Normal: stay in own zone
    if (frozenActive ? tower.zone === gruntZone : tower.zone !== gruntZone)
      continue;
    const dist = distanceToTower(tower, grunt.row, grunt.col);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  // Fallback: if frozen but no cross-zone tower alive, target same-zone
  if (frozenActive && bestIdx === null) {
    for (let i = 0; i < state.map.towers.length; i++) {
      const tower = state.map.towers[i]!;
      if (!state.towerAlive[i]) continue;
      if (deadZones.has(tower.zone)) continue;
      if (tower.zone !== gruntZone) continue;
      const dist = distanceToTower(tower, grunt.row, grunt.col);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
  }

  if (bestIdx === null) return;
  grunt.targetTowerIdx = bestIdx;

  // Ensure victimPlayerId matches the target tower's zone owner
  // (frozen river can redirect grunts cross-zone, changing the victim)
  const towerZone = state.map.towers[bestIdx]!.zone;
  const zoneOwner = state.players.find(
    (player) => player.homeTower?.zone === towerZone,
  );
  if (zoneOwner && zoneOwner.id !== grunt.victimPlayerId) {
    grunt.victimPlayerId = zoneOwner.id;
  }
}

/** Move a single grunt toward its target. Returns true if it moved. */
function moveOneGrunt(state: GameState, grunt: Grunt): boolean {
  // Already adjacent to alive target tower — stay put unless blocking a friend
  if (grunt.targetTowerIdx !== undefined) {
    const tower = getGruntTargetTower(state, grunt);
    if (tower && state.towerAlive[grunt.targetTowerIdx]!) {
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
    if (tower && !state.towerAlive[grunt.targetTowerIdx]!) {
      if (distanceToTower(tower, grunt.row, grunt.col) <= 1) return false;
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

export function isAdjacentToLivingTower(
  state: GameState,
  row: number,
  col: number,
  towerIndex: number,
): boolean {
  return adjacentLivingTowerIndex(state, row, col) === towerIndex;
}

export function adjacentLivingTowerIndex(
  state: GameState,
  row: number,
  col: number,
  deadZones?: ReadonlySet<number>,
): number | null {
  for (const [dr, dc] of DIRS_4) {
    const towerIndex = findLivingTowerIndexAt(state, row + dr, col + dc);
    if (towerIndex === null) continue;
    if (deadZones?.has(state.map.towers[towerIndex]!.zone)) continue;
    return towerIndex;
  }
  return null;
}

/**
 * Ranked candidate moves for a grunt (2-tier priority):
 * 1. Forward moves — reduce distance to target, sorted closest-first
 * 2. Sideways moves — don't increase distance on the moving axis, for skirting obstacles
 * moveOneGrunt tries them in order, skipping grunt-occupied and interior tiles.
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
  for (const move of forward) moves.push({ row: move.row, col: move.col });
  for (const move of sideways) moves.push({ row: move.row, col: move.col });

  return moves;
}

/**
 * Return the target tower position for a grunt.
 * Pure read — grunt must already be locked via lockGruntTarget.
 */
function gruntTargetPos(state: GameState, grunt: Grunt): TilePos | null {
  const tower = getGruntTargetTower(state, grunt);
  return tower ? { row: tower.row, col: tower.col } : null;
}

export function getGruntTargetTower(
  state: GameState,
  grunt: Pick<Grunt, "targetTowerIdx">,
) {
  if (grunt.targetTowerIdx === undefined) return null;
  return state.map.towers[grunt.targetTowerIdx] ?? null;
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
  const lastTowerRow = target.row + TOWER_SIZE - 1;
  const lastTowerCol = target.col + TOWER_SIZE - 1;
  const rowDist = Math.max(0, target.row - fromRow, fromRow - lastTowerRow);
  const colDist = Math.max(0, target.col - fromCol, fromCol - lastTowerCol);
  const movingRow = stepRow !== 0;
  const nRowDist = Math.max(0, target.row - toRow, toRow - lastTowerRow);
  const nColDist = Math.max(0, target.col - toCol, toCol - lastTowerCol);
  const axisAway = movingRow ? nRowDist > rowDist : nColDist > colDist;
  const axisDistZero = movingRow ? rowDist === 0 : colDist === 0;
  return !axisAway || axisDistZero;
}

function canGruntMoveToCandidate(
  state: GameState,
  grunt: Grunt,
  row: number,
  col: number,
): boolean {
  if (findLivingTowerIndexAt(state, row, col) !== null) return false;
  if (hasGruntAt(state, row, col, grunt)) return false;
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

/** True if a nearby ally grunt (same target) is NOT yet adjacent to the tower — triggers slide behavior. */
function hasNonAdjacentBlockedAlly(state: GameState, grunt: Grunt): boolean {
  if (grunt.targetTowerIdx === undefined) return false;
  for (const other of state.grunts) {
    if (other === grunt) continue;
    if (other.targetTowerIdx !== grunt.targetTowerIdx) continue;
    if (
      isCardinalAdjacentToTower(
        state,
        other.row,
        other.col,
        grunt.targetTowerIdx,
      )
    )
      continue;
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
    if (!isCardinalAdjacentToTower(state, nr, nc, grunt.targetTowerIdx))
      continue;
    return { row: nr, col: nc };
  }
  return null;
}

export function isGruntPassableTile(
  state: GameState,
  row: number,
  col: number,
): boolean {
  return !isGruntBlocked(state, row, col) && !hasWallAt(state, row, col);
}

/** Check if a tile is blocked for grunt movement (impassable obstacle). */
export function isGruntBlocked(
  state: GameState,
  r: number,
  c: number,
): boolean {
  if (!inBounds(r, c)) return true;
  // Water tiles are passable when frozen
  if (!isGrass(state.map.tiles, r, c)) {
    if (!state.modern?.frozenTiles?.has(packTile(r, c))) return true;
  }
  if (hasCannonAt(state, r, c)) return true;
  if (hasAliveHouseAt(state, r, c)) return true;
  if (hasTowerAt(state, r, c)) return true;
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
