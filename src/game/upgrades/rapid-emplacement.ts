/**
 * Rapid Emplacement upgrade — next cannon placed costs 1 fewer slot (min 1).
 *
 * Query-style: callers check the discount before placement validation.
 * Consumed after one successful cannon placement.
 */

import type { Player } from "../../shared/core/player-types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";
import type { UpgradeImpl } from "./upgrade-types.ts";

/** Rapid Emplacement is wired directly through cannon-system.ts (slot
 *  cost discount + consume), not through the registry dispatch. */
export const rapidEmplacementImpl: UpgradeImpl = {};

/** Slot cost discount for the next cannon placement (1 if upgrade active, else 0). */
export function rapidEmplacementDiscount(player: Player): number {
  return player.upgrades.get(UID.RAPID_EMPLACEMENT) ? 1 : 0;
}

/** Consume the upgrade after a successful cannon placement. No-op if not owned. */
export function consumeRapidEmplacement(player: Player): void {
  player.upgrades.delete(UID.RAPID_EMPLACEMENT);
}
