/**
 * Rapid Fire upgrade — cannonballs travel 1.5× normal speed.
 *
 * Hook implemented: ballSpeedMult (aggregator, interacts with cannon mode).
 * Wired through src/game/upgrade-system.ts.
 */

import type { Player } from "../../shared/player-types.ts";
import { UID } from "../../shared/upgrade-defs.ts";

/** True when this player owns the Rapid Fire upgrade. */
export function rapidFireOwns(player: Player): boolean {
  return !!player.upgrades.get(UID.RAPID_FIRE);
}
