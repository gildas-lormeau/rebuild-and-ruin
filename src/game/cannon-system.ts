/**
 * Cannon placement and management — validation, slot counting, placement.
 */

import {
  type Cannon,
  CannonMode,
  isBalloonMode,
  isSuperMode,
} from "../shared/battle-types.ts";
import {
  assertInteriorFresh,
  filterAliveOwnedTowers,
  getInterior,
  hasWallAt,
} from "../shared/board-occupancy.ts";
import {
  BALLOON_COST,
  MAX_CANNON_LIMIT_ON_RESELECT,
  STARTING_LIVES,
  SUPER_GUN_COST,
} from "../shared/game-constants.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import {
  isPlayerAlive,
  isPlayerSeated,
  type Player,
} from "../shared/player-types.ts";
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
} from "../shared/spatial.ts";
import type { GameState } from "../shared/types.ts";

/** Max search radius when snapping cannon placement to a valid tile. */
const CANNON_SNAP_RADIUS = 2;
/** Slot cost for a normal cannon. */
const NORMAL_CANNON_COST = 1;

/** Check whether all tiles of a cannon are inside enclosed territory.
 *
 *  FRESHNESS INVARIANT: `player.interior` must be recomputed via
 *  recheckTerritoryOnly() after any wall change. The required call order is:
 *    1. Place/destroy walls  (+ markWallsDirty)
 *    2. recheckTerritoryOnly()   — recomputes player.interior via flood fill
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
  const interior = getInterior(player);
  for (const key of interior) {
    const { r, c } = unpackTile(key);
    if (canPlaceCannon(player, r, c, mode, state)) return true;
  }
  return false;
}

/**
 * Find the nearest valid cannon placement within `maxRadius` tiles of (row, col).
 * Returns the snapped position, or undefined if nothing valid is nearby.
 */
export function findNearestValidCannonPlacement(
  player: Player,
  row: number,
  col: number,
  mode: CannonMode,
  state: GameState,
  maxRadius = CANNON_SNAP_RADIUS,
): { row: number; col: number } | undefined {
  let bestDist = Infinity;
  let best: { row: number; col: number } | undefined;
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

/** Auto-place normal cannons for round-1 if none were placed.
 *  Safety net — ensures every player starts with cannons even if they
 *  skipped placement. Picks evenly spaced valid interior positions. */
export function autoPlaceRound1Cannons(
  state: GameState,
  playerId: ValidPlayerSlot,
  maxSlots: number,
): void {
  if (state.round !== 1) return;
  const player = state.players[playerId];
  if (!isPlayerAlive(player) || player.cannons.length > 0) return;

  const interior = getInterior(player);
  const candidates: { row: number; col: number }[] = [];
  for (const key of interior) {
    const { r, c } = unpackTile(key);
    if (canPlaceCannon(player, r, c, CannonMode.NORMAL, state)) {
      candidates.push({ row: r, col: c });
    }
  }
  if (candidates.length === 0) return;

  // Evenly space placements across candidates for spread
  const needed = maxSlots - cannonSlotsUsed(player);
  const stride = Math.max(
    1,
    Math.floor(candidates.length / Math.max(1, needed)),
  );
  for (
    let i = 0;
    i < candidates.length && cannonSlotsUsed(player) < maxSlots;
    i += stride
  ) {
    const pos = candidates[i]!;
    placeCannon(player, pos.row, pos.col, maxSlots, CannonMode.NORMAL, state);
  }
  // Fill remaining slots from any skipped candidates
  for (
    let i = 0;
    i < candidates.length && cannonSlotsUsed(player) < maxSlots;
    i++
  ) {
    const pos = candidates[i]!;
    placeCannon(player, pos.row, pos.col, maxSlots, CannonMode.NORMAL, state);
  }
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
  if (player.eliminated) return false;
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
 *  PRECONDITION: player.interior must be freshly computed (via recheckTerritoryOnly)
 *  after any wall mutation. Stale interior is caught at runtime by
 *  assertInteriorFresh() inside isCannonEnclosed() — see cannon-system.ts:52. */
export function canPlaceCannon(
  player: Player,
  row: number,
  col: number,
  mode: CannonMode,
  state: GameState,
): boolean {
  const interior = getInterior(player);
  const size = cannonSize(mode);
  // Cannon footprints are square: cannonSize() returns width=height (1 for normal, 2 for balloon/super).
  for (let dr = 0; dr < size; dr++) {
    for (let dc = 0; dc < size; dc++) {
      const r = row + dr;
      const c = col + dc;
      if (!inBounds(r, c)) return false;
      const key = packTile(r, c);
      if (!interior.has(key)) return false;
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
  if (player.eliminated) return;
  player.cannons.push({
    row,
    col,
    hp: state.cannonMaxHp,
    mode,
    facing: player.defaultFacing,
  });
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
