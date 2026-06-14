/**
 * Grunt pathfinding, target locking, and grunt-tower adjacency queries.
 * Split from grunt-system.ts so the spatial logic is separate from
 * lifecycle (spawn, respawn, attack tracking); grunt-system imports the
 * shared adjacency helpers from here for its attack path.
 */

import type { Grunt } from "../shared/core/battle-types.ts";
import {
  findLivingTowerIndexAt,
  hasAliveHouseAt,
  hasGruntAt,
  hasInteriorAt,
  hasWallAt,
} from "../shared/core/board-occupancy.ts";
import {
  CATAPULT_TOWER_ATTACK_RANGE,
  MODIFIER_ID,
  TOWER_SIZE,
} from "../shared/core/game-constants.ts";
import type {
  TilePos,
  Tower,
  TowerIdx,
} from "../shared/core/geometry-types.ts";
import { hasCannonAt, hasTowerAt } from "../shared/core/occupancy-queries.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import {
  DIRS_4,
  distanceToTower,
  facingFromVector,
  hasPitAt,
  inBounds,
  isFloodedTile,
  isGrass,
  isTowerTile,
  manhattanDistance,
  packTile,
  zoneAt,
} from "../shared/core/spatial.ts";
import type { GameState } from "../shared/core/types.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";

/** Manhattan radius for checking if another grunt targeting the same tower is queued nearby. */
const GRUNT_BLOCKED_NEARBY_DISTANCE = 2;

/**
 * Tick grunt movement during the build phase (grunts are stationary in
 * battle — they only attack adjacent towers/walls there). Each grunt moves
 * 1 step toward the nearest enemy tower. When blocked by another grunt,
 * tries orthogonal moves to go around, producing natural encirclement of
 * towers. Returns true if any grunt moved (for animation purposes).
 *
 * INVARIANT: targets must be locked before movement. The two-pass order is:
 * 1. lockGruntTarget() for all grunts (assigns targetTowerIdx)
 * 2. Sort by distance, then move each grunt toward its locked target
 * These passes must not be interleaved — a grunt's target must not change mid-move.
 * Enforced by the single call site in this function; no external API exposes
 * lock+move separately.
 */
export function moveGrunts(state: GameState): boolean {
  // Frostbite: grunts spawn as immobile ice cubes for the entire battle.
  // Skip both target-lock and movement so they keep whatever facing they
  // were spawned with and never advance.
  if (state.modern?.activeModifier === MODIFIER_ID.FROSTBITE) return false;

  let anyMoved = false;
  const deadZones = getDeadZones(state);

  // Pass 1: Lock all targets before sorting — all mutation happens here, once per grunt
  for (const grunt of state.grunts) {
    lockGruntTarget(state, grunt, deadZones);
  }

  // Sort grunts by distance to their target (closest first) so they don't block each other
  const sorted = [...state.grunts].sort((a, b) => {
    const targetA = gruntTargetPos(state, a);
    const targetB = gruntTargetPos(state, b);
    const distanceA = targetA
      ? distanceToTower(targetA, a.row, a.col)
      : Infinity;
    const distanceB = targetB
      ? distanceToTower(targetB, b.row, b.col)
      : Infinity;
    return distanceA - distanceB;
  });

  for (const grunt of sorted) {
    if (moveOneGrunt(state, grunt)) anyMoved = true;
  }

  return anyMoved;
}

/** Zones owned by eliminated players — grunts must never target or attack their towers. */
export function getDeadZones(state: GameState): ReadonlySet<ZoneId> {
  const zones = new Set<ZoneId>();
  for (const player of state.players) {
    if (!isPlayerEliminated(player)) continue;
    const zone = state.playerZones[player.id];
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
 * Sets the pathing target (`grunt.targetTowerIdx`) used by `moveGrunts`.
 * Sticky across ticks once set, cleared only when the target's zone is
 * eliminated — the stickiness avoids cross-zone oscillation during
 * frozen-river crossings. `gruntAttackTowers` does NOT use this field;
 * it derives the attack target from the grunt's current zone every
 * tick (so a grunt stranded in another zone attacks adjacent towers
 * THERE, regardless of its sticky pathing goal).
 */
function lockGruntTarget(
  state: GameState,
  grunt: Grunt,
  deadZones: ReadonlySet<ZoneId>,
): void {
  // Drop stale target if it points at an eliminated player's zone
  if (grunt.targetTowerIdx !== undefined) {
    const targetZone = getGruntTargetTower(state, grunt)?.zone;
    if (targetZone !== undefined && deadZones.has(targetZone)) {
      grunt.targetTowerIdx = undefined;
    } else {
      return;
    }
  }

  const gruntZone = zoneAt(state.map, grunt.row, grunt.col);
  // Cross-zone targeting only opens when the river is fully traversable
  // (frozen_river). low_water exposes a thinned bank — the river is
  // still present, so grunts stay zone-locked.
  const crossZoneOpen = state.modern?.frozenTiles != null;

  let bestDist = Infinity;
  let bestIdx: TowerIdx | undefined;

  for (let i = 0; i < state.map.towers.length; i++) {
    const tower = state.map.towers[i]!;
    if (!state.towerAlive[i]) continue;
    if (deadZones.has(tower.zone)) continue;
    // River traversable: flee to enemy territory (skip own zone)
    // Normal: stay in own zone
    if (crossZoneOpen ? tower.zone === gruntZone : tower.zone !== gruntZone)
      continue;
    const dist = distanceToTower(tower, grunt.row, grunt.col);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i as TowerIdx;
    }
  }

  // Fallback: if cross-zone but no enemy tower alive, target same-zone
  if (crossZoneOpen && bestIdx === undefined) {
    for (let i = 0; i < state.map.towers.length; i++) {
      const tower = state.map.towers[i]!;
      if (!state.towerAlive[i]) continue;
      if (deadZones.has(tower.zone)) continue;
      if (tower.zone !== gruntZone) continue;
      const dist = distanceToTower(tower, grunt.row, grunt.col);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i as TowerIdx;
      }
    }
  }

  if (bestIdx === undefined) return;
  grunt.targetTowerIdx = bestIdx;
}

/** Move a single grunt toward its target. Returns true if it moved. */
function moveOneGrunt(state: GameState, grunt: Grunt): boolean {
  // Catapults move every other tick (half speed). slowSkip toggles each
  // call: when set, this tick is skipped and the flag is cleared; otherwise
  // the flag is set and movement proceeds.
  if (grunt.kind === "catapult") {
    if (grunt.slowSkip) {
      grunt.slowSkip = undefined;
      return false;
    }
    grunt.slowSkip = true;
  }
  // Already in attack range of alive target tower — stay put unless blocking a friend
  if (grunt.targetTowerIdx !== undefined) {
    const tower = getGruntTargetTower(state, grunt);
    if (tower && state.towerAlive[grunt.targetTowerIdx]!) {
      const inRange = isInTowerAttackRange(
        state,
        grunt.row,
        grunt.col,
        grunt.targetTowerIdx,
        grunt.kind,
      );
      if (inRange) {
        // Slide along the tower perimeter to make room for grunts behind us.
        // Only regular grunts slide — catapults are siege engines that hold
        // their range-2 position.
        if (
          grunt.kind !== "catapult" &&
          hasNonAdjacentBlockedAlly(state, grunt)
        ) {
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

/** Attack range from a tile to a tower, factoring in grunt kind.
 *  Catapults reach Manhattan distance ≤ CATAPULT_TOWER_ATTACK_RANGE (3 by
 *  default = 2-tile gap, bypasses up to two rows of cannons); regular grunts
 *  must be cardinally adjacent. */
export function isInTowerAttackRange(
  state: GameState,
  row: number,
  col: number,
  towerIndex: TowerIdx,
  kind: Grunt["kind"],
): boolean {
  if (!state.towerAlive[towerIndex]) return false;
  if (kind === "catapult") {
    const tower = state.map.towers[towerIndex]!;
    return distanceToTower(tower, row, col) <= CATAPULT_TOWER_ATTACK_RANGE;
  }
  return isAdjacentToLivingTower(state, row, col, towerIndex);
}

function isAdjacentToLivingTower(
  state: GameState,
  row: number,
  col: number,
  towerIndex: TowerIdx,
): boolean {
  const tower = state.map.towers[towerIndex]!;
  for (const [dr, dc] of DIRS_4) {
    if (isTowerTile(tower, row + dr, col + dc)) return true;
  }
  return false;
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

    // Skip impassable tiles (but towers are checked separately in moveGrunts)
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
  state: { readonly map: { readonly towers: readonly Tower[] } },
  grunt: Pick<Grunt, "targetTowerIdx">,
): Tower | null {
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
  if (hasGruntAt(state.grunts, row, col, grunt)) return false;
  if (hasInteriorAt(state, packTile(row, col))) return false;
  return true;
}

function applyGruntMove(grunt: Grunt, row: number, col: number): void {
  const dr = row - grunt.row;
  const dc = col - grunt.col;
  grunt.facing = facingFromVector(dc, dr);
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
    if (hasGruntAt(state.grunts, nr, nc, grunt)) continue;
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
function isGruntBlocked(state: GameState, r: number, c: number): boolean {
  if (!inBounds(r, c)) return true;
  // Water tiles are passable when frozen or exposed by low_water.
  if (!isGrass(state.map.tiles, r, c)) {
    const key = packTile(r, c);
    const passable =
      state.modern?.frozenTiles?.has(key) === true ||
      state.modern?.exposedRiverbedTiles?.has(key) === true;
    if (!passable) return true;
  }
  // High Tide: tile reads as grass but the visible water blocks movement
  // (the grunt would drown). Per-tile check so each pathfinding step pays
  // O(4 + |towers|) instead of materializing the whole flood set.
  if (
    state.modern?.activeModifier === MODIFIER_ID.HIGH_TIDE &&
    isFloodedTile(state.map, r, c)
  ) {
    return true;
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
  towerIndex: TowerIdx,
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
