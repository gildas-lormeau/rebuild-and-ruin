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
 * Pitch support: `updateCameraFromViewport(camera, viewport, pitch)` tilts the
 * ortho camera around its look-at point on the world X-axis. Pitch > 0 leans
 * the camera back so far-map rows (small Z) compress toward the top of the
 * screen, matching the classic Rampart 3/4 view. Under tilt the frustum's Y
 * extent foreshortens by cos(pitch); the X extent is unchanged (tilt is
 * X-only, no yaw/roll, so the visible ground stays an axis-aligned rect). The
 * math mirrors `src/runtime/camera-projection.ts`, so screen↔world round-trips
 * in the runtime line up with what the 3D renderer draws.
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
 *  pixel units). `null`/`undefined` means "show the whole map". `pitch` in
 *  radians tilts the camera around the look-at point on the world X-axis;
 *  defaults to 0 (straight-down ortho — original behaviour).
 *
 *  Edge cases:
 *    - Zero-size viewport (w<=0 or h<=0) → fall back to full-map view. Avoids
 *      a degenerate frustum that three.js would reject.
 *    - Fully-off-map viewport → clamp the center to the map rectangle. The
 *      runtime camera already clamps normal cases; this is defence in depth.
 *    - Non-integer values → X/Z position is pixel-snapped to avoid sub-pixel
 *      jitter when the runtime camera lerps. Y position (altitude) and
 *      frustum extents are kept exact so the visible area stays byte-aligned
 *      with the 2D crop at pitch=0.
 */
export function updateCameraFromViewport(
  camera: THREE.OrthographicCamera,
  viewport: Viewport | null | undefined,
  pitch: number = 0,
): void {
  const rect = normalizeViewport(viewport);

  const halfW = rect.w / 2;
  const halfH = rect.h / 2;
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);

  // Under X-axis tilt the visible ground rect's Y extent foreshortens by
  // cos(pitch), so shrink the frustum top/bottom by the same factor. The X
  // extent is unchanged — tilt is X-only, no yaw/roll.
  camera.left = -halfW;
  camera.right = halfW;
  camera.top = halfH * cosP;
  camera.bottom = -halfH * cosP;

  const centerX = rect.x + halfW;
  const centerZ = rect.y + halfH;

  // Rotate the camera offset (0, CAMERA_ALTITUDE, 0) around the world X-axis
  // through `pitch`, anchored at the ground look-at point. The look-at stays
  // on the ground plane at (centerX, 0, centerZ).
  camera.position.set(
    centerX,
    CAMERA_ALTITUDE * cosP,
    centerZ + CAMERA_ALTITUDE * sinP,
  );
  snapGroundPlaneComponents(camera.position);
  // Up-vector rotates with the camera: R_x(pitch) · (0, 0, -1) = (0, sin, -cos).
  camera.up.set(0, sinP, -cosP);
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
