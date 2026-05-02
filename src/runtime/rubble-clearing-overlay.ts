/**
 * Rubble-clearing fade-out multiplier — runtime-side overlay derivation.
 * Computes the value the renderer applies to held pit + dead-cannon
 * material alpha during the `rubble_clearing` modifier reveal. Held
 * entries themselves come from `state.modern.rubbleClearingHeld`,
 * captured by `rubbleClearingImpl.apply` before the gameplay-state
 * mutation.
 *
 * Same shape as `deriveFogRevealOpacity` (idempotent state machine
 * mutating `runtimeState.rubbleClearingRampStartMs`):
 *
 *   not in rubble reveal     → undefined (release; held entries gone)
 *   reveal + sweeping        → 1 (snapshot captures entities at full)
 *   reveal + swept, fresh    → set rampStart=now; return 1
 *   reveal + ramping         → linear ramp 1 → 0 + damped sine wave
 *   reveal + ramp done       → undefined (release; manager stops
 *                                rendering held entries)
 *
 * The wave on the ramp gives the fade a "rubble crumbling away" feel —
 * multiple swells converging on zero rather than a monotonic slider.
 */

import { MODIFIER_ID } from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { RenderView } from "../shared/core/render-view.ts";
import type { ActiveBannerState } from "./runtime-contracts.ts";
import { wavedRamp } from "./waved-ramp.ts";

interface RubbleClearingRampState {
  /** When the ramp started (in `now()`-units), or undefined while
   *  pre-sweep / post-release. Mutated by this helper. */
  rubbleClearingRampStartMs: number | undefined;
}

interface DeriveInput {
  readonly view: Pick<RenderView, "phase" | "modern">;
  readonly banner: ActiveBannerState | { status: "hidden" };
  readonly now: number;
  /** Holder for cross-frame ramp-start state. Mutated. */
  readonly state: RubbleClearingRampState;
}

/** Ramp duration after the banner sweep completes, in ms. */
export const RUBBLE_CLEARING_RAMP_DURATION_MS = 1100;
/** Wave period for the crumbling oscillation, in ms. */
export const RUBBLE_CLEARING_WAVE_PERIOD_MS = 320;
/** Peak wave amplitude at t=0; shrinks linearly to 0 as t→1 so the
 *  curve converges on zero at the end. Tuned to give a clearly-
 *  visible pulse — at this amplitude the wave occasionally clips
 *  against 0 / 1 at the extremes, which reads as the rubble
 *  briefly snapping back to full / fully gone rather than a soft
 *  drift. */
export const RUBBLE_CLEARING_WAVE_PEAK_AMPLITUDE = 0.3;

export function deriveRubbleClearingFade(
  input: DeriveInput,
): number | undefined {
  const { view, banner, now, state } = input;

  const isRubbleClearingReveal =
    view.phase === Phase.MODIFIER_REVEAL &&
    view.modern?.activeModifier === MODIFIER_ID.RUBBLE_CLEARING;

  if (!isRubbleClearingReveal) {
    state.rubbleClearingRampStartMs = undefined;
    return undefined;
  }

  const sweeping = banner.status === "sweeping";
  if (sweeping) {
    state.rubbleClearingRampStartMs = undefined;
    return 1;
  }

  if (state.rubbleClearingRampStartMs === undefined) {
    state.rubbleClearingRampStartMs = now;
  }

  const elapsed = now - state.rubbleClearingRampStartMs;
  if (elapsed >= RUBBLE_CLEARING_RAMP_DURATION_MS) return undefined;

  return wavedRamp({
    elapsed,
    durationMs: RUBBLE_CLEARING_RAMP_DURATION_MS,
    start: 1,
    end: 0,
    wavePeriodMs: RUBBLE_CLEARING_WAVE_PERIOD_MS,
    wavePeakAmplitude: RUBBLE_CLEARING_WAVE_PEAK_AMPLITUDE,
  });
}
