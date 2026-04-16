/**
 * Entomb upgrade — walls can be placed over grunts, burying them.
 * Global: when any player owns Entomb, every player may overlap grunts
 * on piece placement, and the covered grunts are removed (no respawn,
 * no score — a pure denial tool).
 *
 * Hooks implemented:
 *   - canPlaceOverGrunt (piece-validation query, global)
 *   - onPiecePlaced     (post-placement grunt removal)
 *
 * Wired through src/game/upgrade-system.ts.
 */

import type { Player } from "../../shared/core/player-types.ts";
import { packTile } from "../../shared/core/spatial.ts";
import type { GameState } from "../../shared/core/types.ts";
import { isGlobalUpgradeActive, UID } from "../../shared/core/upgrade-defs.ts";
import type { UpgradeImpl } from "./upgrade-types.ts";

export const entombImpl: UpgradeImpl = {
  canPlaceOverGrunt,
  onPiecePlaced,
};

/** Remove any grunts that now lie under the just-placed piece. No-op
 *  unless Entomb is active somewhere on the board. Mutates state.grunts. */
function onPiecePlaced(
  state: GameState,
  _player: Player,
  pieceKeys: ReadonlySet<number>,
): void {
  if (!isGlobalUpgradeActive(state.players, UID.ENTOMB)) return;
  state.grunts = state.grunts.filter(
    (grunt) => !pieceKeys.has(packTile(grunt.row, grunt.col)),
  );
}

/** True when any alive player owns Entomb. Effect applies to every player. */
function canPlaceOverGrunt(players: readonly Player[]): boolean {
  return isGlobalUpgradeActive(players, UID.ENTOMB);
}
