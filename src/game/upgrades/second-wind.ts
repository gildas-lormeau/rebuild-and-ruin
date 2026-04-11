/**
 * Second Wind upgrade — revives every dead tower in the game and clears
 * pending-revive markers. Global, idempotent effect fired at pick time.
 *
 * Hook implemented: onPickApplied (per-entry side effect).
 * Wired through src/game/upgrade-system.ts.
 */

import type { GameState } from "../../shared/core/types.ts";
import { UID, type UpgradeId } from "../../shared/core/upgrade-defs.ts";

/** Revive all towers and clear the pending-revive set when the picked
 *  upgrade is Second Wind. No-op for any other upgrade. Safe to call
 *  multiple times in the same batch (idempotent). */
export function secondWindOnPick(state: GameState, choice: UpgradeId): void {
  if (choice !== UID.SECOND_WIND) return;
  for (let idx = 0; idx < state.towerAlive.length; idx++) {
    state.towerAlive[idx] = true;
  }
  state.towerPendingRevive.clear();
}
