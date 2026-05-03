/**
 * Sapper-reveal tint intensity — runtime-side overlay derivation.
 * Drives the per-instance copper tint applied to targeted walls in
 * the walls manager during the `sapper` modifier reveal.
 *
 * Replaces the per-tile disc burst — instead of standing in for the
 * walls with floating discs, the actual wall meshes pulse copper.
 *
 * Curve: bell envelope (sin(t * π)) modulated by a fast pulse wave so
 * the targeted walls flash a few times within a smooth peak-and-fade
 * window. Matches the alarm-like cadence of the legacy disc bursts.
 */

import { MODIFIER_ID } from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { RenderView } from "../shared/core/render-view.ts";
import type { ActiveBannerState } from "./runtime-contracts.ts";

interface SapperRevealRampState {
  sapperRevealRampStartMs: number | undefined;
}

interface DeriveInput {
  readonly view: Pick<RenderView, "phase" | "modern">;
  readonly banner: ActiveBannerState | { status: "hidden" };
  readonly now: number;
  readonly state: SapperRevealRampState;
}

/** Total ramp duration in ms (matches the legacy disc-burst window). */
export const SAPPER_REVEAL_RAMP_DURATION_MS = 1100;
/** Pulse period in ms — controls how many flashes fit under the bell. */
export const SAPPER_REVEAL_PULSE_PERIOD_MS = 280;
/** Peak tint mix at the bell's apex; lower values = subtler tint. */
export const SAPPER_REVEAL_PEAK_INTENSITY = 0.85;

export function deriveSapperRevealIntensity(
  input: DeriveInput,
): number | undefined {
  const { view, banner, now, state } = input;

  const isSapperReveal =
    view.phase === Phase.MODIFIER_REVEAL &&
    view.modern?.activeModifier === MODIFIER_ID.SAPPER;

  if (!isSapperReveal) {
    state.sapperRevealRampStartMs = undefined;
    return undefined;
  }

  const sweeping = banner.status === "sweeping";
  if (sweeping) {
    state.sapperRevealRampStartMs = undefined;
    return 0;
  }

  if (state.sapperRevealRampStartMs === undefined) {
    state.sapperRevealRampStartMs = now;
  }

  const elapsed = now - state.sapperRevealRampStartMs;
  if (elapsed >= SAPPER_REVEAL_RAMP_DURATION_MS) return undefined;

  const t = elapsed / SAPPER_REVEAL_RAMP_DURATION_MS;
  const envelope = Math.sin(t * Math.PI);
  const pulse =
    0.5 +
    0.5 * Math.sin((elapsed / SAPPER_REVEAL_PULSE_PERIOD_MS) * Math.PI * 2);
  return SAPPER_REVEAL_PEAK_INTENSITY * envelope * pulse;
}
