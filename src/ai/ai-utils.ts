/**
 * AI utilities split out of ai-constants so that file can stay pure-data:
 * `secondsToTicks` (needs SIM_TICK_DT — pulled here keeps ai-constants a
 * leaf L0 with no imports) and `traitLookup` (3-element skill table
 * accessor used by every strategy/brain file).
 */

import { SIM_TICK_DT } from "../shared/core/game-constants.ts";

/** Convert a duration in seconds to an integer tick count. */
export function secondsToTicks(seconds: number): number {
  return Math.round(seconds / SIM_TICK_DT);
}

/** Look up a value from a 3-element table indexed by 1-based trait level.
 *  Level 1 → values[0], level 2 → values[1], level 3 → values[2].
 *  @param level — 1-based skill level (1–3). NOT 0-based. */
export function traitLookup<T>(level: number, values: readonly [T, T, T]): T {
  return values[level - 1]!;
}
