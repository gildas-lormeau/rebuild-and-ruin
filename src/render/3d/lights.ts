/**
 * Scene lighting for the 3D world renderer.
 *
 * Palette-tuned for the sprite designs' muted-stone / warm-grass look
 * (see `src/render/3d/sprites/sprite-materials.mjs`). A hemispheric
 * light provides ambient fill — sky a desaturated warm cream, ground
 * a cool khaki — plus a subtle directional light to give vertical
 * geometry a readable shaded side. No shadow maps (pixel-art aesthetic;
 * shadows would fight the tile grid).
 */

import * as THREE from "three";

/** Build the world-renderer light rig. Returned as an array so the caller
 *  can `scene.add(...createWorldLights())` without worrying about count.
 *
 *  Goal: colors should read at their authored sRGB values, matching the
 *  2D canvas palette. A full-strength white ambient light achieves this
 *  — with `MeshStandardMaterial(roughness=1, metalness=0)` the lit
 *  output is just `baseColor × ambient`, so intensity = 1.0 means
 *  on-screen color == authored color. A tiny directional sun adds a
 *  subtle face-differentiation cue without desaturating (pure white,
 *  low intensity; hemisphere light is avoided because its sky/ground
 *  color blending tints side-facing surfaces and reduces saturation). */
export function createWorldLights(): THREE.Light[] {
  // Pure white ambient at full intensity — preserves authored colors
  // byte-for-byte on flat-facing surfaces.
  const ambient = new THREE.AmbientLight(0xffffff, 1.0);

  // Directional sun, pure white, low intensity. Adds a soft shading
  // gradient so walls/towers don't look completely flat, without
  // shifting the palette.
  const sun = new THREE.DirectionalLight(0xffffff, 0.2);
  sun.position.set(-0.6, 1, -0.4);
  sun.castShadow = false;

  return [ambient, sun];
}
