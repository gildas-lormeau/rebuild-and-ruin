/**
 * Rubble-clearing fade-out multiplier. Lands `1 → 0` in
 * `overlay.battle.rubbleClearingFade`; pit + debris managers apply it to
 * held material alpha. Held entries come from
 * `state.modern.rubbleClearingHeld`, captured by `rubbleClearingImpl.apply`
 * before the gameplay mutation. The wave on the ramp gives the fade a
 * "rubble crumbling away" feel — swells converging on zero, not a slider.
 */

import { deriveModifierRamp } from "./modifier-reveal-ramp.ts";
import { wavedRamp } from "./waved-ramp.ts";

export const RUBBLE_CLEARING_RAMP_DURATION_MS = 1100;
export const RUBBLE_CLEARING_WAVE_PERIOD_MS = 320;
/** Peak wave amplitude at t=0; shrinks linearly to 0 as t→1. Tuned to
 *  give a clearly-visible pulse — at this amplitude the wave clips
 *  against 0 / 1 at the extremes, reading as the rubble briefly
 *  snapping back to full / fully gone rather than a soft drift. */
export const RUBBLE_CLEARING_WAVE_PEAK_AMPLITUDE = 0.3;

export function deriveRubbleClearingFade(
  revealTimeMs: number | undefined,
): number | undefined {
  return deriveModifierRamp({
    revealTimeMs,
    durationMs: RUBBLE_CLEARING_RAMP_DURATION_MS,
    compute: (elapsedMs) =>
      wavedRamp({
        elapsed: elapsedMs,
        durationMs: RUBBLE_CLEARING_RAMP_DURATION_MS,
        start: 1,
        end: 0,
        wavePeriodMs: RUBBLE_CLEARING_WAVE_PERIOD_MS,
        wavePeakAmplitude: RUBBLE_CLEARING_WAVE_PEAK_AMPLITUDE,
      }),
  });
}
