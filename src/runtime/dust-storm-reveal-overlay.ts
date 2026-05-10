/**
 * Dust-storm reveal scalars — both derived from `revealTimeMs` so the
 * cosine-bell amplitude envelope and the linear `0 → π` phase ramp
 * stay perfectly synchronized. The manager keeps no reveal-time clock
 * of its own. See `BattleOverlay.dustStormSway*` for the contract;
 * total duration fits inside `MODIFIER_REVEAL_TIMER` (2s) with a
 * buffer for the reveal sweep + the battle-banner snapshot.
 */

import { deriveModifierRamp } from "./modifier-reveal-ramp.ts";

export const DUST_STORM_REVEAL_DURATION_MS = 1600;
/** Peak sway amplitude during reveal, expressed as a fraction of the
 *  battle steady-state swing (1.0). < 1 so the reveal motion is a
 *  "hint of wind" rather than a full gust. */
export const DUST_STORM_REVEAL_PEAK_AMPLITUDE = 0.5;

export function deriveDustStormSwayAmplitude(
  revealTimeMs: number | undefined,
): number | undefined {
  return deriveModifierRamp({
    revealTimeMs,
    durationMs: DUST_STORM_REVEAL_DURATION_MS,
    compute: (elapsedMs) => {
      const t = elapsedMs / DUST_STORM_REVEAL_DURATION_MS;
      // Cosine bell: 0 → peak → 0 with zero slope at both ends.
      const bell = Math.sin(t * Math.PI);
      return DUST_STORM_REVEAL_PEAK_AMPLITUDE * bell * bell;
    },
  });
}

export function deriveDustStormSwayPhaseRad(
  revealTimeMs: number | undefined,
): number | undefined {
  return deriveModifierRamp({
    revealTimeMs,
    durationMs: DUST_STORM_REVEAL_DURATION_MS,
    compute: (elapsedMs) =>
      (elapsedMs * Math.PI) / DUST_STORM_REVEAL_DURATION_MS,
  });
}
