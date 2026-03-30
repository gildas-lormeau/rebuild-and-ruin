/**
 * Shared AI strategy constants and helpers.
 *
 * Extracted from ai-strategy.ts so that sub-modules (ai-strategy-build,
 * ai-strategy-cannon, ai-strategy-battle) can import these without
 * creating circular dependencies back to the parent module.
 */

/** Look up a value from a 3-element table indexed by a 1-3 trait level. */

/** Interior pockets smaller than this are targeted for wall destruction / penalized in placement. */

export const SMALL_POCKET_MAX_SIZE = 4;
/** Pockets this small or smaller block placement when no gaps are being filled (skill ≥3). */
export const TINY_POCKET_MAX_SIZE = 2;
/** Shared step discriminant values for all AI phase state machines. */
export const Step = {
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

export function traitLookup<T>(level: number, values: readonly [T, T, T]): T {
  return values[level - 1]!;
}
