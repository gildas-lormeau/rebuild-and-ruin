/**
 * Fog progressive-reveal opacity multiplier — runtime-side overlay
 * derivation. Computes the value the renderer applies to fog material
 * alpha during the `fog_of_war` modifier reveal. Lives runtime-side
 * (called from `refreshOverlay`) so it ticks in headless tests where
 * the renderer is a stub, and so the value lands in
 * `overlay.battle.fogRevealOpacity` for any consumer to observe.
 *
 * State machine (per call):
 *
 *   not in fog reveal     → undefined (no override; reset rampStart)
 *   reveal + sweeping     → REVEAL_FLOOR (snapshot captures fog faintly)
 *   reveal + swept, fresh → set rampStart=now; return REVEAL_FLOOR
 *   reveal + ramping      → linear ramp + damped sine wave
 *   reveal + ramp done    → undefined (release; manager renders at full)
 *
 * The wave on the ramp gives the reveal a rolling-in feel — multiple
 * swells converging on full opacity rather than a monotonic slider.
 *
 * Ramp duration sits inside the ~1.5s post-sweep dwell of the
 * MODIFIER_REVEAL_TIMER window so the curve always completes before
 * the phase advances.
 */

import { MODIFIER_ID } from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { RenderView } from "../shared/core/render-view.ts";
import type { ActiveBannerState } from "./runtime-contracts.ts";
import { wavedRamp } from "./waved-ramp.ts";

interface FogRevealRampState {
  /** When the ramp started (in `now()`-units), or undefined while
   *  pre-sweep / post-release. Mutated by this helper. */
  fogRevealRampStartMs: number | undefined;
}

interface DeriveInput {
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
export const FOG_REVEAL_WAVE_PERIOD_MS = 380;
/** Peak wave amplitude at t=0; shrinks linearly to 0 as t→1 so the
 *  curve converges on the linear ramp at the end. */
export const FOG_REVEAL_WAVE_PEAK_AMPLITUDE = 0.18;

export function deriveFogRevealOpacity(input: DeriveInput): number | undefined {
  const { view, banner, now, state } = input;

  const isFogReveal =
    view.phase === Phase.MODIFIER_REVEAL &&
    view.modern?.activeModifier === MODIFIER_ID.FOG_OF_WAR;

  if (!isFogReveal) {
    state.fogRevealRampStartMs = undefined;
    return undefined;
  }

  // "past sweep" includes both `swept` (still on screen, dwelling) AND
  // `hidden` (the banner's onDone callback may hideBanner immediately
  // after sweep — phase stays MODIFIER_REVEAL, banner does not).
  const sweeping = banner.status === "sweeping";
  if (sweeping) {
    state.fogRevealRampStartMs = undefined;
    return FOG_REVEAL_FLOOR;
  }

  if (state.fogRevealRampStartMs === undefined) {
    state.fogRevealRampStartMs = now;
  }

  const elapsed = now - state.fogRevealRampStartMs;
  if (elapsed >= FOG_REVEAL_RAMP_DURATION_MS) return undefined;

  return wavedRamp({
    elapsed,
    durationMs: FOG_REVEAL_RAMP_DURATION_MS,
    start: FOG_REVEAL_FLOOR,
    end: 1,
    wavePeriodMs: FOG_REVEAL_WAVE_PERIOD_MS,
    wavePeakAmplitude: FOG_REVEAL_WAVE_PEAK_AMPLITUDE,
  });
}
