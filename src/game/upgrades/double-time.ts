/**
 * Double Time upgrade — +10s build phase timer for all players.
 *
 * Hook implemented: buildTimerBonus (aggregator, additive, global).
 * Wired through src/game/upgrade-system.ts.
 */

import { FID } from "../../shared/feature-defs.ts";
import { DOUBLE_TIME_BONUS_SECONDS } from "../../shared/game-constants.ts";
import { type GameState, hasFeature } from "../../shared/types.ts";
import { isGlobalUpgradeActive, UID } from "../../shared/upgrade-defs.ts";

/** Build timer bonus contributed by Double Time — global: any owner grants
 *  the bonus to every player's build phase. */
export function doubleTimeBuildTimerBonus(state: GameState): number {
  if (!hasFeature(state, FID.UPGRADES)) return 0;
  return isGlobalUpgradeActive(state.players, UID.DOUBLE_TIME)
    ? DOUBLE_TIME_BONUS_SECONDS
    : 0;
}
