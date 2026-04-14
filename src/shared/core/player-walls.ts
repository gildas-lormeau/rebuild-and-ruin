import type { Player } from "./player-types.ts";

/** Batch-delete wall keys during a modifier (e.g. crumbling walls).
 *  Intentionally skips dirty-marking — modifier runs between phases. */
export function deletePlayerWallsBatch(
  player: Player,
  keys: readonly number[],
): void {
  const walls = player.walls as Set<number>;
  for (const key of keys) walls.delete(key);
}

/** Remove a wall tile from all players. Used during battle (grunt attacks)
 *  and by water/fire modifiers. */
export function removeWallFromAllPlayers(
  state: { readonly players: readonly Player[] },
  key: number,
): void {
  for (const player of state.players) deletePlayerWallBattle(player, key);
}

/** Delete a wall during battle. Intentionally skips dirty-marking — interior is
 *  stale during battle by design; recheckTerritory runs at the next phase start. */
export function deletePlayerWallBattle(player: Player, key: number): void {
  (player.walls as Set<number>).delete(key);
}
