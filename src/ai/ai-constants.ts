/**
 * Pure AI strategy constants (data only — no imports, no helpers).
 * Lives at L0 alongside game-constants. Functions that need these
 * constants (or SIM_TICK_DT) live in ai-utils.ts at L1.
 */

export const SMALL_POCKET_MAX_SIZE = 4;
/** Pockets this small or smaller block placement when no gaps are being filled (skill ≥3). */
export const TINY_POCKET_MAX_SIZE = 3;
/** Shared step discriminant values for all AI phase state machines. */
export const STEP = {
  IDLE: "idle",
  BROWSING: "browsing",
  CONFIRMING: "confirming",
  CONFIRMED: "confirmed",
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
