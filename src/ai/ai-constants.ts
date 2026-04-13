/**
 * Shared AI strategy constants and helpers.
 *
 * Extracted from ai-strategy.ts so that sub-modules (ai-strategy-build,
 * ai-strategy-cannon, ai-strategy-battle) can import these without
 * creating circular dependencies back to the parent module.
 */

/** Fixed time step (seconds) for AI sub-stepping. AI logic runs in discrete
 *  ticks of this size — the accumulator converts variable frame dt into an
 *  integer number of these ticks. Only used by the accumulator and
 *  `scaledDelay` (seconds → ticks conversion); AI phase files never import
 *  this directly — they just do `timer--` per tick. */

const US_PER_SEC = 1_000_000;
export const AI_TICK_DT = 1 / 60;
/** Microseconds per AI tick — integer arithmetic avoids floating-point
 *  drift that causes different step counts at different frame rates. */
const TICK_US = Math.round(AI_TICK_DT * US_PER_SEC);
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

/** Convert a duration in seconds to an integer tick count. */
export function secondsToTicks(seconds: number): number {
  return Math.round(seconds / AI_TICK_DT);
}

/** Accumulator that converts variable frame dt into a fixed number of
 *  AI sub-steps, carrying over the remainder so no simulation time is
 *  lost or gained across frames. Uses integer microsecond math internally
 *  to eliminate floating-point rounding differences. */
export class AiTickAccumulator {
  private accumUs = 0;

  /** Feed a frame's dt (seconds) and return the number of fixed steps to run. */
  drain(frameDt: number): number {
    this.accumUs += Math.round(frameDt * US_PER_SEC);
    const steps = Math.floor(this.accumUs / TICK_US);
    this.accumUs -= steps * TICK_US;
    return steps;
  }

  reset(): void {
    this.accumUs = 0;
  }
}

/** Look up a value from a 3-element table indexed by 1-based trait level.
 *  Level 1 → values[0], level 2 → values[1], level 3 → values[2].
 *  @param level — 1-based skill level (1–3). NOT 0-based. */
export function traitLookup<T>(level: number, values: readonly [T, T, T]): T {
  return values[level - 1]!;
}
