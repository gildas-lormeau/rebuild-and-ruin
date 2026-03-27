/**
 * Canvas coordinate and letterbox layout utilities.
 *
 * Pure geometry — no project deps. Used by both input (event coordinate
 * mapping) and the canvas renderer (CSS position mapping).
 */

/**
 * Convert a client-space coordinate to canvas backing-store coordinates,
 * accounting for object-fit:contain letterboxing.
 */

export function clientToCanvas(clientX: number, clientY: number, canvas: HTMLCanvasElement): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const { contentW, contentH, offsetX, offsetY } = computeLetterboxLayout(canvas, rect);
  return {
    x: ((clientX - rect.left - offsetX) / contentW) * canvas.width,
    y: ((clientY - rect.top - offsetY) / contentH) * canvas.height,
  };
}

/**
 * Compute the letterbox layout for a canvas inside a container,
 * assuming object-fit:contain scaling.
 */
export function computeLetterboxLayout(canvas: HTMLCanvasElement, rect: DOMRect): { contentW: number; contentH: number; offsetX: number; offsetY: number } {
  const canvasRatio = canvas.width / canvas.height;
  const rectRatio = rect.width / rect.height;
  if (rectRatio > canvasRatio) {
    const contentH = rect.height;
    const contentW = rect.height * canvasRatio;
    return { contentW, contentH, offsetX: (rect.width - contentW) / 2, offsetY: 0 };
  }
  const contentW = rect.width;
  const contentH = rect.width / canvasRatio;
  return { contentW, contentH, offsetX: 0, offsetY: (rect.height - contentH) / 2 };
}
