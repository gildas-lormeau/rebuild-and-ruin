import type { TileKey } from "./grid.ts";
import type { Player } from "./player-types.ts";

/** Batch-delete wall keys during a modifier.
 *  Intentionally skips dirty-marking — modifier runs between phases. */
export function deletePlayerWallsBatch(
  player: Player,
  keys: readonly number[],
): void {
  const walls = player.walls as Set<TileKey>;
  for (const key of keys) walls.delete(key as TileKey);
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
  (player.walls as Set<TileKey>).delete(key);
}
