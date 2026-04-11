/**
 * Double Time upgrade — +10s build phase timer for all players.
 *
 * Hook implemented: buildTimerBonus (aggregator, additive, global).
 * Wired through src/game/upgrade-system.ts.
 */

import { FID } from "../../shared/core/feature-defs.ts";
import { type GameState, hasFeature } from "../../shared/core/types.ts";
import { isGlobalUpgradeActive, UID } from "../../shared/core/upgrade-defs.ts";

/** Extra build seconds granted by Double Time (global — applies to every
 *  player when any single owner picks it). Internal: callers go through
 *  the dispatcher. */
const DOUBLE_TIME_BONUS_SECONDS = 10;

/** Build timer bonus contributed by Double Time — global: any owner grants
 *  the bonus to every player's build phase. */
export function doubleTimeBuildTimerBonus(state: GameState): number {
  if (!hasFeature(state, FID.UPGRADES)) return 0;
  return isGlobalUpgradeActive(state.players, UID.DOUBLE_TIME)
    ? DOUBLE_TIME_BONUS_SECONDS
    : 0;
}
