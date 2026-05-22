/**
 * Sapper-reveal tint intensity. Lands in
 * `overlay.battle.sapperRevealIntensity`; the walls manager lerps
 * targeted-wall material color toward copper by this multiplier (the
 * actual wall meshes pulse, replacing a legacy per-tile disc burst).
 * Curve: bell envelope `sin(t·π)` modulated by a fast pulse wave so
 * targeted walls flash a few times within a smooth peak-and-fade window.
 */

import { bellPulse } from "../bell-pulse.ts";
import { deriveModifierRamp } from "./ramp.ts";

export const SAPPER_REVEAL_PULSE_PERIOD_MS = 280;
/** Peak tint mix at the bell's apex; lower values = subtler tint. */
export const SAPPER_REVEAL_PEAK_INTENSITY = 0.85;
export const SAPPER_REVEAL_RAMP_DURATION_MS = 1100;

export function deriveSapperRevealIntensity(
  revealTimeMs: number | undefined,
): number | undefined {
  return deriveModifierRamp({
    revealTimeMs,
    durationMs: SAPPER_REVEAL_RAMP_DURATION_MS,
    compute: (elapsedMs) =>
      bellPulse({
        elapsed: elapsedMs,
        durationMs: SAPPER_REVEAL_RAMP_DURATION_MS,
        pulsePeriodMs: SAPPER_REVEAL_PULSE_PERIOD_MS,
        peak: SAPPER_REVEAL_PEAK_INTENSITY,
      }),
  });
}
