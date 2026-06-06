/**
 * Canonical home for every `player.walls` mutation, in two contracts: build-phase
 * edits (add/clear/sweep) call `markWallsDirty` so interior is rechecked before
 * the next read; battle/modifier edits (delete*) intentionally SKIP dirty-marking
 * (interior is stale by design during battle, rechecked at the next phase start).
 * All routes go through the single `mutableWalls` cast; occupancy QUERIES
 * (has/iterate) stay in `board-occupancy.ts`.
 */

import type { TileKey } from "./grid.ts";
import { markWallsDirty } from "./player-interior.ts";
import type { Player } from "./player-types.ts";
import { countWallNeighbors, unpackTile } from "./spatial.ts";

/** Add a single wall tile and mark dirty. */
export function addPlayerWall(player: Player, key: TileKey): void {
  mutableWalls(player).add(key);
  markWallsDirty(player);
}

/** Batch-add wall keys and mark dirty once. Use instead of a loop of .add() calls.
 *  WARNING: Leaves interior stale. Caller MUST call recheckTerritory(state) before
 *  any code reads player.interior. Enforced at runtime by assertInteriorFresh(). */
export function addPlayerWalls(player: Player, keys: Iterable<TileKey>): void {
  const walls = mutableWalls(player);
  for (const key of keys) walls.add(key);
  markWallsDirty(player);
}

/** Clear all walls and mark dirty. Used when resetting a player's board state.
 *  WARNING: Leaves interior stale. Caller MUST call recheckTerritory(state) before
 *  any code reads player.interior. Enforced at runtime by assertInteriorFresh(). */
export function clearPlayerWalls(player: Player): void {
  mutableWalls(player).clear();
  markWallsDirty(player);
}

/** Remove isolated debris walls (≤1 orthogonal neighbor) and mark dirty.
 *  Used during wall sweep at build phase transitions.
 *  WARNING: Leaves interior stale. Caller MUST call recheckTerritory(state) before
 *  any code reads player.interior. Enforced at runtime by assertInteriorFresh(). */
export function sweepIsolatedWalls(player: Player): void {
  removeIsolatedWalls(mutableWalls(player));
  markWallsDirty(player);
}

/** Batch-delete wall keys during a modifier.
 *  Intentionally skips dirty-marking — modifier runs between phases. */
export function deletePlayerWallsBatch(
  player: Player,
  keys: readonly TileKey[],
): void {
  const walls = mutableWalls(player);
  for (const key of keys) walls.delete(key);
}

/** Remove a wall tile from all players. Used during battle (grunt attacks)
 *  and by water/fire modifiers. */
export function removeWallFromAllPlayers(
  state: { readonly players: readonly Player[] },
  key: TileKey,
): void {
  for (const player of state.players) deletePlayerWallBattle(player, key);
}

/** Delete a wall during battle. Intentionally skips dirty-marking — interior is
 *  stale during battle by design; recheckTerritory runs at the next phase start. */
export function deletePlayerWallBattle(player: Player, key: TileKey): void {
  mutableWalls(player).delete(key);
}

/** Cast ReadonlySet → Set for internal mutation. Only used by wall helpers in this file. */
function mutableWalls(player: Player): Set<TileKey> {
  return player.walls as Set<TileKey>;
}

/**
 * Sweep one layer of debris wall tiles (0 or 1 orthogonal neighbor).
 * Collects all isolated tiles first, then removes them in one batch.
 */
function removeIsolatedWalls(walls: Set<TileKey>): void {
  const toRemove: TileKey[] = [];
  for (const key of walls) {
    const { row, col } = unpackTile(key);
    if (countWallNeighbors(walls, row, col) <= 1) toRemove.push(key);
  }
  for (const key of toRemove) walls.delete(key);
}
