/**
 * Salvage upgrade — global. When ANY player picks Salvage, every shooter
 * who destroys an enemy cannon earns a salvage slot (cap 2) spendable
 * next cannon-place phase to place a bonus cannon. State lives on
 * state.salvageSlots (indexed by player id).
 */

import type { ValidPlayerId } from "../../shared/core/player-slot.ts";
import type { GameState } from "../../shared/core/types.ts";
import { isGlobalUpgradeActive, UID } from "../../shared/core/upgrade-defs.ts";
import type { UpgradeImpl } from "./upgrade-types.ts";

/** Maximum banked salvage slots per player. Caps runaway snowball if a player
 *  keeps destroying enemy cannons in a single round. */
const SALVAGE_CAP = 2;
export const salvageImpl: UpgradeImpl = { onCannonKilled };

/** Award a salvage slot to the shooter that just killed an enemy cannon.
 *  No-op when Salvage is not globally active. Caps at SALVAGE_CAP. */
function onCannonKilled(state: GameState, shooterId: ValidPlayerId): void {
  if (!isGlobalUpgradeActive(state.players, UID.SALVAGE)) return;
  state.salvageSlots[shooterId] = Math.min(
    (state.salvageSlots[shooterId] ?? 0) + 1,
    SALVAGE_CAP,
  );
}
