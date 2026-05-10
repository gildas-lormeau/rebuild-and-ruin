/**
 * Shared math for the unified wall-destruction animation. Two timing
 * sources feed it: revealTimeMs (decay-cause, banner-aware via the
 * runtime derive) and per-tile entry age (impact-cause). Same curve
 * either way — sink + dust + tail-fade + debris cross-fade-in — so
 * cannonball, grunt, and crumbling destructions read identically.
 */

import { TILE_SIZE } from "./grid.ts";

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
  /** Debris cross-fade-in alpha multiplier in [0, 1]. 0 during snapshot
   *  + the early animation; ramps from 0 to 1 across the cross-fade
   *  window; 1 through the bridge so the rubble stays visible until
   *  the entry purges or BATTLE entry hands it off via `battleWalls`. */
  readonly debrisOpacity: number;
}

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
const DUST_RAMP_UP = 0.1;
const DUST_END = 0.85;
const SNAPSHOT: WallDestroyAnim = {
  sinkOffset: 0,
  wallOpacity: 1,
  dustOpacity: 0,
  debrisOpacity: 0,
};
/** Total duration of the sink + tail-fade window (ms). Punchy enough
 *  to read as an impact-driven collapse without slowing battle pace. */
const WALL_DESTROY_ANIM_DURATION_MS = 400;
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
/** Same as a number of seconds — used for the impact-entry lifetime in
 *  `ageImpacts` so the held-mesh + dust + debris-fade-in stay alive
 *  for the full visual window before the entry is purged. */
export const WALL_DESTROY_ANIM_DURATION = WALL_DESTROY_ANIM_DURATION_MS / 1000;

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
