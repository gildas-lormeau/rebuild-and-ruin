/**
 * Fog progressive-reveal opacity multiplier — runtime-side overlay
 * derivation. Lands in `overlay.battle.fogRevealOpacity`; the fog
 * manager applies it to material alpha. State machine + sweep gating
 * live in `deriveModifierRamp`.
 *
 * The wave on the ramp gives the reveal a rolling-in feel — multiple
 * swells converging on full opacity rather than a monotonic slider.
 *
 * Ramp duration sits inside the ~1.5s post-sweep dwell of the
 * MODIFIER_REVEAL_TIMER window so the curve always completes before
 * the phase advances.
 */

import { MODIFIER_ID } from "../shared/core/game-constants.ts";
import type { RenderView } from "../shared/core/render-view.ts";
import {
  deriveModifierRamp,
  type ModifierRampContext,
} from "./modifier-reveal-ramp.ts";
import type { ActiveBannerState } from "./runtime-contracts.ts";
import { wavedRamp } from "./waved-ramp.ts";

interface FogRevealRampState {
  /** When the ramp started (in `now()`-units), or undefined while
   *  pre-sweep / post-release. Mutated by this helper. */
  fogRevealRampStartMs: number | undefined;
}

interface DeriveInput extends ModifierRampContext {
  readonly view: Pick<RenderView, "phase" | "modern">;
  readonly banner: ActiveBannerState | { status: "hidden" };
  readonly now: number;
  /** Holder for cross-frame ramp-start state. Mutated. */
  readonly state: FogRevealRampState;
}

/** Multiplier value held during snapshot + sweep. Low enough to read as
 *  "fog faintly appearing" but visible enough that the banner sweep
 *  reveals something rather than nothing. */
export const FOG_REVEAL_FLOOR = 0.2;
/** Ramp duration after the banner sweep completes, in ms. */
export const FOG_REVEAL_RAMP_DURATION_MS = 1100;
/** Wave period for the rolling-in oscillation, in ms. */
export const FOG_REVEAL_WAVE_PERIOD_MS = 320;
/** Peak wave amplitude at t=0; shrinks linearly to 0 as t→1. Tuned to
 *  give a clearly-visible pulse — at this amplitude the wave clips
 *  against 0 / 1 at the extremes, reading as fog briefly fully on /
 *  off rather than a soft drift. */
export const FOG_REVEAL_WAVE_PEAK_AMPLITUDE = 0.3;

export function deriveFogRevealOpacity(input: DeriveInput): number | undefined {
  return deriveModifierRamp(input, {
    modifierId: MODIFIER_ID.FOG_OF_WAR,
    getRampStartMs: () => input.state.fogRevealRampStartMs,
    setRampStartMs: (value) => {
      input.state.fogRevealRampStartMs = value;
    },
    sweepValue: FOG_REVEAL_FLOOR,
    durationMs: FOG_REVEAL_RAMP_DURATION_MS,
    compute: (elapsed) =>
      wavedRamp({
        elapsed,
        durationMs: FOG_REVEAL_RAMP_DURATION_MS,
        start: FOG_REVEAL_FLOOR,
        end: 1,
        wavePeriodMs: FOG_REVEAL_WAVE_PERIOD_MS,
        wavePeakAmplitude: FOG_REVEAL_WAVE_PEAK_AMPLITUDE,
      }),
  });
}
