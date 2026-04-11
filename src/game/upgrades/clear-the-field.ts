/**
 * Clear the Field upgrade — wipes every grunt currently on the board.
 * Global, idempotent effect fired at pick time.
 *
 * Hook implemented: onPickApplied (per-entry side effect).
 * Wired through src/game/upgrade-system.ts.
 */

import type { GameState } from "../../shared/core/types.ts";
import { UID, type UpgradeId } from "../../shared/core/upgrade-defs.ts";

/** Wipe all grunts when the picked upgrade is Clear the Field. No-op for
 *  any other upgrade. Safe to call multiple times in the same batch. */
export function clearTheFieldOnPick(state: GameState, choice: UpgradeId): void {
  if (choice !== UID.CLEAR_THE_FIELD) return;
  state.grunts.length = 0;
}
