/**
 * Ceasefire upgrade — the current round's battle phase is skipped entirely.
 *
 * Hook implemented: shouldSkipBattle (aggregator, boolean OR, global).
 * Wired through src/game/upgrade-system.ts.
 */

import type { GameState, UpgradeImpl } from "../../shared/core/types.ts";
import { isGlobalUpgradeActive, UID } from "../../shared/core/upgrade-defs.ts";

export const ceasefireImpl: UpgradeImpl = { shouldSkipBattle };

/** True when any player owns Ceasefire — triggers battle-skip for this round. */
function shouldSkipBattle(state: GameState): boolean {
  return isGlobalUpgradeActive(state.players, UID.CEASEFIRE);
}
