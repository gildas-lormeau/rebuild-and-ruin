/**
 * Canvas 2D implementation of RendererInterface.
 *
 * Shared by main.ts (local play) and online-client.ts (online play) so
 * neither entry point needs to import individual render utilities.
 *
 * `deps` is the test seam: tests pass a recording `canvasFactory` and an
 * `observer` to capture terrain-draw intents. Production callers omit it.
 */

import type { GameMap } from "../shared/core/geometry-types.ts";
import type {
  RendererInterface,
  RenderOverlay,
} from "../shared/ui/overlay-types.ts";
import { clientToCanvas, computeLetterboxLayout } from "./render-layout.ts";
import { createLoupe } from "./render-loupe.ts";
import { createRenderMap, type RenderMapDeps } from "./render-map.ts";

/** Extended return of `createCanvasRenderer`: the public
 *  `RendererInterface` plus a getter for the offscreen scene canvas.
 *  The 3D renderer destructures the getter to build a WebGL+2D
 *  composite for its loupe (the public interface never exposes the
 *  offscreen buffer). */
interface CanvasRenderer extends RendererInterface {
  /** Internal offscreen scene canvas — the 2D-drawn pre-blit buffer. */
  sceneCanvas(): HTMLCanvasElement;
  /** Baked terrain bitmap (grass + water + bank) for `map`. The 3D
   *  renderer uploads this as a CanvasTexture so water/grass visuals
   *  stay pixel-identical across backends. */
  getTerrainBitmap(map: GameMap, inBattle: boolean): ImageData;
  /** Owner-tinted sinkhole bank overlay ImageData for `(map, overlay)`,
   *  or `undefined` when no enclosed sinkhole cluster needs recoloring.
   *  The 3D renderer uploads this as a CanvasTexture on a plane above
   *  the terrain mesh so pixel-grain bank gradient wins over the
   *  mesh's tile-grain owner tint. */
  getSinkholeOverlayBitmap(
    map: GameMap,
    overlay: RenderOverlay | undefined,
  ): ImageData | undefined;
}

export function createCanvasRenderer(
  canvas: HTMLCanvasElement,
  deps: RenderMapDeps = {},
): CanvasRenderer {
  // `container` is the top-level game container (`#game-container`)
  // regardless of how the canvas is nested inside it. Callers toggle
  // the `active` class on this element to show/hide the game area.
  // Using `closest()` tolerates intermediate wrappers like
  // `.canvas-stack` without coupling this module to a particular DOM
  // shape.
  const container =
    (canvas.closest("#game-container") as HTMLElement | null) ??
    (canvas.parentElement as HTMLElement);
  const renderMap = createRenderMap(deps);
  return {
    warmMapCache: renderMap.precomputeTerrainCache,
    drawFrame: (map, overlay, viewport, now) =>
      renderMap.drawMap(map, canvas, overlay, viewport, now),
    clientToSurface: (cx, cy) => clientToCanvas(cx, cy, canvas),
    screenToContainerCSS: (sx, sy) => {
      const rect = canvas.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const { contentW, contentH, offsetX, offsetY } = computeLetterboxLayout(
        canvas,
        rect,
      );
      return {
        x:
          (sx / canvas.width) * contentW +
          offsetX +
          (rect.left - containerRect.left),
        y:
          (sy / canvas.height) * contentH +
          offsetY +
          (rect.top - containerRect.top),
      };
    },
    captureScene: () => renderMap.captureScene(),
    captureSceneOffscreen: (map, overlay, viewport, now) =>
      renderMap.captureSceneOffscreen(map, overlay, viewport, now),
    // 2D path snaps cannon facings to the nearest 45° bucket — no ease
    // runs here, so the predicate is always false.
    isCannonRotationEasing: () => false,
    eventTarget: canvas,
    container,
    createLoupe: (c) => createLoupe(c, renderMap.sceneCanvas),
    sceneCanvas: renderMap.sceneCanvas,
    getTerrainBitmap: renderMap.getTerrainBitmap,
    getSinkholeOverlayBitmap: renderMap.getSinkholeOverlayBitmap,
  };
}
