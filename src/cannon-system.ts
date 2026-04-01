/**
 * Cannon placement and management — validation, slot counting, placement.
 */

import {
  assertInteriorFresh,
  filterAliveOwnedTowers,
  hasWallAt,
} from "./board-occupancy.ts";
import {
  BALLOON_COST,
  MAX_CANNON_LIMIT_ON_RESELECT,
  STARTING_LIVES,
  SUPER_GUN_COST,
} from "./game-constants.ts";
import {
  cannonSize,
  FACING_90_STEP,
  hasPitAt,
  inBounds,
  isBalloonCannon,
  isCannonAlive,
  isCannonTile,
  isTowerTile,
  packTile,
  snapAngle,
  towerCenter,
  unpackTile,
} from "./spatial.ts";
import type { Cannon, GameState, Player } from "./types.ts";
import {
  CannonMode,
  isBalloonMode,
  isPlayerSeated,
  isSuperMode,
} from "./types.ts";

/** Max search radius when snapping cannon placement to a valid tile. */
const CANNON_SNAP_RADIUS = 2;
/** Slot cost for a normal cannon. */
const NORMAL_CANNON_COST = 1;

/** Check whether all tiles of a cannon are inside enclosed territory.
 *
 *  FRESHNESS INVARIANT: `player.interior` must be recomputed via
 *  recheckTerritory() after any wall change. The required call order is:
 *    1. Place/destroy walls  (+ markWallsDirty)
 *    2. recheckTerritory()   — recomputes player.interior via flood fill
 *    3. isCannonEnclosed()   — reads the freshly computed interior
 *  Skipping step 2 is caught by assertInteriorFresh() at runtime when
 *  epoch tracking is active (all production code paths call markWallsDirty). */
export function isCannonEnclosed(
  cannon: Cannon,
  player: Pick<Player, "id" | "interior">,
): boolean {
  assertInteriorFresh(player as Player);
  const { interior } = player;
  const sz = cannonSize(cannon.mode);
  for (let dr = 0; dr < sz; dr++) {
    for (let dc = 0; dc < sz; dc++) {
      if (!interior.has(packTile(cannon.row + dr, cannon.col + dc)))
        return false;
    }
  }
  return true;
}

/** Whether any valid placement exists for the given cannon mode in the player's territory. */
export function hasAnyCannonPlacement(
  player: Player,
  mode: CannonMode,
  state: GameState,
): boolean {
  for (const key of player.interior) {
    const { r, c } = unpackTile(key);
    if (canPlaceCannon(player, r, c, mode, state)) return true;
  }
  return false;
}

/**
 * Find the nearest valid cannon placement within `maxRadius` tiles of (row, col).
 * Returns the snapped position, or null if nothing valid is nearby.
 */
export function findNearestValidCannonPlacement(
  player: Player,
  row: number,
  col: number,
  mode: CannonMode,
  state: GameState,
  maxRadius = CANNON_SNAP_RADIUS,
): { row: number; col: number } | null {
  let bestDist = Infinity;
  let best: { row: number; col: number } | null = null;
  for (let dr = -maxRadius; dr <= maxRadius; dr++) {
    for (let dc = -maxRadius; dc <= maxRadius; dc++) {
      if (dr === 0 && dc === 0) continue;
      const dist = dr * dr + dc * dc;
      if (dist >= bestDist) continue;
      if (canPlaceCannon(player, row + dr, col + dc, mode, state)) {
        bestDist = dist;
        best = { row: row + dr, col: col + dc };
      }
    }
  }
  return best;
}

/** Validate + apply cannon placement. Returns true if placed. */
export function placeCannon(
  player: Player,
  row: number,
  col: number,
  maxCannons: number,
  mode: CannonMode,
  state: GameState,
): boolean {
  const used = cannonSlotsUsed(player);
  const cost = cannonSlotCost(mode);
  if (used + cost > maxCannons) return false;
  if (!canPlaceCannon(player, row, col, mode, state)) return false;
  applyCannonPlacement(player, row, col, mode, state);
  return true;
}

/** Validate cannon placement on the grid.
 *  Checks: interior (enclosed territory), walls, owned towers (not ALL), cannons, burning pits.
 *  Does NOT check grass or playerZone — cannon placement requires enclosed territory.
 *  Contrast with canPlacePieceOffsets() in build-system.ts which checks grass + zone + all towers.
 *
 *  All tiles must be interior, not a wall, not a tower, not an existing cannon.
 *  PRECONDITION: player.interior must be freshly computed (via recheckTerritory)
 *  after any wall mutation. Stale interior is caught at runtime by
 *  assertInteriorFresh() inside isCannonEnclosed() — see cannon-system.ts:52. */
export function canPlaceCannon(
  player: Player,
  row: number,
  col: number,
  mode: CannonMode,
  state: GameState,
): boolean {
  const size = cannonSize(mode);
  for (let dr = 0; dr < size; dr++) {
    for (let dc = 0; dc < size; dc++) {
      const r = row + dr;
      const c = col + dc;
      if (!inBounds(r, c)) return false;
      const key = packTile(r, c);
      if (!player.interior.has(key)) return false;
      if (hasWallAt(state, r, c)) return false;
      if (overlapsOwnedTower(player.ownedTowers, r, c)) return false;
      if (overlapsExistingCannon(player.cannons, r, c)) return false;
      if (hasPitAt(state.burningPits, r, c)) return false;
    }
  }
  return true;
}

/** Apply cannon placement (no validation). Used by host and watcher. */
export function applyCannonPlacement(
  player: Player,
  row: number,
  col: number,
  mode: CannonMode,
  state: GameState,
): void {
  player.cannons.push({
    row,
    col,
    hp: state.cannonMaxHp,
    mode,
    facing: player.defaultFacing,
  });
}

/**
 * Compute the total cannon slot limit for a player this round.
 * Three paths: reselection (fixed budget based on lives lost),
 * round 1 (firstRoundCannons), or normal (tower-based: 2 for home + 1 per other).
 */
export function cannonSlotsForRound(player: Player, state: GameState): number {
  const existingSlots = cannonSlotsUsed(player);
  let newSlots: number;
  if (state.reselectedPlayers.has(player.id)) {
    // Reselection: compensate for lives lost, capped at MAX_CANNON_LIMIT_ON_RESELECT
    newSlots = Math.min(
      state.firstRoundCannons + (STARTING_LIVES - player.lives),
      MAX_CANNON_LIMIT_ON_RESELECT,
    );
  } else if (state.round === 1) {
    newSlots = state.firstRoundCannons;
  } else {
    const aliveTowers = filterAliveOwnedTowers(player, state);
    const ownsHome =
      player.homeTower &&
      aliveTowers.some((tower) => tower === player.homeTower);
    const otherCount = aliveTowers.length - (ownsHome ? 1 : 0);
    newSlots = (ownsHome ? 2 : 0) + otherCount;
  }
  return existingSlots + newSlots;
}

/** Count how many cannon slots are used by a player. Normal = 1, super = SUPER_GUN_COST, balloon = BALLOON_COST. */
export function cannonSlotsUsed(player: Player): number {
  let slots = 0;
  for (const cannon of player.cannons) {
    if (!isCannonAlive(cannon)) continue;
    slots += cannonSlotCost(cannon.mode);
  }
  return slots;
}

/**
 * Reset cannon facings to point toward the average enemy position.
 * Convenience wrapper: computes defaultFacing + applies to all cannons.
 * Call at the start of the build phase and in online checkpoints.
 */
export function resetCannonFacings(state: GameState): void {
  computeDefaultFacings(state);
  applyDefaultFacings(state);
}

/**
 * Compute each player's defaultFacing toward the average enemy position.
 * Does NOT update existing cannon facings — call resetCannonFacings or
 * applyDefaultFacings for that.  Separated so that new cannons placed by
 * AI controllers pick up the right defaultFacing before the banner
 * captures old cannon facings for the old-scene overlay.
 */
export function computeDefaultFacings(state: GameState): void {
  for (const player of state.players) {
    if (!isPlayerSeated(player)) continue;
    const pc = towerCenter(player.homeTower);
    let ex = 0,
      ey = 0,
      count = 0;
    for (const other of state.players) {
      if (other.id === player.id || !isPlayerSeated(other)) continue;
      const oc = towerCenter(other.homeTower);
      ex += oc.col;
      ey += oc.row;
      count++;
    }
    if (count > 0) {
      const avgEx = ex / count;
      const avgEy = ey / count;
      const dx = avgEx - pc.col;
      const dy = avgEy - pc.row;
      player.defaultFacing = snapAngle(Math.atan2(dx, -dy), FACING_90_STEP);
    } else {
      player.defaultFacing = 0;
    }
  }
}

/** Apply each player's defaultFacing to all their existing cannons. */
export function applyDefaultFacings(state: GameState): void {
  for (const player of state.players) {
    if (!isPlayerSeated(player)) continue;
    for (const cannon of player.cannons) {
      cannon.facing = player.defaultFacing;
    }
  }
}

/** Return a player's alive cannons that can fire (excludes balloons and dead cannons). */
export function filterActiveFiringCannons(player: Player): Cannon[] {
  return player.cannons.filter((c) => isCannonAlive(c) && !isBalloonCannon(c));
}

export function cannonSlotCost(mode: CannonMode): number {
  if (isBalloonMode(mode)) return BALLOON_COST;
  if (isSuperMode(mode)) return SUPER_GUN_COST;
  return NORMAL_CANNON_COST;
}

function overlapsExistingCannon(
  cannons: readonly Cannon[],
  row: number,
  col: number,
): boolean {
  return cannons.some((cannon) => isCannonTile(cannon, row, col));
}

function overlapsOwnedTower(
  ownedTowers: readonly Player["ownedTowers"][number][],
  row: number,
  col: number,
): boolean {
  return ownedTowers.some((tower) => isTowerTile(tower, row, col));
}
