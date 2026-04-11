/**
 * Rapid Fire upgrade — cannonballs travel 1.5× normal speed.
 *
 * Hook implemented: ballSpeedMult (aggregator, interacts with cannon mode).
 * Wired through src/game/upgrade-system.ts.
 */

import type { Player } from "../../shared/core/player-types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";

/** Cannonball speed multiplier when Rapid Fire is active.
 *  Cancels out with Mortar's slowdown by design — see ballSpeedMult dispatcher. */
const RAPID_FIRE_SPEED_MULT = 1.5;

/** Ball speed multiplier contributed by Rapid Fire (1 if not owned). */
export function rapidFireBallMult(player: Player): number {
  return rapidFireOwns(player) ? RAPID_FIRE_SPEED_MULT : 1;
}

/** True when this player owns the Rapid Fire upgrade. */
export function rapidFireOwns(player: Player): boolean {
  return !!player.upgrades.get(UID.RAPID_FIRE);
}
