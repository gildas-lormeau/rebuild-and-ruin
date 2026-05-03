/**
 * Sapper-reveal tint intensity — runtime-side overlay derivation.
 * Lands in `overlay.battle.sapperRevealIntensity`; the walls manager
 * lerps targeted-wall material color toward copper by this multiplier.
 *
 * Replaces the legacy per-tile disc burst — the actual wall meshes
 * pulse copper instead of standing in with floating discs.
 *
 * Curve: bell envelope `sin(t * π)` modulated by a fast pulse wave so
 * the targeted walls flash a few times within a smooth peak-and-fade
 * window. State machine + sweep gating live in `deriveModifierRamp`.
 */

import { MODIFIER_ID } from "../shared/core/game-constants.ts";
import type { RenderView } from "../shared/core/render-view.ts";
import {
  deriveModifierRamp,
  type ModifierRampContext,
} from "./modifier-reveal-ramp.ts";
import type { ActiveBannerState } from "./runtime-contracts.ts";

interface SapperRevealRampState {
  sapperRevealRampStartMs: number | undefined;
}

interface DeriveInput extends ModifierRampContext {
  readonly view: Pick<RenderView, "phase" | "modern">;
  readonly banner: ActiveBannerState | { status: "hidden" };
  readonly now: number;
  readonly state: SapperRevealRampState;
}

export const SAPPER_REVEAL_RAMP_DURATION_MS = 1100;
export const SAPPER_REVEAL_PULSE_PERIOD_MS = 280;
/** Peak tint mix at the bell's apex; lower values = subtler tint. */
export const SAPPER_REVEAL_PEAK_INTENSITY = 0.85;

export function deriveSapperRevealIntensity(
  input: DeriveInput,
): number | undefined {
  return deriveModifierRamp(input, {
    modifierId: MODIFIER_ID.SAPPER,
    getRampStartMs: () => input.state.sapperRevealRampStartMs,
    setRampStartMs: (value) => {
      input.state.sapperRevealRampStartMs = value;
    },
    sweepValue: 0,
    durationMs: SAPPER_REVEAL_RAMP_DURATION_MS,
    compute: (elapsed) => {
      const t = elapsed / SAPPER_REVEAL_RAMP_DURATION_MS;
      const envelope = Math.sin(t * Math.PI);
      const pulse =
        0.5 +
        0.5 * Math.sin((elapsed / SAPPER_REVEAL_PULSE_PERIOD_MS) * Math.PI * 2);
      return SAPPER_REVEAL_PEAK_INTENSITY * envelope * pulse;
    },
  });
}
