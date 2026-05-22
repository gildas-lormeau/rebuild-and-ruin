/**
 * Dust-storm reveal scalars — preview the battle motion. Amplitude
 * ramps from a "slight breeze" floor up to the reveal peak via
 * `wavedRamp`; phase advances at the steady-state battle angular
 * speed so the reveal ENDS mid-cycle with amplitude at peak. Battle
 * then eases amplitude from peak to 1.0 with continuous phase — no
 * reset, no pause, the storm IS the buildup that just finished.
 */

import { wavedRamp } from "../waved-ramp.ts";
import { deriveModifierRamp } from "./ramp.ts";

/** Amplitude at reveal start — a slight breeze rather than dead-still
 *  so the first frame shows motion. Mirrors fog/frostbite's "floor"
 *  pattern. */
const DUST_STORM_REVEAL_FLOOR = 0.1;
/** Subtle pulse layered on the linear ramp; gives the buildup a
 *  "gusty" texture instead of a metronome ramp. Period matches
 *  fog/frostbite/rubble (320ms). */
const DUST_STORM_REVEAL_WAVE_PERIOD_MS = 320;
/** Small enough that the linear ramp dominates — the pulse adds
 *  texture rather than overwhelming the rising trend. */
const DUST_STORM_REVEAL_WAVE_PEAK_AMPLITUDE = 0.05;
/** Battle steady-state sway period in seconds. Mirrors
 *  `DUST_STORM_SWAY_PERIOD_SEC` in `render/3d/effects/dust-storm.ts`
 *  (domain rules forbid render→runtime value imports). Reveal sweeps
 *  phase at the same angular speed so battle's continuing sweep picks
 *  up where reveal left off — keep in sync. */
const DUST_STORM_SWAY_PERIOD_SEC = 3.2;
/** Angular speed in rad/sec — derived once. */
const DUST_STORM_SWAY_ANGULAR_SPEED_RAD_PER_SEC =
  (2 * Math.PI) / DUST_STORM_SWAY_PERIOD_SEC;
/** Reveal duration. Matches sibling overlays (fog/frostbite/rubble)
 *  for a uniform reveal-window across modifiers. */
export const DUST_STORM_REVEAL_DURATION_MS = 1100;
/** Amplitude at reveal end. Battle eases from this to 1.0 over its
 *  own first second — keeps the handoff smooth (no sudden full gust). */
export const DUST_STORM_REVEAL_PEAK_AMPLITUDE = 0.5;

export function deriveDustStormSwayAmplitude(
  revealTimeMs: number | undefined,
): number | undefined {
  return deriveModifierRamp({
    revealTimeMs,
    durationMs: DUST_STORM_REVEAL_DURATION_MS,
    compute: (elapsedMs) =>
      wavedRamp({
        elapsed: elapsedMs,
        durationMs: DUST_STORM_REVEAL_DURATION_MS,
        start: DUST_STORM_REVEAL_FLOOR,
        end: DUST_STORM_REVEAL_PEAK_AMPLITUDE,
        wavePeriodMs: DUST_STORM_REVEAL_WAVE_PERIOD_MS,
        wavePeakAmplitude: DUST_STORM_REVEAL_WAVE_PEAK_AMPLITUDE,
      }),
  });
}

export function deriveDustStormSwayPhaseRad(
  revealTimeMs: number | undefined,
): number | undefined {
  return deriveModifierRamp({
    revealTimeMs,
    durationMs: DUST_STORM_REVEAL_DURATION_MS,
    compute: (elapsedMs) =>
      (elapsedMs / 1000) * DUST_STORM_SWAY_ANGULAR_SPEED_RAD_PER_SEC,
  });
}
