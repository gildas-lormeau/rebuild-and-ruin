/**
 * Fog progressive reveal — drives `FogManager.setRevealOpacity` so the
 * `fog_of_war` modifier appears in the world gradually instead of
 * snapping in with the banner sweep.
 *
 * This file owns no meshes — it's a pure orchestrator. The fog manager
 * (`fog.ts`) handles all rendering; this effect only watches the
 * modifier-reveal flag + banner state and ramps fog opacity through
 * three lifecycle phases:
 *
 *   1. Capture: when `modifierReveal.paletteKey === "fog_of_war"` is
 *      first detected, set the multiplier to a low floor so the
 *      `newScene` snapshot captures fog at a faint, visible level.
 *      The banner sweep then reveals "fog appearing faintly" instead
 *      of either no change or an instant snap to full.
 *
 *   2. Hold: while the banner sweep runs (`!banner.swept`), the
 *      multiplier stays at the floor — only the snapshot value
 *      matters during the sweep, the live scene is hidden behind it.
 *
 *   3. Ramp: once `banner.swept`, ramp the multiplier from the floor
 *      up to 1.0 over RAMP_DURATION_MS. When the ramp completes the
 *      effect releases (multiplier set back to 1) and the manager
 *      renders normally for the rest of the round.
 *
 * If the modifier flag turns off mid-cycle (phase change, banner
 * cancellation), the effect immediately releases the multiplier so
 * the manager snaps back to its default state.
 */

import type { FrameCtx } from "../frame-ctx.ts";
import { type EffectManager } from "./fire-burst.ts";
import type { FogManager } from "./fog.ts";

const PALETTE_KEY = "fog_of_war";
/** Multiplier value held during snapshot + sweep. Low enough to read as
 *  "fog faintly appearing" and not snap to full, but visible enough
 *  that the banner sweep reveals something rather than nothing. */
const REVEAL_FLOOR = 0.2;
/** Ramp duration after the banner sweep completes, in ms. Sized to
 *  comfortably fit inside the ~1.5s post-sweep dwell of the
 *  `MODIFIER_REVEAL_TIMER` window. */
const RAMP_DURATION_MS = 800;

export function createFogRevealManager(fog: FogManager): EffectManager {
  let lastPaletteKey: string | undefined;
  let rampStartMs: number | undefined;

  function release(): void {
    fog.setRevealOpacity(1);
    rampStartMs = undefined;
  }

  function update(ctx: FrameCtx): void {
    const reveal = ctx.overlay?.ui?.modifierReveal;
    const banner = ctx.overlay?.ui?.banner;

    if (reveal?.paletteKey !== PALETTE_KEY) {
      if (lastPaletteKey === PALETTE_KEY) release();
      lastPaletteKey = reveal?.paletteKey;
      return;
    }

    const isFirstFrame = lastPaletteKey !== PALETTE_KEY;
    lastPaletteKey = PALETTE_KEY;

    if (isFirstFrame) {
      // Snapshot capture happens within the same frame as the first
      // detection (refreshOverlay → effects update → render to FBO),
      // so setting the multiplier here writes into the snapshot.
      fog.setRevealOpacity(REVEAL_FLOOR);
    }

    if (!(banner?.swept ?? true)) return;

    if (rampStartMs === undefined) rampStartMs = ctx.now;

    const elapsed = ctx.now - rampStartMs;
    if (elapsed >= RAMP_DURATION_MS) {
      release();
      return;
    }

    const t = elapsed / RAMP_DURATION_MS;
    fog.setRevealOpacity(REVEAL_FLOOR + (1 - REVEAL_FLOOR) * t);
  }

  function dispose(): void {
    release();
  }

  return { update, dispose };
}
