/**
 * Frostbite-reveal tint multiplier — runtime-side overlay derivation.
 * Computes a `[0, 1]` intensity the renderer applies to grunt material
 * colors during the `frostbite` modifier reveal: 0 = authored color,
 * 1 = full frostbite tint. Mirrors `deriveFogRevealOpacity`.
 *
 *   not in frostbite reveal  → undefined (release; grunt manager
 *                              falls back to the binary frostbite flag)
 *   reveal + sweeping        → FLOOR (snapshot captures grunts already
 *                              faintly cooling)
 *   reveal + swept, fresh    → set rampStart=now; return FLOOR
 *   reveal + ramping         → linear ramp FLOOR → 1 + damped sine wave
 *   reveal + ramp done       → undefined (release; manager pins to 1
 *                              for the rest of the round via the flag)
 */

import { MODIFIER_ID } from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { RenderView } from "../shared/core/render-view.ts";
import type { ActiveBannerState } from "./runtime-contracts.ts";
import { wavedRamp } from "./waved-ramp.ts";

interface FrostbiteRevealRampState {
  /** When the ramp started (in `now()`-units), or undefined while
   *  pre-sweep / post-release. Mutated by this helper. */
  frostbiteRevealRampStartMs: number | undefined;
}

interface DeriveInput {
  readonly view: Pick<RenderView, "phase" | "modern">;
  readonly banner: ActiveBannerState | { status: "hidden" };
  readonly now: number;
  readonly state: FrostbiteRevealRampState;
}

/** Intensity held during snapshot + sweep. Low enough to read as
 *  "grunts faintly cooling" but visible so the banner sweep reveals
 *  something rather than nothing. */
export const FROSTBITE_REVEAL_FLOOR = 0.2;
/** Ramp duration after the banner sweep completes, in ms. */
export const FROSTBITE_REVEAL_RAMP_DURATION_MS = 1100;
/** Wave period for the freezing-in oscillation, in ms. */
export const FROSTBITE_REVEAL_WAVE_PERIOD_MS = 320;
/** Peak wave amplitude at t=0; shrinks linearly to 0 as t→1. */
export const FROSTBITE_REVEAL_WAVE_PEAK_AMPLITUDE = 0.3;

export function deriveFrostbiteRevealProgress(
  input: DeriveInput,
): number | undefined {
  const { view, banner, now, state } = input;

  const isFrostbiteReveal =
    view.phase === Phase.MODIFIER_REVEAL &&
    view.modern?.activeModifier === MODIFIER_ID.FROSTBITE;

  if (!isFrostbiteReveal) {
    state.frostbiteRevealRampStartMs = undefined;
    return undefined;
  }

  const sweeping = banner.status === "sweeping";
  if (sweeping) {
    state.frostbiteRevealRampStartMs = undefined;
    return FROSTBITE_REVEAL_FLOOR;
  }

  if (state.frostbiteRevealRampStartMs === undefined) {
    state.frostbiteRevealRampStartMs = now;
  }

  const elapsed = now - state.frostbiteRevealRampStartMs;
  if (elapsed >= FROSTBITE_REVEAL_RAMP_DURATION_MS) return undefined;

  return wavedRamp({
    elapsed,
    durationMs: FROSTBITE_REVEAL_RAMP_DURATION_MS,
    start: FROSTBITE_REVEAL_FLOOR,
    end: 1,
    wavePeriodMs: FROSTBITE_REVEAL_WAVE_PERIOD_MS,
    wavePeakAmplitude: FROSTBITE_REVEAL_WAVE_PEAK_AMPLITUDE,
  });
}
