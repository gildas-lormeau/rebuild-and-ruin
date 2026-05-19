/**
 * Entomb upgrade — walls can be placed over grunts, burying them.
 * Global: when any player owns Entomb, every player may overlap grunts
 * on placement and the covered grunts are removed (no respawn, no
 * score — a pure denial tool). Hooks: canPlaceOverGrunt (validation,
 * global) + onPiecePlaced (removal).
 */

import type { TileKey } from "../../shared/core/grid.ts";
import type { Player } from "../../shared/core/player-types.ts";
import { filterOffTiles } from "../../shared/core/spatial.ts";
import type { GameState, UpgradeImpl } from "../../shared/core/types.ts";
import { isGlobalUpgradeActive, UID } from "../../shared/core/upgrade-defs.ts";

export const entombImpl: UpgradeImpl = {
  canPlaceOverGrunt,
  onPiecePlaced,
};

/** Remove any grunts that now lie under the just-placed piece. No-op
 *  unless Entomb is active somewhere on the board. Mutates state.grunts. */
function onPiecePlaced(
  state: GameState,
  _player: Player,
  pieceKeys: ReadonlySet<TileKey>,
): void {
  if (!isGlobalUpgradeActive(state.players, UID.ENTOMB)) return;
  state.grunts = filterOffTiles(state.grunts, pieceKeys);
}

/** True when any alive player owns Entomb. Effect applies to every player. */
function canPlaceOverGrunt(players: readonly Player[]): boolean {
  return isGlobalUpgradeActive(players, UID.ENTOMB);
}
