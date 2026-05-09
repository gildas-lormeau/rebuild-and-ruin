/**
 * Blurred signed-distance field (positive in water, negative in grass,
 * magnitude = pixel distance from the water/grass boundary) uploaded as
 * an `R32F` DataTexture. The shader uses it to compute the per-pixel
 * grass→bank→water gradient inside owned-sinkhole tiles, replacing the
 * earlier CPU-baked second-plane overlay. Re-uploads only on
 * `mapVersion` change.
 */

import * as THREE from "three";
import type { GameMap } from "../../../shared/core/geometry-types.ts";
import { MAP_PX_H, MAP_PX_W } from "../../../shared/core/grid.ts";

export type GetBlurredSdf = (map: GameMap) => Float32Array | undefined;

export interface TerrainSdfTextureManager {
  readonly texture: THREE.DataTexture;
  /** Upload the blurred SDF for `map` if the cached `mapVersion` doesn't
   *  match. Call from the terrain mesh's `ensureBuilt` before the first
   *  frame of each `mapVersion` so the shader samples a populated texture. */
  ensureBuilt(map: GameMap): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

export function createTerrainSdfTextureManager(
  getBlurredSdf: GetBlurredSdf,
): TerrainSdfTextureManager {
  // Placeholder until the first ensureBuilt — DataTexture requires a
  // backing array at construction. NearestFilter so per-fragment lookups
  // sample the exact pixel value (no smoothing across the SDF gradient).
  const placeholder = new Float32Array(MAP_PX_W * MAP_PX_H);
  const texture = new THREE.DataTexture(
    placeholder,
    MAP_PX_W,
    MAP_PX_H,
    THREE.RedFormat,
    THREE.FloatType,
  );
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  let uploadedVersion: number | undefined;

  function ensureBuilt(map: GameMap): void {
    if (uploadedVersion === map.mapVersion) return;
    const sdf = getBlurredSdf(map);
    if (!sdf) return;
    // three.js infers `image.data` as Uint8ClampedArray from the
    // constructor's first arg; the runtime accepts any typed array matching
    // the format/type combo (here R32F → Float32Array). The cast tells
    // TypeScript what WebGL already knows.
    texture.image = {
      data: sdf as unknown as Uint8ClampedArray,
      width: MAP_PX_W,
      height: MAP_PX_H,
    };
    texture.needsUpdate = true;
    uploadedVersion = map.mapVersion;
  }

  function dispose(): void {
    texture.dispose();
  }

  return { texture, ensureBuilt, dispose };
}
