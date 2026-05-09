/**
 * Grunt-surge tint intensity. Lands in
 * `overlay.battle.gruntSurgeRevealIntensity`; grunt manager lerps fresh
 * surge-grunt material color toward red per-instance. Curve: bell envelope
 * `sin(t·π)` modulated by a fast pulse wave (same shape as sapper threat
 * tint). Time gating via `deriveModifierRamp` driven by `revealTimeMs`.
 */

import { deriveModifierRamp } from "./modifier-reveal-ramp.ts";

export const GRUNT_SURGE_REVEAL_RAMP_DURATION_MS = 1100;
export const GRUNT_SURGE_REVEAL_PULSE_PERIOD_MS = 280;
/** Peak tint mix at the bell's apex; lower values = subtler tint. */
export const GRUNT_SURGE_REVEAL_PEAK_INTENSITY = 0.85;

export function deriveGruntSurgeRevealIntensity(
  revealTimeMs: number | undefined,
): number | undefined {
  return deriveModifierRamp({
    revealTimeMs,
    durationMs: GRUNT_SURGE_REVEAL_RAMP_DURATION_MS,
    compute: (elapsedMs) => {
      const progress = elapsedMs / GRUNT_SURGE_REVEAL_RAMP_DURATION_MS;
      const envelope = Math.sin(progress * Math.PI);
      const pulse =
        0.5 +
        0.5 *
          Math.sin(
            (elapsedMs / GRUNT_SURGE_REVEAL_PULSE_PERIOD_MS) * Math.PI * 2,
          );
      return GRUNT_SURGE_REVEAL_PEAK_INTENSITY * envelope * pulse;
    },
  });
}
