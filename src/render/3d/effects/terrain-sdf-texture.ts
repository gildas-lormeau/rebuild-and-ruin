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
import { MAP_PX_H, MAP_PX_W, type TileKey } from "../../../shared/core/grid.ts";

/** Modifier projection for SDF generation. Tiles in `phantomWater` are
 *  treated as water (high_tide flooded grass) and tiles in `phantomGrass`
 *  as grass (low_water exposed riverbed) when computing the SDF. The
 *  underlying `state.map.tiles` is unchanged; this is purely a render-
 *  side projection so the bank gradient appears at the modifier-effective
 *  shoreline without mutating game state. */
export interface SdfOpts {
  phantomWater?: ReadonlySet<TileKey>;
  phantomGrass?: ReadonlySet<TileKey>;
}

export type GetBlurredSdf = (
  map: GameMap,
  opts?: SdfOpts,
) => Float32Array | undefined;

export interface TerrainSdfTextureManager {
  readonly texture: THREE.DataTexture;
  /** Upload the blurred SDF for `map` if the cached `mapVersion` doesn't
   *  match. Call from the terrain mesh's `ensureBuilt` before the first
   *  frame of each `mapVersion` so the shader samples a populated texture.
   *
   *  `opts` projects modifier-affected tiles into the SDF (high_tide
   *  flooded grass → water, low_water exposed water → grass). The
   *  modifier impls bump `mapVersion` on apply / clear so the cache
   *  invalidates on the same frame the projection becomes (in)active. */
  ensureBuilt(map: GameMap, opts?: SdfOpts): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

// lint:allow-callback-inversion -- DI getter: SDF data is owned higher up;
// the manager pulls it lazily on ensureBuilt.
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

  function ensureBuilt(map: GameMap, opts?: SdfOpts): void {
    if (uploadedVersion === map.mapVersion) return;
    const sdf = getBlurredSdf(map, opts);
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
