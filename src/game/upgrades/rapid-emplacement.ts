/**
 * Rapid Emplacement upgrade — next special cannon costs 1 fewer slot.
 *
 * Query-style: callers check the discount before placement validation.
 * Consumed via the `onCannonPlaced` registry hook, but only when the
 * discount actually applied — standard cannons already cost 1 slot (the
 * floor), so placing one leaves the upgrade unspent, not silently burned.
 */

import { cannonModeDef } from "../../shared/core/cannon-mode-defs.ts";
import type { Player } from "../../shared/core/player-types.ts";
import type { UpgradeImpl } from "../../shared/core/types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";

export const rapidEmplacementImpl: UpgradeImpl = {
  onCannonPlaced(player, mode) {
    if (cannonModeDef(mode).slotCost > 1)
      player.upgrades.delete(UID.RAPID_EMPLACEMENT);
  },
};

/** Slot cost discount for the next special-cannon placement (1 if active). */
export function rapidEmplacementDiscount(player: Player): number {
  return player.upgrades.get(UID.RAPID_EMPLACEMENT) ? 1 : 0;
}
