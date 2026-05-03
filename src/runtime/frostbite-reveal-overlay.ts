/**
 * Frostbite-reveal tint multiplier — runtime-side overlay derivation.
 * Lands a `[0, 1]` intensity in `overlay.battle.frostbiteRevealProgress`;
 * 0 = grunt authored color, 1 = full frostbite tint. State machine +
 * sweep gating live in `deriveModifierRamp`.
 *
 * Post-release the manager pins to 1 for the rest of the round via the
 * binary `frostbite` flag.
 */

import { MODIFIER_ID } from "../shared/core/game-constants.ts";
import type { RenderView } from "../shared/core/render-view.ts";
import {
  deriveModifierRamp,
  type ModifierRampContext,
} from "./modifier-reveal-ramp.ts";
import type { ActiveBannerState } from "./runtime-contracts.ts";
import { wavedRamp } from "./waved-ramp.ts";

interface FrostbiteRevealRampState {
  frostbiteRevealRampStartMs: number | undefined;
}

interface DeriveInput extends ModifierRampContext {
  readonly view: Pick<RenderView, "phase" | "modern">;
  readonly banner: ActiveBannerState | { status: "hidden" };
  readonly now: number;
  readonly state: FrostbiteRevealRampState;
}

/** Intensity held during snapshot + sweep — grunts faintly cooling. */
export const FROSTBITE_REVEAL_FLOOR = 0.2;
export const FROSTBITE_REVEAL_RAMP_DURATION_MS = 1100;
export const FROSTBITE_REVEAL_WAVE_PERIOD_MS = 320;
export const FROSTBITE_REVEAL_WAVE_PEAK_AMPLITUDE = 0.3;

export function deriveFrostbiteRevealProgress(
  input: DeriveInput,
): number | undefined {
  return deriveModifierRamp(input, {
    modifierId: MODIFIER_ID.FROSTBITE,
    getRampStartMs: () => input.state.frostbiteRevealRampStartMs,
    setRampStartMs: (value) => {
      input.state.frostbiteRevealRampStartMs = value;
    },
    sweepValue: FROSTBITE_REVEAL_FLOOR,
    durationMs: FROSTBITE_REVEAL_RAMP_DURATION_MS,
    compute: (elapsed) =>
      wavedRamp({
        elapsed,
        durationMs: FROSTBITE_REVEAL_RAMP_DURATION_MS,
        start: FROSTBITE_REVEAL_FLOOR,
        end: 1,
        wavePeriodMs: FROSTBITE_REVEAL_WAVE_PERIOD_MS,
        wavePeakAmplitude: FROSTBITE_REVEAL_WAVE_PEAK_AMPLITUDE,
      }),
  });
}
