/**
 * Supply Drop upgrade — grants +N cannon placement slots next cannon phase.
 *
 * Hook implemented: cannonSlotsBonus (aggregator, additive per player).
 * Wired through src/game/upgrade-system.ts.
 */

import type { Player } from "../../shared/core/player-types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";
import type { UpgradeImpl } from "./upgrade-types.ts";

/** Extra cannon slots granted by Supply Drop. */
const SUPPLY_DROP_BONUS = 2;
export const supplyDropImpl: UpgradeImpl = { cannonSlotsBonus };

/** Extra cannon slots granted by Supply Drop for this player. */
function cannonSlotsBonus(player: Player): number {
  return player.upgrades.get(UID.SUPPLY_DROP) ? SUPPLY_DROP_BONUS : 0;
}
