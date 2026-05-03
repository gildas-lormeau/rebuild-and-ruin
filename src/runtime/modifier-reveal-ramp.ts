/**
 * Shared state machine for runtime-side modifier-reveal multipliers.
 *
 * Every overlay-driven modifier reveal (fog, rubble_clearing, frostbite,
 * crumbling_walls, sapper, ...) computes a per-frame `[0, 1]` value
 * with the same idempotent shape:
 *
 *   not in this modifier's reveal → undefined (release; clear ramp)
 *   reveal + sweeping             → sweepValue (snapshot capture)
 *   reveal + swept, fresh         → set rampStart=now; return cfg.compute(0)
 *                                   (or sweepValue at t=0 if compute(0) ≠ that)
 *   reveal + ramping              → cfg.compute(elapsed)
 *   reveal + ramp done            → undefined (release; manager pins or
 *                                   falls back to its steady-state path)
 *
 * Per-modifier files now hold just (modifierId, sweepValue, durationMs,
 * compute, rampStart accessor pair) and delegate the gating to this
 * helper. The accessor pair is two closures rather than a key+state
 * pattern so the cross-frame ramp-start field stays strongly typed on
 * RuntimeState.
 */

import type { ModifierId } from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { RenderView } from "../shared/core/render-view.ts";
import type { ActiveBannerState } from "./runtime-contracts.ts";

/** Ambient inputs every per-modifier derive function gets from
 *  `refreshOverlay` — same shape across all five overlays. */
export interface ModifierRampContext {
  readonly view: Pick<RenderView, "phase" | "modern">;
  readonly banner: ActiveBannerState | { status: "hidden" };
  readonly now: number;
}

interface ModifierRampConfig {
  readonly modifierId: ModifierId;
  /** Read the cross-frame ramp-start timestamp (in `now()`-units). */
  readonly getRampStartMs: () => number | undefined;
  /** Mutate the cross-frame ramp-start timestamp (undefined to clear). */
  readonly setRampStartMs: (value: number | undefined) => void;
  /** Value returned during the banner-sweep window (snapshot capture). */
  readonly sweepValue: number;
  /** Total ramp duration in ms; helper releases (returns undefined) once
   *  `now - rampStart >= durationMs`. */
  readonly durationMs: number;
  /** Curve evaluated each post-sweep frame. Receives `elapsed` in ms
   *  measured from the first post-sweep frame. */
  readonly compute: (elapsed: number) => number;
}

export function deriveModifierRamp(
  ctx: ModifierRampContext,
  cfg: ModifierRampConfig,
): number | undefined {
  const isReveal =
    ctx.view.phase === Phase.MODIFIER_REVEAL &&
    ctx.view.modern?.activeModifier === cfg.modifierId;

  if (!isReveal) {
    cfg.setRampStartMs(undefined);
    return undefined;
  }

  // "past sweep" includes both `swept` (still on screen, dwelling) AND
  // `hidden` (the banner's onDone callback may hideBanner immediately
  // after sweep — phase stays MODIFIER_REVEAL, banner does not).
  if (ctx.banner.status === "sweeping") {
    cfg.setRampStartMs(undefined);
    return cfg.sweepValue;
  }

  let startMs = cfg.getRampStartMs();
  if (startMs === undefined) {
    startMs = ctx.now;
    cfg.setRampStartMs(startMs);
  }
  const elapsed = ctx.now - startMs;
  if (elapsed >= cfg.durationMs) return undefined;
  return cfg.compute(elapsed);
}
