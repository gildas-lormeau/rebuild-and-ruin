/**
 * Clear the Field upgrade — wipes every grunt currently on the board.
 * Global, idempotent effect fired at pick time.
 *
 * Hook implemented: onPick (per-entry side effect).
 * Wired through src/game/upgrade-system.ts.
 */

import type { GameState } from "../../shared/core/types.ts";
import type { UpgradeImpl } from "./upgrade-types.ts";

export const clearTheFieldImpl: UpgradeImpl = { onPick };

/** Wipe all grunts. Safe to call multiple times in the same batch. */
function onPick(state: GameState): void {
  state.grunts.length = 0;
}
