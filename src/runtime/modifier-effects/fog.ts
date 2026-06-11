/**
 * Fog progressive-reveal opacity multiplier. Lands in
 * `overlay.battle.fogRevealOpacity`; fog manager applies it to material
 * alpha. Time gating via `deriveModifierRamp` driven by `revealTimeMs`.
 * The wave gives a rolling-in feel — multiple swells converging on full
 * opacity rather than a monotonic slider. Ramp duration fits inside the
 * post-sweep dwell so the curve completes before the phase advances.
 */

import {
  deriveModifierRamp,
  MODIFIER_REVEAL_RAMP_DURATION_MS,
  MODIFIER_REVEAL_WAVE_PEAK_AMPLITUDE,
  MODIFIER_REVEAL_WAVE_PERIOD_MS,
} from "./ramp.ts";
import { wavedRamp } from "./waved-ramp.ts";

/** Opacity floor at the snapshot frame — fog faintly appears so the
 *  banner sweep reveals something rather than nothing. */
export const FOG_REVEAL_FLOOR = 0.2;
/** Ramp duration after the snapshot, in ms. */
export const FOG_REVEAL_RAMP_DURATION_MS = MODIFIER_REVEAL_RAMP_DURATION_MS;
/** Wave period for the rolling-in oscillation, in ms. */
export const FOG_REVEAL_WAVE_PERIOD_MS = MODIFIER_REVEAL_WAVE_PERIOD_MS;
/** Peak wave amplitude at t=0; shrinks linearly to 0 as t→1. Tuned to
 *  give a clearly-visible pulse — at this amplitude the wave clips
 *  against 0 / 1 at the extremes, reading as fog briefly fully on /
 *  off rather than a soft drift. */
export const FOG_REVEAL_WAVE_PEAK_AMPLITUDE =
  MODIFIER_REVEAL_WAVE_PEAK_AMPLITUDE;

export function deriveFogRevealOpacity(
  revealTimeMs: number | undefined,
): number | undefined {
  return deriveModifierRamp({
    revealTimeMs,
    durationMs: FOG_REVEAL_RAMP_DURATION_MS,
    compute: (elapsedMs) =>
      wavedRamp({
        elapsed: elapsedMs,
        durationMs: FOG_REVEAL_RAMP_DURATION_MS,
        start: FOG_REVEAL_FLOOR,
        end: 1,
        wavePeriodMs: FOG_REVEAL_WAVE_PERIOD_MS,
        wavePeakAmplitude: FOG_REVEAL_WAVE_PEAK_AMPLITUDE,
      }),
  });
}
