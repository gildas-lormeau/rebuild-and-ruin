/**
 * Crumbling-walls fade-out multiplier — runtime-side overlay derivation.
 * Computes the value the renderer applies to held wall material alpha
 * during the `crumbling_walls` modifier reveal. Held wall tile keys
 * themselves come from `state.modern.crumblingWallsHeld`, captured by
 * `crumblingWallsImpl.apply` before the gameplay-state mutation.
 *
 * Same shape as `deriveRubbleClearingFade` (idempotent state machine
 * mutating `runtimeState.crumblingWallsRampStartMs`):
 *
 *   not in crumbling reveal  → undefined (release; held entries gone)
 *   reveal + sweeping        → 1 (snapshot captures walls at full)
 *   reveal + swept, fresh    → set rampStart=now; return 1
 *   reveal + ramping         → linear ramp 1 → 0 + damped sine wave
 *   reveal + ramp done       → undefined (release; manager stops
 *                                rendering held walls)
 *
 * The wave on the ramp gives the fade a "wall crumbling away" feel —
 * multiple swells converging on zero rather than a monotonic slider.
 */

import { MODIFIER_ID } from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { RenderView } from "../shared/core/render-view.ts";
import type { ActiveBannerState } from "./runtime-contracts.ts";
import { wavedRamp } from "./waved-ramp.ts";

interface CrumblingWallsRampState {
  /** When the ramp started (in `now()`-units), or undefined while
   *  pre-sweep / post-release. Mutated by this helper. */
  crumblingWallsRampStartMs: number | undefined;
}

interface DeriveInput {
  readonly view: Pick<RenderView, "phase" | "modern">;
  readonly banner: ActiveBannerState | { status: "hidden" };
  readonly now: number;
  /** Holder for cross-frame ramp-start state. Mutated. */
  readonly state: CrumblingWallsRampState;
}

/** Ramp duration after the banner sweep completes, in ms. */
export const CRUMBLING_WALLS_RAMP_DURATION_MS = 1100;
/** Wave period for the crumbling oscillation, in ms. */
export const CRUMBLING_WALLS_WAVE_PERIOD_MS = 320;
/** Peak wave amplitude at t=0; shrinks linearly to 0 as t→1 so the
 *  curve converges on zero at the end. */
export const CRUMBLING_WALLS_WAVE_PEAK_AMPLITUDE = 0.3;

export function deriveCrumblingWallsFade(
  input: DeriveInput,
): number | undefined {
  const { view, banner, now, state } = input;

  const isCrumblingWallsReveal =
    view.phase === Phase.MODIFIER_REVEAL &&
    view.modern?.activeModifier === MODIFIER_ID.CRUMBLING_WALLS;

  if (!isCrumblingWallsReveal) {
    state.crumblingWallsRampStartMs = undefined;
    return undefined;
  }

  const sweeping = banner.status === "sweeping";
  if (sweeping) {
    state.crumblingWallsRampStartMs = undefined;
    return 1;
  }

  if (state.crumblingWallsRampStartMs === undefined) {
    state.crumblingWallsRampStartMs = now;
  }

  const elapsed = now - state.crumblingWallsRampStartMs;
  if (elapsed >= CRUMBLING_WALLS_RAMP_DURATION_MS) return undefined;

  return wavedRamp({
    elapsed,
    durationMs: CRUMBLING_WALLS_RAMP_DURATION_MS,
    start: 1,
    end: 0,
    wavePeriodMs: CRUMBLING_WALLS_WAVE_PERIOD_MS,
    wavePeakAmplitude: CRUMBLING_WALLS_WAVE_PEAK_AMPLITUDE,
  });
}
