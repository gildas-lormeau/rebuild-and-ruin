/**
 * Orthographic world camera for the 3D renderer.
 *
 * Coordinate system:
 *   - Origin at map top-left: world X ∈ [0, MAP_PX_W], world Z ∈ [0, MAP_PX_H].
 *   - Y is up; the ground plane lies at Y=0.
 *   - 1 world unit = 1 game-1× pixel. A tile is TILE_SIZE (16) units square.
 *   - Camera looks straight down (-Y) with `up = (0, 0, -1)` so that a smaller
 *     Z (world top of map) renders at the top of the screen. This matches the
 *     2D renderer's "map-top = screen-top" convention, so `Viewport.x/y/w/h`
 *     (from `runtime-camera.ts`) translate into camera params with no axis
 *     flips: `vp.x/y` = top-left of the visible world rectangle, `vp.w/h` =
 *     its size in world units.
 *
 * The camera's ortho frustum is centered on the look-at point with half-widths
 * `vp.w/2` (X) and `vp.h/2` (Z-as-vertical). `updateCameraFromViewport(null)`
 * shows the whole map, equivalent to `Viewport { x: 0, y: 0, w: MAP_PX_W,
 * h: MAP_PX_H }`.
 *
 * Tilt support was reverted alongside its runtime plumbing — this module
 * now only handles the straight-down ortho case. A future dedicated
 * refactor will reintroduce tilt with a cleaner animation path.
 */

import * as THREE from "three";
import type { Viewport } from "../../shared/core/geometry-types.ts";
import { MAP_PX_H, MAP_PX_W } from "../../shared/core/grid.ts";
import { pixelSnap } from "./pixel-snap.ts";

/** Altitude for the camera — far enough above the ground plane that entities
 *  (towers, balloons) will never clip the near plane. */
const CAMERA_ALTITUDE = 1000;
/** Half-depth of the ortho frustum in Y. Entities live around Y=0..~50. */
const CAMERA_DEPTH = 2000;
/** Re-usable scratch vector for the ground-plane pixel snap. Avoids a
 *  per-frame Vector3 alloc. */
const SNAP_SCRATCH = new THREE.Vector3();

/** Build a fresh ortho camera, initially sized to the full map. */
export function createMapCamera(): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(
    -MAP_PX_W / 2,
    MAP_PX_W / 2,
    MAP_PX_H / 2,
    -MAP_PX_H / 2,
    -CAMERA_DEPTH,
    CAMERA_DEPTH,
  );
  // Screen-up → world -Z so that smaller Z (map top) appears at the top of
  // the canvas, matching the 2D renderer's Y-down pixel convention.
  camera.up.set(0, 0, -1);
  camera.position.set(MAP_PX_W / 2, CAMERA_ALTITUDE, MAP_PX_H / 2);
  camera.lookAt(MAP_PX_W / 2, 0, MAP_PX_H / 2);
  camera.updateProjectionMatrix();
  return camera;
}

/** Point `camera` at the world rectangle described by `viewport` (in game-1×
 *  pixel units). `null`/`undefined` means "show the whole map".
 *
 *  Edge cases:
 *    - Zero-size viewport (w<=0 or h<=0) → fall back to full-map view. Avoids
 *      a degenerate frustum that three.js would reject.
 *    - Fully-off-map viewport → clamp the center to the map rectangle. The
 *      runtime camera already clamps normal cases; this is defence in depth.
 *    - Non-integer values → center is pixel-snapped to avoid sub-pixel jitter
 *      when the runtime camera lerps. Frustum extents are kept exact so the
 *      visible area matches the 2D renderer's `drawImage` crop byte-for-byte.
 */
export function updateCameraFromViewport(
  camera: THREE.OrthographicCamera,
  viewport: Viewport | null | undefined,
): void {
  const rect = normalizeViewport(viewport);

  const halfW = rect.w / 2;
  const halfH = rect.h / 2;

  camera.left = -halfW;
  camera.right = halfW;
  camera.top = halfH;
  camera.bottom = -halfH;

  const centerX = rect.x + halfW;
  const centerZ = rect.y + halfH;

  camera.position.set(centerX, CAMERA_ALTITUDE, centerZ);
  snapGroundPlaneComponents(camera.position);
  camera.up.set(0, 0, -1);
  camera.lookAt(centerX, 0, centerZ);
  camera.updateProjectionMatrix();
}

/** Clamp/normalize a Viewport (or null = full map) into a safe non-empty rect. */
function normalizeViewport(viewport: Viewport | null | undefined): Viewport {
  if (!viewport || viewport.w <= 0 || viewport.h <= 0) {
    return { x: 0, y: 0, w: MAP_PX_W, h: MAP_PX_H };
  }
  // Clamp the rectangle's center to the map bounds so an out-of-map viewport
  // still produces a valid look-at target. Size is preserved.
  const centerX = Math.max(0, Math.min(MAP_PX_W, viewport.x + viewport.w / 2));
  const centerZ = Math.max(0, Math.min(MAP_PX_H, viewport.y + viewport.h / 2));
  return {
    x: centerX - viewport.w / 2,
    y: centerZ - viewport.h / 2,
    w: viewport.w,
    h: viewport.h,
  };
}

/** Pixel-snap the X and Z components of a camera position while leaving Y
 *  exact. Re-uses a module-level scratch vector. Mutates `pos`. */
function snapGroundPlaneComponents(pos: THREE.Vector3): void {
  SNAP_SCRATCH.set(pos.x, 0, pos.z);
  pixelSnap(SNAP_SCRATCH);
  pos.x = SNAP_SCRATCH.x;
  pos.z = SNAP_SCRATCH.z;
}
