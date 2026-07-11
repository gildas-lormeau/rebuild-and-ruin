/**
 * Territorial Ambition upgrade — +50% end-of-build territory score.
 *
 * Hook implemented: territoryScoreMult (aggregator, multiplicative).
 * Wired through src/game/upgrade-system.ts.
 */

import type { Player } from "../../shared/core/player-types.ts";
import type { UpgradeImpl } from "../../shared/core/types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";

export const territorialAmbitionImpl: UpgradeImpl = { territoryScoreMult };

/** Territory score multiplier contributed by Territorial Ambition. */
function territoryScoreMult(player: Player): number {
  return player.upgrades.get(UID.TERRITORIAL_AMBITION) ? 1.5 : 1;
}
