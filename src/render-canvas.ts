/**
 * Canvas 2D implementation of RendererInterface.
 *
 * Shared by main.ts (local play) and online-client.ts (online play) so
 * neither entry point needs to import individual render utilities.
 */

import { clientToCanvas, computeLetterboxLayout } from "./canvas-layout.ts";
import { createLoupe } from "./render-loupe.ts";
import { drawMap, sceneCanvas } from "./render-map.ts";
import type { RendererInterface } from "./render-types.ts";

export function createCanvasRenderer(canvas: HTMLCanvasElement): RendererInterface {
  const container = canvas.parentElement as HTMLElement;
  return {
    drawFrame: (map, overlay, viewport) => drawMap(map, canvas, overlay, viewport),
    clientToSurface: (cx, cy) => clientToCanvas(cx, cy, canvas),
    screenToContainerCSS: (sx, sy) => {
      const rect = canvas.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const { contentW, contentH, offsetX, offsetY } = computeLetterboxLayout(canvas, rect);
      return {
        x: (sx / canvas.width) * contentW + offsetX + (rect.left - containerRect.left),
        y: (sy / canvas.height) * contentH + offsetY + (rect.top - containerRect.top),
      };
    },
    eventTarget: canvas,
    container,
    createLoupe: (c) => createLoupe(c, sceneCanvas),
  };
}
