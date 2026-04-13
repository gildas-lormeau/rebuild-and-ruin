/**
 * Second Wind upgrade — revives every dead tower in the game and clears
 * pending-revive markers. Global, idempotent effect fired at pick time.
 *
 * Hook implemented: onPick (per-entry side effect).
 * Wired through src/game/upgrade-system.ts.
 */

import type { GameState } from "../../shared/core/types.ts";
import type { UpgradeImpl } from "./upgrade-types.ts";

export const secondWindImpl: UpgradeImpl = { onPick };

/** Revive all towers and clear the pending-revive set. Safe to call
 *  multiple times in the same batch (idempotent). */
function onPick(state: GameState): void {
  for (let idx = 0; idx < state.towerAlive.length; idx++) {
    state.towerAlive[idx] = true;
  }
  state.towerPendingRevive.clear();
}
