/**
 * Cannon placement and management — validation, slot counting, placement.
 */

import {
  forEachCannonTile,
  inBounds,
  isCannonAlive,
  isCannonTile,
  isPitAt,
  isTowerTile,
  packTile,
  unpackTile,
} from "./spatial.ts";
import type { Cannon, GameState, Player } from "./types.ts";
import {
  BALLOON_COST,
  BALLOON_SIZE,
  CannonMode,
  NORMAL_CANNON_SIZE,
  SUPER_GUN_COST,
  SUPER_GUN_SIZE,
} from "./types.ts";

/** Check whether all tiles of a cannon are inside enclosed territory. */
export function isCannonEnclosed(
  cannon: Cannon,
  interior: Set<number>,
): boolean {
  let enclosed = true;
  forEachCannonTile(cannon, (_r, _c, key) => {
    if (!interior.has(key)) enclosed = false;
  });
  return enclosed;
}

/** Whether any valid placement exists for the given cannon mode in the player's territory. */
export function hasAnyCannonPlacement(player: Player, mode: CannonMode, state: GameState): boolean {
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
  player: Player, row: number, col: number,
  mode: CannonMode, state: GameState, maxRadius = 2,
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
  mode: CannonMode | undefined,
  state: GameState,
): boolean {
  const normalizedMode = mode ?? CannonMode.NORMAL;
  const used = cannonSlotsUsed(player);
  const cost = cannonSlotCost({
    super: normalizedMode === CannonMode.SUPER ? true : undefined,
    balloon: normalizedMode === CannonMode.BALLOON ? true : undefined,
  });
  if (used + cost > maxCannons) return false;
  if (!canPlaceCannon(player, row, col, normalizedMode, state)) return false;
  applyCannonPlacement(player, row, col, normalizedMode, state);
  return true;
}

/**
 * Check if a cannon can be placed at (row, col) inside the player's territory.
 * All tiles must be interior, not a wall, not a tower, not an existing cannon.
 */
export function canPlaceCannon(
  player: Player,
  row: number,
  col: number,
  mode: CannonMode,
  state: GameState,
): boolean {
  const size =
    mode === CannonMode.SUPER
      ? SUPER_GUN_SIZE
      : mode === CannonMode.BALLOON
        ? BALLOON_SIZE
        : NORMAL_CANNON_SIZE;
  for (let dr = 0; dr < size; dr++) {
    for (let dc = 0; dc < size; dc++) {
      const r = row + dr;
      const c = col + dc;
      if (!inBounds(r, c)) return false;
      const key = packTile(r, c);
      if (!player.interior.has(key)) return false;
      if (player.walls.has(key)) return false;
      if (overlapsOwnedTower(player.ownedTowers, r, c)) return false;
      if (overlapsExistingCannon(player.cannons, r, c)) return false;
      if (isPitAt(state.burningPits, r, c)) return false;
    }
  }
  return true;
}

/** Count how many cannon slots are used by a player. Normal = 1, super = SUPER_GUN_COST, balloon = BALLOON_COST. */
export function cannonSlotsUsed(player: Player): number {
  let slots = 0;
  for (const cannon of player.cannons) {
    if (!isCannonAlive(cannon)) continue;
    slots += cannonSlotCost(cannon);
  }
  return slots;
}

/** Apply cannon placement (no validation). Used by host and watcher. */
export function applyCannonPlacement(
  player: Player,
  row: number,
  col: number,
  mode: CannonMode | undefined,
  state: GameState,
): void {
  const isSuper = mode === CannonMode.SUPER;
  const isBalloon = mode === CannonMode.BALLOON;
  player.cannons.push({
    row,
    col,
    hp: state.cannonMaxHp,
    super: isSuper ? true : undefined,
    balloon: isBalloon ? true : undefined,
    facing: player.defaultFacing,
  });
}

function cannonSlotCost(cannon: Pick<Cannon, "super" | "balloon">): number {
  if (cannon.balloon) return BALLOON_COST;
  if (cannon.super) return SUPER_GUN_COST;
  return 1;
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
