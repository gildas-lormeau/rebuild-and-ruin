/**
 * Rapid Fire upgrade — cannonballs travel 1.5× normal speed.
 *
 * Hook implemented: ballSpeedMult (aggregator, interacts with cannon mode).
 * Wired directly in src/game/upgrade-system.ts (cross-upgrade interaction
 * with Mortar doesn't fit the registry pattern).
 */

import type { UpgradeImpl } from "./upgrade-types.ts";

/** Rapid Fire hooks are wired directly through the ballSpeedMult dispatcher
 *  (cross-upgrade interaction with Mortar), not through the registry. */
export const rapidFireImpl: UpgradeImpl = {};
