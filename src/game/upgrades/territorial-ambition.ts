/**
 * Territorial Ambition upgrade — double the end-of-build territory score.
 *
 * Hook implemented: territoryScoreMult (aggregator, multiplicative).
 * Wired through src/game/upgrade-system.ts.
 */

import type { Player } from "../../shared/core/player-types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";
import type { UpgradeImpl } from "./upgrade-types.ts";

export const territorialAmbitionImpl: UpgradeImpl = { territoryScoreMult };

/** Territory score multiplier contributed by Territorial Ambition. */
function territoryScoreMult(player: Player): number {
  return player.upgrades.get(UID.TERRITORIAL_AMBITION) ? 2 : 1;
}
