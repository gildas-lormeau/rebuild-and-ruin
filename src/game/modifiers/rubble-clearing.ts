/**
 * Rubble Clearing modifier — removes all dead cannon debris and burning pits.
 *
 * Captures a pre-removal snapshot of the affected entities into
 * `state.modern.rubbleClearingHeld` before mutating, so the renderer can
 * fade them out post-banner via the runtime-derived
 * `overlay.battle.rubbleClearingFade` multiplier.
 */

import type { CannonMode } from "../../shared/core/battle-types.ts";
import type { ValidPlayerSlot } from "../../shared/core/player-slot.ts";
import {
  cannonTier,
  isPlayerEliminated,
} from "../../shared/core/player-types.ts";
import {
  cannonSize,
  isCannonAlive,
  packTile,
} from "../../shared/core/spatial.ts";
import type { GameState } from "../../shared/core/types.ts";
import type { ModifierImpl } from "./modifier-types.ts";

export const rubbleClearingImpl: ModifierImpl = {
  lifecycle: "instant",
  apply: (state: GameState) => ({
    changedTiles: applyRubbleClearing(state),
    gruntsSpawned: 0,
  }),
  // Removes dead cannons + burning pits — neither affects walls or interior.
  skipsRecheck: true,
};

/** Apply rubble clearing: snapshot the entities being removed (for the
 *  renderer's post-banner fade), then remove them. Returns the tile keys
 *  of cleared positions for the reveal banner. */
function applyRubbleClearing(state: GameState): readonly number[] {
  const cleared: number[] = [];
  const heldDeadCannons: {
    ownerId: ValidPlayerSlot;
    col: number;
    row: number;
    mode: CannonMode;
    mortar?: boolean;
    tier: 1 | 2 | 3;
  }[] = [];
  for (const player of state.players) {
    if (isPlayerEliminated(player)) continue;
    const tier = cannonTier(player);
    for (const cannon of player.cannons) {
      if (isCannonAlive(cannon)) continue;
      heldDeadCannons.push({
        ownerId: player.id,
        col: cannon.col,
        row: cannon.row,
        mode: cannon.mode,
        mortar: cannon.mortar,
        tier,
      });
      const sz = cannonSize(cannon.mode);
      for (let dr = 0; dr < sz; dr++) {
        for (let dc = 0; dc < sz; dc++) {
          cleared.push(packTile(cannon.row + dr, cannon.col + dc));
        }
      }
    }
    player.cannons = player.cannons.filter(isCannonAlive);
  }
  const heldPits = state.burningPits.map((pit) => ({ ...pit }));
  for (const pit of state.burningPits) {
    cleared.push(packTile(pit.row, pit.col));
  }
  state.burningPits.length = 0;

  if (state.modern && (heldDeadCannons.length > 0 || heldPits.length > 0)) {
    state.modern.rubbleClearingHeld = {
      pits: heldPits,
      deadCannons: heldDeadCannons,
    };
  }
  return cleared;
}
