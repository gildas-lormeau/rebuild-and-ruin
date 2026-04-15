/**
 * Rubble Clearing modifier — removes all dead cannon debris and burning pits.
 */

import { isPlayerEliminated } from "../../shared/core/player-types.ts";
import {
  cannonSize,
  isCannonAlive,
  packTile,
} from "../../shared/core/spatial.ts";
import type { GameState } from "../../shared/core/types.ts";
import type { ModifierImpl } from "./modifier-types.ts";

export const rubbleClearingImpl: ModifierImpl = {
  apply: (state: GameState) => ({
    changedTiles: applyRubbleClearing(state),
    gruntsSpawned: 0,
  }),
  // Removes dead cannons + burning pits — neither affects walls or interior.
  skipsRecheck: true,
};

/** Apply rubble clearing: remove all dead cannon debris and burning pits.
 *  Returns the tile keys of cleared positions for the reveal banner. */
function applyRubbleClearing(state: GameState): readonly number[] {
  const cleared: number[] = [];
  // Collect dead cannon tile positions before removal
  for (const player of state.players) {
    if (isPlayerEliminated(player)) continue;
    for (const cannon of player.cannons) {
      if (isCannonAlive(cannon)) continue;
      const sz = cannonSize(cannon.mode);
      for (let dr = 0; dr < sz; dr++) {
        for (let dc = 0; dc < sz; dc++) {
          cleared.push(packTile(cannon.row + dr, cannon.col + dc));
        }
      }
    }
    player.cannons = player.cannons.filter(isCannonAlive);
  }
  // Collect burning pit positions before removal
  for (const pit of state.burningPits) {
    cleared.push(packTile(pit.row, pit.col));
  }
  state.burningPits.length = 0;
  return cleared;
}
