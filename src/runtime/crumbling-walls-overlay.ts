/**
 * Crumbling-walls reveal animation derive — banner-aware wrapper
 * around the shared per-progress math in `wall-destroy-anim.ts`.
 * Maps `revealTimeFor()`'s output to the shared progress timeline so
 * the modifier-reveal flow gets the same sink + dust + tail-fade
 * curve impact destructions use, just driven by the global
 * revealTimeMs instead of per-tile age.
 */

import {
  type WallDestroyAnim,
  wallDestroyAnimAt,
} from "../shared/core/wall-destroy-anim.ts";

export function deriveCrumblingWallsAnim(
  revealTimeMs: number | undefined,
): WallDestroyAnim | undefined {
  if (revealTimeMs === undefined) return undefined;
  return wallDestroyAnimAt(revealTimeMs);
}
