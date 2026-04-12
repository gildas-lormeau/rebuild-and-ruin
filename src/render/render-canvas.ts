/**
 * Canvas 2D implementation of RendererInterface.
 *
 * Shared by main.ts (local play) and online-client.ts (online play) so
 * neither entry point needs to import individual render utilities.
 *
 * `deps` is the test seam: tests pass a recording `canvasFactory` and an
 * `observer` to capture terrain-draw intents. Production callers omit it.
 */

import type { RendererInterface } from "../shared/ui/overlay-types.ts";
import { clientToCanvas, computeLetterboxLayout } from "./render-layout.ts";
import { createLoupe } from "./render-loupe.ts";
import { createRenderMap, type RenderMapDeps } from "./render-map.ts";

export function createCanvasRenderer(
  canvas: HTMLCanvasElement,
  deps: RenderMapDeps = {},
): RendererInterface {
  const container = canvas.parentElement as HTMLElement;
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
    eventTarget: canvas,
    container,
    createLoupe: (c) => createLoupe(c, renderMap.sceneCanvas),
  };
}
