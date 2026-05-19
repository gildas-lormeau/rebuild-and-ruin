/**
 * Foundations upgrade — pieces can be placed over burning pits, and the
 * placement extinguishes those pits as a side effect (turning a hazard
 * into opportunity space). Hooks: canPlaceOverBurningPit (validation)
 * and onPiecePlaced (pit clearing).
 */

import type { TileKey } from "../../shared/core/grid.ts";
import type { Player } from "../../shared/core/player-types.ts";
import { filterOffTiles } from "../../shared/core/spatial.ts";
import type { GameState, UpgradeImpl } from "../../shared/core/types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";

export const foundationsImpl: UpgradeImpl = {
  canPlaceOverBurningPit,
  onPiecePlaced,
};

/** Extinguish any burning pits that now lie under the just-placed piece.
 *  No-op when the player doesn't own Foundations. Mutates state.burningPits. */
function onPiecePlaced(
  state: GameState,
  player: Player,
  pieceKeys: ReadonlySet<TileKey>,
): void {
  if (!canPlaceOverBurningPit(player)) return;
  state.burningPits = filterOffTiles(state.burningPits, pieceKeys);
}

/** True when this player owns Foundations and can place pieces on burning pits. */
function canPlaceOverBurningPit(player: Player): boolean {
  return !!player.upgrades.get(UID.FOUNDATIONS);
}
