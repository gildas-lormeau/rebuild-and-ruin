/**
 * Shared math for the unified wall-destruction animation. Two timing
 * sources feed it: revealTimeMs (decay-cause, banner-aware via the
 * runtime derive) and per-tile entry age (impact-cause). Same curve
 * either way — sink + dust + tail-fade, with debris pinned visible
 * underneath the held mesh — so cannonball, grunt read identically.
 */

import { WALL_DESTROY_ANIM_DURATION_MS } from "../../shared/core/game-constants.ts";
import { TILE_SIZE } from "../../shared/core/grid.ts";

interface WallDestroyAnim {
  /** World-units the held wall is translated DOWN by. 0 during the
   *  banner snapshot; eased ramp from 0 to `WALL_DESTROY_SINK_DROP`
   *  during animation; held at full drop through the post-anim bridge. */
  readonly sinkOffset: number;
  /** Held wall material alpha multiplier in [0, 1]. 1 during snapshot
   *  + most of the animation; tail-fades to 0 in the last fraction of
   *  the window; 0 through the bridge. */
  readonly wallOpacity: number;
  /** Dust puff alpha multiplier in [0, 1]. Quick ramp-up to peak,
   *  longer ramp-down, 0 through the bridge. */
  readonly dustOpacity: number;
  /** Debris alpha multiplier in [0, 1]. Pinned to 1 for the entire
   *  window so the rubble is present under the held mesh from frame 0
   *  — otherwise the sinking wall would briefly reveal the bare ground
   *  tile (grass) before debris faded in. The held wall is fully
   *  opaque until `TAIL_FADE_START`, so the debris underneath is
   *  occluded until the wall begins tail-fading and then hands off. */
  readonly debrisOpacity: number;
}

/** Fraction of the window where the wall opacity stays at 1. After
 *  this, the held mesh ramps to 0 in the remaining window — the
 *  "tail-clean" pass that hides the stub still poking out of terrain
 *  once the sink completes. */
const TAIL_FADE_START = 0.75;
/** Dust puff opacity peak. Curve is a quick ramp-up to peak then a
 *  longer ramp-down, ending well before the visual closes. */
const DUST_PEAK = 0.55;
const DUST_RAMP_UP = 0.1;
const DUST_END = 0.85;
const SNAPSHOT: WallDestroyAnim = {
  sinkOffset: 0,
  wallOpacity: 1,
  dustOpacity: 0,
  debrisOpacity: 1,
};
/** World-units the held wall descends over the animation window. The
 *  wall body's authored top sits at ~26 world units (3.22 sprite units
 *  × `TILE_SIZE / 2` scale; see `elevation.ts`); dropping by `TILE_SIZE
 *  * 1.6 = 25.6` lands the body's top right at the ground plane by the
 *  end so the fall reads as fully buried. */
const WALL_DESTROY_SINK_DROP = TILE_SIZE * 1.6;
const BRIDGE: WallDestroyAnim = {
  sinkOffset: WALL_DESTROY_SINK_DROP,
  wallOpacity: 0,
  dustOpacity: 0,
  debrisOpacity: 1,
};

/** Multipliers at a given progress time (ms). `<= 0` returns the
 *  snapshot state (held visible, no movement); `>= DURATION` returns
 *  the bridge state (debris held at 1, everything else 0). Used by
 *  both the runtime derive (revealTimeMs input, decay-cause) and the
 *  per-tile renderers (entry age input, impact-cause). */
export function wallDestroyAnimAt(progressMs: number): WallDestroyAnim {
  if (progressMs <= 0) return SNAPSHOT;
  if (progressMs >= WALL_DESTROY_ANIM_DURATION_MS) return BRIDGE;
  const progress = progressMs / WALL_DESTROY_ANIM_DURATION_MS;
  return {
    sinkOffset: easeInQuad(progress) * WALL_DESTROY_SINK_DROP,
    wallOpacity: tailFade(progress),
    dustOpacity: dustCurve(progress),
    debrisOpacity: 1,
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
