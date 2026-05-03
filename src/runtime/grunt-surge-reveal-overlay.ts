/**
 * Grunt-surge tint intensity — runtime-side overlay derivation.
 * Lands in `overlay.battle.gruntSurgeRevealIntensity`; the grunt
 * manager lerps fresh-surge-grunt material color toward red by this
 * multiplier (per-instance via `attachInstanceTint`).
 *
 * Replaces the legacy per-tile spawn-burst — the actual fresh grunts
 * pulse red instead of standing in with floating discs.
 *
 * Curve: bell envelope `sin(t * π)` modulated by a fast pulse wave
 * (same shape as sapper's threat tint). State machine + sweep gating
 * live in `deriveModifierRamp`.
 */

import { MODIFIER_ID } from "../shared/core/game-constants.ts";
import type { RenderView } from "../shared/core/render-view.ts";
import {
  deriveModifierRamp,
  type ModifierRampContext,
} from "./modifier-reveal-ramp.ts";
import type { ActiveBannerState } from "./runtime-contracts.ts";

interface GruntSurgeRevealRampState {
  gruntSurgeRevealRampStartMs: number | undefined;
}

interface DeriveInput extends ModifierRampContext {
  readonly view: Pick<RenderView, "phase" | "modern">;
  readonly banner: ActiveBannerState | { status: "hidden" };
  readonly now: number;
  readonly state: GruntSurgeRevealRampState;
}

export const GRUNT_SURGE_REVEAL_RAMP_DURATION_MS = 1100;
export const GRUNT_SURGE_REVEAL_PULSE_PERIOD_MS = 280;
/** Peak tint mix at the bell's apex; lower values = subtler tint. */
export const GRUNT_SURGE_REVEAL_PEAK_INTENSITY = 0.85;

export function deriveGruntSurgeRevealIntensity(
  input: DeriveInput,
): number | undefined {
  return deriveModifierRamp(input, {
    modifierId: MODIFIER_ID.GRUNT_SURGE,
    getRampStartMs: () => input.state.gruntSurgeRevealRampStartMs,
    setRampStartMs: (value) => {
      input.state.gruntSurgeRevealRampStartMs = value;
    },
    sweepValue: 0,
    durationMs: GRUNT_SURGE_REVEAL_RAMP_DURATION_MS,
    compute: (elapsed) => {
      const t = elapsed / GRUNT_SURGE_REVEAL_RAMP_DURATION_MS;
      const envelope = Math.sin(t * Math.PI);
      const pulse =
        0.5 +
        0.5 *
          Math.sin(
            (elapsed / GRUNT_SURGE_REVEAL_PULSE_PERIOD_MS) * Math.PI * 2,
          );
      return GRUNT_SURGE_REVEAL_PEAK_INTENSITY * envelope * pulse;
    },
  });
}
