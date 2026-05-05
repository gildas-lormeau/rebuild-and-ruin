/**
 * Rapid Emplacement upgrade — next cannon placed costs 1 fewer slot (min 1).
 *
 * Query-style: callers check the discount before placement validation.
 * Consumed via the `onCannonPlaced` registry hook after a successful placement.
 */

import type { Player } from "../../shared/core/player-types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";
import type { UpgradeImpl } from "./upgrade-types.ts";

export const rapidEmplacementImpl: UpgradeImpl = {
  onCannonPlaced(player) {
    player.upgrades.delete(UID.RAPID_EMPLACEMENT);
  },
};

/** Slot cost discount for the next cannon placement (1 if upgrade active, else 0). */
export function rapidEmplacementDiscount(player: Player): number {
  return player.upgrades.get(UID.RAPID_EMPLACEMENT) ? 1 : 0;
}
