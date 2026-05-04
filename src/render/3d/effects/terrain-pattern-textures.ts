/**
 * 3D terrain grass-blade pattern texture — a static 16×16 R32F DataTexture
 * holding signed sRGB-byte brightness offsets the terrain shader applies
 * to grass color in battle mode.
 *
 * Replaces the per-pixel `BLADE_DARK` / `BLADE_LIGHT` baking that used to
 * live in `render-map.ts`'s `GRASS_TEX` lookup table (consumed by
 * `renderTerrainPixels` to paint the now-deleted CPU terrain bitmap). The
 * shader samples this once per fragment and shifts the linear grass color
 * back to sRGB to add the offset, matching the byte-exact look of the
 * original bake.
 *
 * One module-level texture, baked at construction. NearestFilter so the
 * 16-pixel pattern stays pixel-art crisp when sampled per-tile.
 */

import * as THREE from "three";
import { TILE_SIZE } from "../../../shared/core/grid.ts";

/** Local pixel offsets (lx, ly) that get a -12 sRGB-byte darkening in
 *  battle. Mirrors `render-map.ts`'s historical `BLADE_DARK`. */
const BLADE_DARK: readonly (readonly [number, number])[] = [
  [2, 1],
  [7, 3],
  [12, 0],
  [4, 6],
  [10, 7],
  [1, 10],
  [8, 11],
  [14, 9],
  [5, 13],
  [11, 14],
  [2, 2],
  [7, 4],
  [12, 1],
  [4, 7],
  [10, 8],
  [1, 11],
  [8, 12],
  [14, 10],
  [5, 14],
  [11, 15],
];
/** Local pixel offsets (lx, ly) that get a +10 sRGB-byte brightening. */
const BLADE_LIGHT: readonly (readonly [number, number])[] = [
  [3, 4],
  [9, 2],
  [13, 6],
  [6, 9],
  [0, 13],
  [11, 12],
];
const BLADE_DARK_OFFSET_SRGB = -12 / 255;
const BLADE_LIGHT_OFFSET_SRGB = 10 / 255;

export function createGrassPatternTexture(): THREE.DataTexture {
  const data = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (const [lx, ly] of BLADE_DARK)
    data[ly * TILE_SIZE + lx] = BLADE_DARK_OFFSET_SRGB;
  for (const [lx, ly] of BLADE_LIGHT)
    data[ly * TILE_SIZE + lx] = BLADE_LIGHT_OFFSET_SRGB;
  const texture = new THREE.DataTexture(
    data,
    TILE_SIZE,
    TILE_SIZE,
    THREE.RedFormat,
    THREE.FloatType,
  );
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
