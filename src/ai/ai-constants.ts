/**
 * Shared AI strategy constants and helpers.
 *
 * Extracted from ai-strategy.ts so that sub-modules (ai-strategy-build,
 * ai-strategy-cannon, ai-strategy-battle) can import these without
 * creating circular dependencies back to the parent module.
 */

/** Must match SIM_TICK_DT in game-constants.ts. Duplicated to avoid a
 *  lateral import (ai-constants and game-constants are both leaf modules). */

const SIM_TICK_DT = 1 / 60;
export const SMALL_POCKET_MAX_SIZE = 4;
/** Pockets this small or smaller block placement when no gaps are being filled (skill ≥3). */
export const TINY_POCKET_MAX_SIZE = 3;
/** Shared step discriminant values for all AI phase state machines. */
export const STEP = {
  IDLE: "idle",
  BROWSING: "browsing",
  CONFIRMING: "confirming",
  THINKING: "thinking",
  MOVING: "moving",
  DWELLING: "dwelling",
  GAVE_UP: "gave_up",
  MODE_SWITCHING: "mode_switching",
  COUNTDOWN: "countdown",
  CHAIN_MOVING: "chain_moving",
  CHAIN_DWELLING: "chain_dwelling",
  PICKING: "picking",
} as const;
/** Pause after placing a piece/cannon before thinking about the next one. */
export const POST_PLACE_DELAY_SEC = 0.3;
export const POST_PLACE_SPREAD_SEC = 0.4;
/** Pause on target tile before attempting placement. */
export const PRE_PLACE_DELAY_SEC = 0.2;
export const PRE_PLACE_SPREAD_SEC = 0.3;

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

/** Create a memoized version of a function (Map-based cache). */
export function memoize<K, V>(func: (key: K) => V): (key: K) => V {
  const cache = new Map<K, V>();
  return (key: K): V => {
    if (cache.has(key)) return cache.get(key)!;
    const computed = func(key);
    cache.set(key, computed);
    return computed;
  };
}
