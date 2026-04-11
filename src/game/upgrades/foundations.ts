/**
 * Foundations upgrade — pieces can be placed over burning pits, and the
 * placement extinguishes those pits as a side effect. Converts a hazard
 * into opportunity space.
 *
 * Hooks implemented:
 *   - canPlaceOverBurningPit (piece-validation query)
 *   - onPiecePlaced          (post-placement pit clearing)
 *
 * Wired through src/game/upgrade-system.ts.
 */

import type { Player } from "../../shared/player-types.ts";
import { packTile } from "../../shared/spatial.ts";
import type { GameState } from "../../shared/types.ts";
import { UID } from "../../shared/upgrade-defs.ts";

/** Extinguish any burning pits that now lie under the just-placed piece.
 *  No-op when the player doesn't own Foundations. Mutates state.burningPits. */
export function foundationsExtinguishOnPlace(
  state: GameState,
  player: Player,
  pieceKeys: ReadonlySet<number>,
): void {
  if (!foundationsIgnoresPits(player)) return;
  state.burningPits = state.burningPits.filter(
    (pit) => !pieceKeys.has(packTile(pit.row, pit.col)),
  );
}

/** True when this player owns Foundations and can place pieces on burning pits. */
export function foundationsIgnoresPits(player: Player): boolean {
  return !!player.upgrades.get(UID.FOUNDATIONS);
}
