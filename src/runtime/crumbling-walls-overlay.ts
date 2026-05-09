/**
 * Crumbling-walls fade-out multiplier. Lands a `1 → 0` value in
 * `overlay.battle.crumblingWallsFade` that the walls + debris managers
 * apply to held wall material alpha (walls fade out, wall-debris
 * cross-fades in). Held tile keys come from `state.modern.crumblingWallsHeld`,
 * captured by `crumblingWallsImpl.apply` before the gameplay mutation.
 * The wave on the ramp gives the fade a "wall crumbling away" feel.
 */

import { deriveModifierRamp } from "./modifier-reveal-ramp.ts";
import { wavedRamp } from "./waved-ramp.ts";

export const CRUMBLING_WALLS_RAMP_DURATION_MS = 1100;
export const CRUMBLING_WALLS_WAVE_PERIOD_MS = 320;
export const CRUMBLING_WALLS_WAVE_PEAK_AMPLITUDE = 0.3;

export function deriveCrumblingWallsFade(
  revealTimeMs: number | undefined,
): number | undefined {
  return deriveModifierRamp({
    revealTimeMs,
    durationMs: CRUMBLING_WALLS_RAMP_DURATION_MS,
    compute: (elapsedMs) =>
      wavedRamp({
        elapsed: elapsedMs,
        durationMs: CRUMBLING_WALLS_RAMP_DURATION_MS,
        start: 1,
        end: 0,
        wavePeriodMs: CRUMBLING_WALLS_WAVE_PERIOD_MS,
        wavePeakAmplitude: CRUMBLING_WALLS_WAVE_PEAK_AMPLITUDE,
      }),
  });
}
