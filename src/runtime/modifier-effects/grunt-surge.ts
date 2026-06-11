/**
 * Grunt-surge tint intensity. Lands in
 * `overlay.battle.gruntSurgeRevealIntensity`; grunt manager lerps fresh
 * surge-grunt material color toward red per-instance. Curve: bell envelope
 * `sin(t·π)` modulated by a fast pulse wave (same shape as sapper threat
 * tint). Time gating via `deriveModifierRamp` driven by `revealTimeMs`.
 */

import { bellPulse } from "./bell-pulse.ts";
import {
  deriveModifierRamp,
  MODIFIER_REVEAL_RAMP_DURATION_MS,
  MODIFIER_REVEAL_THREAT_PEAK_INTENSITY,
  MODIFIER_REVEAL_THREAT_PULSE_PERIOD_MS,
} from "./ramp.ts";

export const GRUNT_SURGE_REVEAL_PULSE_PERIOD_MS =
  MODIFIER_REVEAL_THREAT_PULSE_PERIOD_MS;
/** Peak tint mix at the bell's apex; lower values = subtler tint. */
export const GRUNT_SURGE_REVEAL_PEAK_INTENSITY =
  MODIFIER_REVEAL_THREAT_PEAK_INTENSITY;
export const GRUNT_SURGE_REVEAL_RAMP_DURATION_MS =
  MODIFIER_REVEAL_RAMP_DURATION_MS;

export function deriveGruntSurgeRevealIntensity(
  revealTimeMs: number | undefined,
): number | undefined {
  return deriveModifierRamp({
    revealTimeMs,
    durationMs: GRUNT_SURGE_REVEAL_RAMP_DURATION_MS,
    compute: (elapsedMs) =>
      bellPulse({
        elapsed: elapsedMs,
        durationMs: GRUNT_SURGE_REVEAL_RAMP_DURATION_MS,
        pulsePeriodMs: GRUNT_SURGE_REVEAL_PULSE_PERIOD_MS,
        peak: GRUNT_SURGE_REVEAL_PEAK_INTENSITY,
      }),
  });
}
