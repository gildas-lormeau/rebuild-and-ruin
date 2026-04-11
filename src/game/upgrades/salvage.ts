/**
 * Salvage upgrade — global effect. When ANY player picks Salvage, every
 * shooter who destroys an enemy cannon earns a salvage slot (cap 2) that
 * can be spent during the next cannon-place phase to place a bonus cannon.
 *
 * Hook implemented: onCannonKilled (awards slot to shooter).
 * Wired through src/game/upgrade-system.ts. State lives on
 * state.salvageSlots (indexed by player id).
 */

import type { ValidPlayerSlot } from "../../shared/player-slot.ts";
import type { GameState } from "../../shared/types.ts";
import { isGlobalUpgradeActive, UID } from "../../shared/upgrade-defs.ts";

/** Maximum banked salvage slots per player. Caps runaway snowball if a player
 *  keeps destroying enemy cannons in a single round. */
const SALVAGE_CAP = 2;

/** Award a salvage slot to the shooter that just killed an enemy cannon.
 *  No-op when Salvage is not globally active. Caps at SALVAGE_CAP. */
export function salvageOnCannonKilled(
  state: GameState,
  shooterId: ValidPlayerSlot,
): void {
  if (!isGlobalUpgradeActive(state.players, UID.SALVAGE)) return;
  state.salvageSlots[shooterId] = Math.min(
    (state.salvageSlots[shooterId] ?? 0) + 1,
    SALVAGE_CAP,
  );
}
