import type { UpgradeImpl } from "../../shared/core/types.ts";

/** Rapid Fire hooks are wired directly through the ballSpeedMult dispatcher
 *  (cross-upgrade interaction with Mortar), not through the registry. */
export const rapidFireImpl: UpgradeImpl = {};
