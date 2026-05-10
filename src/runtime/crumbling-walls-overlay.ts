/**
 * Crumbling-walls reveal animation derive. Outputs the per-frame
 * multipliers (sink + opacities) the held wall, dust puff, and debris
 * cross-fade-in consume. Three phases driven by `revealTimeMs` only
 * (the lone banner-aware boundary): banner-snapshot (static),
 * animating, post-fade bridge (debris held until BATTLE entry).
 */

import { TILE_SIZE } from "../shared/core/grid.ts";
import type { CrumblingWallsAnim } from "../shared/ui/overlay-types.ts";

/** Fraction of the window where the wall opacity stays at 1. After
 *  this, the held mesh ramps to 0 in the remaining window — the
 *  "tail-clean" pass that hides the stub still poking out of terrain
 *  once the sink completes. */
const TAIL_FADE_START = 0.75;
/** Window over which the debris cross-fades in underneath the sinking
 *  wall, expressed as `[startProgress, endProgress]`. The ramp reaches
 *  full opacity well before the wall's tail-fade so the rubble is
 *  established by the time the held mesh disappears. */
const DEBRIS_FADE_START = 0.3;
const DEBRIS_FADE_END = 0.85;
/** Dust puff opacity peak. Curve is a quick ramp-up to peak then a
 *  longer ramp-down, ending well before the visual closes. */
const DUST_PEAK = 0.55;
/** Fraction of window over which dust ramps up to peak. */
const DUST_RAMP_UP = 0.1;
/** Fraction of window where dust returns to 0. */
const DUST_END = 0.85;
/** Total duration of the sink + tail-fade window (ms). Sized to read
 *  as a real collapse — long enough to land the motion + dust, short
 *  enough not to delay battle entry. */
const CRUMBLING_WALLS_DURATION_MS = 1200;
/** World-units the held wall descends over the animation window. The
 *  wall body's authored top sits at ~26 world units (3.22 sprite units
 *  × `TILE_SIZE / 2` scale; see `elevation.ts`); dropping by `TILE_SIZE
 *  * 1.6 = 25.6` lands the body's top right at the ground plane by the
 *  end so the fall reads as fully buried. */
const CRUMBLING_WALLS_SINK_DROP = TILE_SIZE * 1.6;

export function deriveCrumblingWallsAnim(
  revealTimeMs: number | undefined,
): CrumblingWallsAnim | undefined {
  if (revealTimeMs === undefined) return undefined;
  if (revealTimeMs <= 0) {
    // Banner-snapshot: held walls visible, nothing has moved yet.
    return {
      sinkOffset: 0,
      wallOpacity: 1,
      dustOpacity: 0,
      debrisOpacity: 0,
    };
  }
  if (revealTimeMs >= CRUMBLING_WALLS_DURATION_MS) {
    // Post-fade bridge: wall buried + faded; debris held at full
    // opacity until BATTLE entry takes over via `battleWalls`.
    return {
      sinkOffset: CRUMBLING_WALLS_SINK_DROP,
      wallOpacity: 0,
      dustOpacity: 0,
      debrisOpacity: 1,
    };
  }
  const progress = revealTimeMs / CRUMBLING_WALLS_DURATION_MS;
  return {
    sinkOffset: easeInQuad(progress) * CRUMBLING_WALLS_SINK_DROP,
    wallOpacity: tailFade(progress),
    dustOpacity: dustCurve(progress),
    debrisOpacity: debrisFade(progress),
  };
}

function easeInQuad(progress: number): number {
  return progress * progress;
}

function tailFade(progress: number): number {
  if (progress < TAIL_FADE_START) return 1;
  return 1 - (progress - TAIL_FADE_START) / (1 - TAIL_FADE_START);
}

function dustCurve(progress: number): number {
  if (progress < DUST_RAMP_UP) return (progress / DUST_RAMP_UP) * DUST_PEAK;
  if (progress > DUST_END) return 0;
  return (
    DUST_PEAK * (1 - (progress - DUST_RAMP_UP) / (DUST_END - DUST_RAMP_UP))
  );
}

function debrisFade(progress: number): number {
  if (progress < DEBRIS_FADE_START) return 0;
  if (progress > DEBRIS_FADE_END) return 1;
  return (progress - DEBRIS_FADE_START) / (DEBRIS_FADE_END - DEBRIS_FADE_START);
}
