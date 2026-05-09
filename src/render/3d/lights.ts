/**
 * Scene lighting. `blend ∈ [0,1]` (from camera pitch) lerps between flat
 * (high ambient, no shadows, preserves palette) and battle-tilt (lower
 * ambient, shadows on, sun direction from `sunT ∈ [0,1]` sweeping
 * dawn→zenith→dusk). `setSunBlend` and `updateSunDirection` are pure —
 * peers at the same pitch + sunT see identical lighting (parity-safe).
 */

import * as THREE from "three";
import { MAP_PX_H, MAP_PX_W } from "../../shared/core/grid.ts";

interface WorldLights {
  readonly ambient: THREE.AmbientLight;
  readonly sun: THREE.DirectionalLight;
}

/** Distance from the sun to the map center along the sun-direction
 *  vector. Doesn't change the directional light's parallel rays; only
 *  affects where the orthographic shadow camera sits along that
 *  direction. */
const SUN_DISTANCE = 1000;
/** Half-extents of the shadow camera's orthographic frustum. Sized to
 *  comfortably cover the whole map plus the long shadows cast when the
 *  sun is near the horizon (battle start / battle end). */
const SHADOW_HALF_W = MAP_PX_W;
const SHADOW_HALF_H = MAP_PX_H;
/** Shadow map resolution. 1024 is the mobile-friendly sweet spot for
 *  this map size. */
const SHADOW_MAP_SIZE = 1024;
/** Ambient intensity when the sun is active during battle. Reduced
 *  from the inactive 1.0 so the directional contribution can produce
 *  visible shadow contrast. */
const ACTIVE_AMBIENT = 0.7;
/** Directional intensity when the sun is active during battle. */
const ACTIVE_SUN = 0.6;
/** Inactive intensities — match the prior "no shadows" lighting so
 *  non-battle phases look identical to before this feature landed. */
const INACTIVE_AMBIENT = 1.0;
const INACTIVE_SUN = 0.2;
/** Sun direction vector when the rig is fully inactive (camera flat,
 *  no shadows). Matches the pre-feature directional position so non-
 *  battle phases retain the original side-shading on tall entities,
 *  with the sun coming from upper-left-back. `updateSunDirection`
 *  lerps from this toward the battle-arc direction as the camera
 *  tilts in, and back to it as the camera tilts out — no snap at the
 *  battle phase boundary. */
const INACTIVE_SUN_DIRECTION = { x: -0.6, y: 1, z: -0.4 } as const;
/** Peak opacity of the ground shadow overlay when the sun is fully
 *  active. The renderer scales this by the same blend factor so
 *  shadow darkness fades in lockstep with the lighting. Exposed so
 *  the overlay's authored opacity stays a single source of truth. */
export const SHADOW_OVERLAY_PEAK_OPACITY = 0.45;

export function createWorldLights(): WorldLights {
  const ambient = new THREE.AmbientLight(0xffffff, INACTIVE_AMBIENT);

  // Directional sun. Shadow camera + bias settings live here; intensity
  // and shadow casting are blended each frame by `setSunBlend`.
  const sun = new THREE.DirectionalLight(0xffffff, INACTIVE_SUN);
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  sun.shadow.camera.left = -SHADOW_HALF_W;
  sun.shadow.camera.right = SHADOW_HALF_W;
  sun.shadow.camera.top = SHADOW_HALF_H;
  sun.shadow.camera.bottom = -SHADOW_HALF_H;
  sun.shadow.camera.near = 0;
  sun.shadow.camera.far = SUN_DISTANCE * 2;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.5;

  // Anchor the sun's target at the map center so changes to the sun's
  // position rotate the light direction around the map center, not the
  // world origin. The target must be added to the scene by the caller
  // for three.js to update its world matrix.
  sun.target.position.set(MAP_PX_W / 2, 0, MAP_PX_H / 2);

  // Default to the inactive stance — `setSunBlend` lerps this on as
  // the camera tilts into the 3D battle view. Initial position uses
  // `INACTIVE_SUN_DIRECTION` (preserves the pre-feature side-shading
  // on tall entities); `updateSunDirection` lerps it toward the
  // battle arc as the camera tilts in, and back to it as the camera
  // tilts out, so non-battle phases never inherit a stale battle-end
  // direction.
  sun.castShadow = false;
  positionSun(
    sun,
    INACTIVE_SUN_DIRECTION.x,
    INACTIVE_SUN_DIRECTION.y,
    INACTIVE_SUN_DIRECTION.z,
  );

  return { ambient, sun };
}

/** Blend the sun rig between inactive (factor = 0, non-battle look)
 *  and fully active (factor = 1, peak shadow contrast). Continuous so
 *  the renderer can smoothly fade lighting + shadows in/out around the
 *  battle phase boundaries instead of popping. `castShadow` flips off
 *  only at factor === 0 — any non-zero blend keeps the shadow map
 *  rendering so the ground overlay's per-pixel opacity can darken
 *  partial shadows correctly. */
export function setSunBlend(
  ambient: THREE.AmbientLight,
  sun: THREE.DirectionalLight,
  factor: number,
): void {
  const blend = Math.min(Math.max(factor, 0), 1);
  ambient.intensity =
    INACTIVE_AMBIENT + (ACTIVE_AMBIENT - INACTIVE_AMBIENT) * blend;
  sun.intensity = INACTIVE_SUN + (ACTIVE_SUN - INACTIVE_SUN) * blend;
  sun.castShadow = blend > 0;
}

/** Position the sun for the current frame as a lerp between the
 *  inactive direction (camera flat, no shadows) and the battle-arc
 *  direction `sunDirectionFromT(sunT)` (camera fully tilted into the
 *  3D view). The lerp factor is `blend`, which the renderer derives
 *  from camera pitch — so the sun direction smoothly transitions
 *  alongside the tilt animation, with no snap at the BATTLE phase
 *  boundary. When `sunT` is `undefined` (every non-battle phase) the
 *  direction collapses to the inactive position regardless of blend.
 *
 *  Pure function of inputs (no `now`, no RNG, no per-peer state) so
 *  two peers on the same camera pitch + battle timer see identical
 *  lighting — parity-safe. */
export function updateSunDirection(
  sun: THREE.DirectionalLight,
  sunT: number | undefined,
  blend: number,
): void {
  const inactive = INACTIVE_SUN_DIRECTION;
  if (sunT === undefined) {
    positionSun(sun, inactive.x, inactive.y, inactive.z);
    return;
  }
  const active = sunDirectionFromT(sunT);
  const t = Math.min(Math.max(blend, 0), 1);
  positionSun(
    sun,
    inactive.x + (active.x - inactive.x) * t,
    inactive.y + (active.y - inactive.y) * t,
    inactive.z + (active.z - inactive.z) * t,
  );
}

/** Unit-ish (un-normalized) direction vector from the map center to
 *  the sun for the given `t ∈ [0, 1]`. Exposed so the light-debug
 *  visualizer can sample the same path the runtime uses, without
 *  duplicating the parameterization.
 *
 *  Shadow-length tradeoff drives the elevation floor: walls are ~26 px
 *  tall and tower geometry ~32 px. Shadow length is `height /
 *  tan(elevation)`. With floor = 0.3 (asin ≈ 16°) shadows reached 5+
 *  tiles at the horizons, which read as "exaggerated time-lapse" on a
 *  10s battle. Floor = 0.85 (combined with X amplitude ±1 and Z bias
 *  −0.25) puts the actual elevation at ~40° at the horizons, capping
 *  shadows around 2 tiles for towers and 1.5 tiles for walls. */
export function sunDirectionFromT(t: number): {
  x: number;
  y: number;
  z: number;
} {
  const clampedT = Math.min(Math.max(t, 0), 1);
  // Azimuth: π at t=0 (sun visible at -X), 0 at t=1 (sun at +X).
  const azimuth = Math.PI * (1 - clampedT);
  // Elevation: 0.85 at the horizons, 1.55 at the zenith. `sin(t·π)` is
  // the natural arc shape; the floor is what we tune for shadow
  // length.
  const elevation = 0.85 + 0.7 * Math.sin(clampedT * Math.PI);
  // Mild Z bias so even at noon shadows lean slightly down-screen
  // (pure overhead light reads as "no shadow" — kills depth cues).
  return { x: Math.cos(azimuth), y: elevation, z: -0.25 };
}

function positionSun(
  sun: THREE.DirectionalLight,
  dirX: number,
  dirY: number,
  dirZ: number,
): void {
  const length = Math.hypot(dirX, dirY, dirZ);
  const target = sun.target.position;
  sun.position.set(
    target.x + (dirX / length) * SUN_DISTANCE,
    target.y + (dirY / length) * SUN_DISTANCE,
    target.z + (dirZ / length) * SUN_DISTANCE,
  );
}
