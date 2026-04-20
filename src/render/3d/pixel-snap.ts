/**
 * Pixel-snap helpers for the 3D world renderer.
 *
 * In the world-renderer coordinate system, 1 world unit = 1 game-1× pixel.
 * At the display scale (game-2×), 1 world unit therefore renders as 2 screen
 * pixels, so world coordinates that are whole integers produce pixel-crisp
 * output when textures use nearest-neighbor filtering (Phase 2 adds textures
 * and applies NearestFilter per-texture on load).
 *
 * Use `pixelSnap` for any position derived from the `Viewport` (camera
 * position, entity origins) to avoid sub-pixel jitter as the camera lerps.
 * Scales, rotations, and sprite-internal geometry don't need snapping —
 * their quantization happens at texture sampling time.
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
