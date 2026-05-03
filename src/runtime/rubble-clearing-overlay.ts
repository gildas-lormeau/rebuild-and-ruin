/**
 * Rubble-clearing fade-out multiplier — runtime-side overlay derivation.
 * Lands a `1 → 0` value in `overlay.battle.rubbleClearingFade` that the
 * pit + debris managers apply to held material alpha. Held entries
 * themselves come from `state.modern.rubbleClearingHeld`, captured by
 * `rubbleClearingImpl.apply` before the gameplay-state mutation.
 *
 * State machine + sweep gating live in `deriveModifierRamp`. The wave
 * on the ramp gives the fade a "rubble crumbling away" feel — multiple
 * swells converging on zero rather than a monotonic slider.
 */

import { MODIFIER_ID } from "../shared/core/game-constants.ts";
import type { RenderView } from "../shared/core/render-view.ts";
import {
  deriveModifierRamp,
  type ModifierRampContext,
} from "./modifier-reveal-ramp.ts";
import type { ActiveBannerState } from "./runtime-contracts.ts";
import { wavedRamp } from "./waved-ramp.ts";

interface RubbleClearingRampState {
  rubbleClearingRampStartMs: number | undefined;
}

interface DeriveInput extends ModifierRampContext {
  readonly view: Pick<RenderView, "phase" | "modern">;
  readonly banner: ActiveBannerState | { status: "hidden" };
  readonly now: number;
  readonly state: RubbleClearingRampState;
}

export const RUBBLE_CLEARING_RAMP_DURATION_MS = 1100;
export const RUBBLE_CLEARING_WAVE_PERIOD_MS = 320;
/** Peak wave amplitude at t=0; shrinks linearly to 0 as t→1. Tuned to
 *  give a clearly-visible pulse — at this amplitude the wave clips
 *  against 0 / 1 at the extremes, reading as the rubble briefly
 *  snapping back to full / fully gone rather than a soft drift. */
export const RUBBLE_CLEARING_WAVE_PEAK_AMPLITUDE = 0.3;

export function deriveRubbleClearingFade(
  input: DeriveInput,
): number | undefined {
  return deriveModifierRamp(input, {
    modifierId: MODIFIER_ID.RUBBLE_CLEARING,
    getRampStartMs: () => input.state.rubbleClearingRampStartMs,
    setRampStartMs: (value) => {
      input.state.rubbleClearingRampStartMs = value;
    },
    sweepValue: 1,
    durationMs: RUBBLE_CLEARING_RAMP_DURATION_MS,
    compute: (elapsed) =>
      wavedRamp({
        elapsed,
        durationMs: RUBBLE_CLEARING_RAMP_DURATION_MS,
        start: 1,
        end: 0,
        wavePeriodMs: RUBBLE_CLEARING_WAVE_PERIOD_MS,
        wavePeakAmplitude: RUBBLE_CLEARING_WAVE_PEAK_AMPLITUDE,
      }),
  });
}
