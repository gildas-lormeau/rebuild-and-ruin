/**
 * Pixel-snap helpers. 1 world unit = 1 game-1× pixel; integer world
 * coords + nearest-neighbor sampling give pixel-crisp output. Snap any
 * position derived from `Viewport` (camera, entity origins) to avoid
 * sub-pixel jitter; scale/rotation/sprite-internal geometry doesn't.
 */

import * as THREE from "three";

/** Round every component of `vec` to the nearest integer world unit (= pixel).
 *  Mutates and returns `vec` so callers can chain. */
export function pixelSnap(vec: THREE.Vector3): THREE.Vector3 {
  return vec.set(
    Math.round(vec.x),
    Math.round(vec.y),
    Math.round(vec.getComponent(2)),
  );
}
