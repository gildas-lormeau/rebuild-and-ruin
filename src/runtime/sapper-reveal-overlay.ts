/**
 * Sapper-reveal tint intensity. Lands in
 * `overlay.battle.sapperRevealIntensity`; the walls manager lerps
 * targeted-wall material color toward copper by this multiplier (the
 * actual wall meshes pulse, replacing a legacy per-tile disc burst).
 * Curve: bell envelope `sin(t·π)` modulated by a fast pulse wave so
 * targeted walls flash a few times within a smooth peak-and-fade window.
 */

import { deriveModifierRamp } from "./modifier-reveal-ramp.ts";

export const SAPPER_REVEAL_RAMP_DURATION_MS = 1100;
export const SAPPER_REVEAL_PULSE_PERIOD_MS = 280;
/** Peak tint mix at the bell's apex; lower values = subtler tint. */
export const SAPPER_REVEAL_PEAK_INTENSITY = 0.85;

export function deriveSapperRevealIntensity(
  revealTimeMs: number | undefined,
): number | undefined {
  return deriveModifierRamp({
    revealTimeMs,
    durationMs: SAPPER_REVEAL_RAMP_DURATION_MS,
    compute: (elapsedMs) => {
      const progress = elapsedMs / SAPPER_REVEAL_RAMP_DURATION_MS;
      const envelope = Math.sin(progress * Math.PI);
      const pulse =
        0.5 +
        0.5 *
          Math.sin((elapsedMs / SAPPER_REVEAL_PULSE_PERIOD_MS) * Math.PI * 2);
      return SAPPER_REVEAL_PEAK_INTENSITY * envelope * pulse;
    },
  });
}
