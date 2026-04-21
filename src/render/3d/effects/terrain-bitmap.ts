/**
 * 3D terrain bitmap overlay — uploads the 2D renderer's baked terrain
 * ImageData as a CanvasTexture so grass / water / bank visuals stay
 * pixel-identical across 2D and 3D.
 *
 * The 2D path renders terrain per-pixel via an SDF (smooth water/grass
 * transitions with a red-brown bank band) into an `ImageData` cache
 * keyed by `(map, inBattle)`. The 3D terrain mesh previously painted
 * per-tile uniform grass/water colors, which butted together at tile
 * boundaries with hard edges; a separate bank overlay couldn't fully
 * hide the transition. Swapping in the 2D bitmap delivers the same
 * anti-aliased shoreline without porting the SDF math.
 *
 * Design:
 *   - Reused offscreen canvas sized MAP_PX_W × MAP_PX_H with a
 *     CanvasTexture (NearestFilter, no mipmaps, default flipY=true
 *     matching water-waves).
 *   - Flat PlaneGeometry rotated -π/2 on X, positioned at ground plane
 *     Y=0. Terrain mesh lifts to Y=0.01 — its opaque pixels (castle
 *     interiors, bonus squares, frozen tiles, sinkhole owner tints)
 *     cover the bitmap, while transparent pixels at raw grass/water
 *     tiles let the bitmap show through.
 *   - Rebake gated by fingerprint `(mapVersion, inBattle)`. Calls the
 *     injected `getTerrainBitmap` to fetch the 2D cache entry and
 *     `putImageData` it onto the offscreen canvas.
 */

import type * as THREE from "three";
import type { GameMap } from "../../../shared/core/geometry-types.ts";
import type { RenderOverlay } from "../../../shared/ui/overlay-types.ts";
import { createMapLayerCanvas, disposeMapLayerCanvas } from "./layer-canvas.ts";

export interface TerrainBitmapManager {
  /** Rebake the terrain texture when the fingerprint
   *  `(map.mapVersion, overlay.battle.inBattle)` has changed since
   *  the last call. No-op on steady-state frames. */
  update(map: GameMap, overlay: RenderOverlay | undefined): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

export type GetTerrainBitmap = (map: GameMap, inBattle: boolean) => ImageData;

// Ground plane lift for the bitmap. Terrain mesh sits at Y=0.01 so its
// opaque (interior / bonus / frozen / owned-sinkhole) pixels win the
// depth test; its transparent pixels let this bitmap show through.
const BITMAP_Y_LIFT = 0;

export function createTerrainBitmapManager(
  scene: THREE.Scene,
  getTerrainBitmap: GetTerrainBitmap,
): TerrainBitmapManager {
  const layer = createMapLayerCanvas(scene, {
    yLift: BITMAP_Y_LIFT,
    transparent: false,
  });
  const { ctx, texture, mesh } = layer;
  mesh.visible = false;

  let bakedVersion: number | undefined;
  let bakedInBattle: boolean | undefined;

  function update(map: GameMap, overlay: RenderOverlay | undefined): void {
    const inBattle = !!overlay?.battle?.inBattle;
    if (bakedVersion === map.mapVersion && bakedInBattle === inBattle) return;
    bakedVersion = map.mapVersion;
    bakedInBattle = inBattle;

    const bitmap = getTerrainBitmap(map, inBattle);
    ctx.putImageData(bitmap, 0, 0);
    texture.needsUpdate = true;
    mesh.visible = true;
  }

  function dispose(): void {
    disposeMapLayerCanvas(scene, layer);
  }

  return { update, dispose };
}
