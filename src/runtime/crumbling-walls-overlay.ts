/**
 * Crumbling-walls fade-out multiplier — runtime-side overlay derivation.
 * Lands a `1 → 0` value in `overlay.battle.crumblingWallsFade` that the
 * walls + debris managers apply to held wall material alpha (walls
 * fading out, wall-debris cross-fading in). Held wall tile keys come
 * from `state.modern.crumblingWallsHeld`, captured by
 * `crumblingWallsImpl.apply` before the gameplay-state mutation.
 *
 * State machine + sweep gating live in `deriveModifierRamp`. The wave
 * on the ramp gives the fade a "wall crumbling away" feel.
 */

import { MODIFIER_ID } from "../shared/core/game-constants.ts";
import type { RenderView } from "../shared/core/render-view.ts";
import {
  deriveModifierRamp,
  type ModifierRampContext,
} from "./modifier-reveal-ramp.ts";
import type { ActiveBannerState } from "./runtime-contracts.ts";
import { wavedRamp } from "./waved-ramp.ts";

interface CrumblingWallsRampState {
  crumblingWallsRampStartMs: number | undefined;
}

interface DeriveInput extends ModifierRampContext {
  readonly view: Pick<RenderView, "phase" | "modern">;
  readonly banner: ActiveBannerState | { status: "hidden" };
  readonly now: number;
  readonly state: CrumblingWallsRampState;
}

export const CRUMBLING_WALLS_RAMP_DURATION_MS = 1100;
export const CRUMBLING_WALLS_WAVE_PERIOD_MS = 320;
export const CRUMBLING_WALLS_WAVE_PEAK_AMPLITUDE = 0.3;

export function deriveCrumblingWallsFade(
  input: DeriveInput,
): number | undefined {
  return deriveModifierRamp(input, {
    modifierId: MODIFIER_ID.CRUMBLING_WALLS,
    getRampStartMs: () => input.state.crumblingWallsRampStartMs,
    setRampStartMs: (value) => {
      input.state.crumblingWallsRampStartMs = value;
    },
    sweepValue: 1,
    durationMs: CRUMBLING_WALLS_RAMP_DURATION_MS,
    compute: (elapsed) =>
      wavedRamp({
        elapsed,
        durationMs: CRUMBLING_WALLS_RAMP_DURATION_MS,
        start: 1,
        end: 0,
        wavePeriodMs: CRUMBLING_WALLS_WAVE_PERIOD_MS,
        wavePeakAmplitude: CRUMBLING_WALLS_WAVE_PEAK_AMPLITUDE,
      }),
  });
}
