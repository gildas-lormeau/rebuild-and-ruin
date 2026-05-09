/**
 * Frostbite-reveal tint multiplier — runtime-side overlay derivation.
 * Lands a `[0, 1]` intensity in `overlay.battle.frostbiteRevealProgress`;
 * 0 = grunt authored color, 1 = full frostbite tint. Time gating lives
 * in `deriveModifierRamp` driven by `revealTimeMs`.
 *
 * Post-release the manager pins to 1 for the rest of the round via the
 * binary `frostbite` flag.
 */

import { deriveModifierRamp } from "./modifier-reveal-ramp.ts";
import { wavedRamp } from "./waved-ramp.ts";

/** Intensity held during the snapshot — grunts faintly cooling. */
export const FROSTBITE_REVEAL_FLOOR = 0.2;
export const FROSTBITE_REVEAL_RAMP_DURATION_MS = 1100;
export const FROSTBITE_REVEAL_WAVE_PERIOD_MS = 320;
export const FROSTBITE_REVEAL_WAVE_PEAK_AMPLITUDE = 0.3;

export function deriveFrostbiteRevealProgress(
  revealTimeMs: number | undefined,
): number | undefined {
  return deriveModifierRamp({
    revealTimeMs,
    durationMs: FROSTBITE_REVEAL_RAMP_DURATION_MS,
    compute: (elapsedMs) =>
      wavedRamp({
        elapsed: elapsedMs,
        durationMs: FROSTBITE_REVEAL_RAMP_DURATION_MS,
        start: FROSTBITE_REVEAL_FLOOR,
        end: 1,
        wavePeriodMs: FROSTBITE_REVEAL_WAVE_PERIOD_MS,
        wavePeakAmplitude: FROSTBITE_REVEAL_WAVE_PEAK_AMPLITUDE,
      }),
  });
}
