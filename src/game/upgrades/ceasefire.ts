/**
 * Ceasefire upgrade — the current round's battle phase is skipped entirely.
 *
 * Hook implemented: shouldSkipBattle (aggregator, boolean OR, global).
 * Wired through src/game/upgrade-system.ts.
 */

import type { GameState } from "../../shared/types.ts";
import { isGlobalUpgradeActive, UID } from "../../shared/upgrade-defs.ts";

/** True when any player owns Ceasefire — triggers battle-skip for this round. */
export function ceasefireShouldSkipBattle(state: GameState): boolean {
  return isGlobalUpgradeActive(state.players, UID.CEASEFIRE);
}
