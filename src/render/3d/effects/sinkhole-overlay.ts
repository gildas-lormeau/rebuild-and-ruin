/**
 * 3D owned-sinkhole bank recoloring overlay — parity pass for the 2D
 * `drawSinkholeOverlays`.
 *
 * In 2D, when a player encloses a lake, the bank gradient around that
 * lake is recolored per-pixel so the red/brown BANK_COLOR fades into the
 * owner's interior tint instead of green grass. The 3D terrain bitmap at
 * Y=0 bakes the default bank; the 3D terrain mesh at Y=0.01 can only
 * paint the whole water tile with a flat owner color. Without this layer,
 * owned lakes in 3D show the default red/brown bank around the tint.
 *
 * This manager uploads the 2D renderer's `getSinkholeOverlayBitmap`
 * ImageData (MAP_PX_W × MAP_PX_H, transparent except for the owner-tinted
 * 16×16 patches at each sinkhole water tile) as a CanvasTexture on a
 * plane that sits ABOVE the terrain mesh. The pixel-grain patches win
 * over the mesh's tile-grain tint, so the bank band blends from water
 * through bank through owner-grass exactly as in 2D.
 */

import type * as THREE from "three";
import type { GameMap } from "../../../shared/core/geometry-types.ts";
import type { RenderOverlay } from "../../../shared/ui/overlay-types.ts";
import { ELEVATION_STACK } from "../elevation.ts";
import { createMapLayerCanvas, disposeMapLayerCanvas } from "./layer-canvas.ts";

export interface SinkholeOverlayManager {
  /** Re-upload the sinkhole overlay texture when the 2D cache fingerprint
   *  has changed. No-op on steady-state frames (reference equality on
   *  the returned ImageData). Hides the mesh when there are no owned
   *  clusters. */
  update(map: GameMap, overlay: RenderOverlay | undefined): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

export type GetSinkholeOverlayBitmap = (
  map: GameMap,
  overlay: RenderOverlay | undefined,
) => ImageData | undefined;

export function createSinkholeOverlayManager(
  scene: THREE.Scene,
  getSinkholeOverlayBitmap: GetSinkholeOverlayBitmap,
): SinkholeOverlayManager {
  const layer = createMapLayerCanvas(scene, {
    yLift: ELEVATION_STACK.SINKHOLE_OVERLAY,
    transparent: true,
  });
  const { canvas, ctx, texture, mesh } = layer;
  mesh.visible = false;

  let uploadedImage: ImageData | undefined;

  function update(map: GameMap, overlay: RenderOverlay | undefined): void {
    const bitmap = getSinkholeOverlayBitmap(map, overlay);
    if (!bitmap) {
      if (uploadedImage !== undefined) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        texture.needsUpdate = true;
        uploadedImage = undefined;
      }
      mesh.visible = false;
      return;
    }
    if (uploadedImage !== bitmap) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.putImageData(bitmap, 0, 0);
      texture.needsUpdate = true;
      uploadedImage = bitmap;
    }
    mesh.visible = true;
  }

  function dispose(): void {
    disposeMapLayerCanvas(scene, layer);
  }

  return { update, dispose };
}
