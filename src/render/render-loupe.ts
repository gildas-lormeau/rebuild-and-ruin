/**
 * Loupe overlay for precision placement on touch devices.
 *
 * Medieval arrow-slit style window, rendered into a dedicated HTML canvas
 * placed in the left touch panel above the d-pad. Shows a magnified view
 * of the area around the cursor during WALL_BUILD and CANNON_PLACE phases.
 *
 * The loupe canvases are static in index.html (one landscape, one portrait).
 * This module finds them and draws to whichever is currently visible.
 */

import { OFFSCREEN_SCALE, TILE_SIZE } from "../shared/core/grid.ts";
import type { LoupeHandle } from "../shared/ui/overlay-types.ts";

// Loupe rendering constants
const LOUPE_RADIUS = 12;
const LOUPE_BORDER_WIDTH = 6;
const LOUPE_RIVET_RADIUS = 5;
const LOUPE_STONE_COLOR = "rgba(50, 40, 30, 0.92)";
const LOUPE_STONE_LIGHT = "rgba(90, 75, 55, 0.8)";
const LOUPE_RIVET_COLOR = "#c8a040";
const LOUPE_RIVET_HIGHLIGHT = "rgba(255, 240, 180, 0.6)";
const LOUPE_CROSSHAIR_COLOR = "rgba(255, 255, 255, 0.5)";
const LOUPE_CROSSHAIR_DOT = "rgba(255, 255, 255, 0.7)";
// Fixed source window in world pixels — the loupe magnifies exactly
// these many tiles regardless of the loupe's display size. Aspect
// (5/6) matches the CSS `.loupe` aspect-ratio so the source rect maps
// to the display without distortion. Screen size changes the
// on-screen size of the loupe but NOT what it shows.
// Exported so the 3D renderer can scissor its top-down pre-pass to
// just this window (plus a margin) around the pointer — full-map
// top-down rendering was noticeably expensive.
export const LOUPE_SOURCE_TILES_W = 5;
export const LOUPE_SOURCE_TILES_H = 6;

/**
 * Find all loupe canvases within a container and return a handle
 * that draws to whichever is currently visible (has non-zero dimensions).
 *
 * @param sceneCanvas - Returns the offscreen scene canvas to magnify.
 *   Passed as a getter so it can be resolved lazily (the canvas may not
 *   exist at createLoupe call time).
 * @param worldToScene - Optional override: maps a world-pixel point
 *   (where the cursor sits, in the runtime's untransformed world space)
 *   to the scene canvas pixel coordinate whose neighborhood should be
 *   magnified. Defaults to `(wx, wy) => (wx * OS, wy * OS)` which is
 *   the flat top-down 2D renderer's contract. The 3D renderer supplies
 *   its own mapper so the loupe stays centered on the cursor even when
 *   the scene is tilted — `cos(pitch)` foreshortens Y around the
 *   viewport center, so the flat formula samples the wrong tile under
 *   tilt. Kept as a parameter (not a hard-coded pitch handler) so
 *   future renderers with different projections can plug in.
 */
export function createLoupe(
  container: HTMLElement,
  sceneCanvas: () => HTMLCanvasElement,
  worldToScene?: (
    worldX: number,
    worldY: number,
  ) => {
    x: number;
    y: number;
  },
): LoupeHandle {
  const canvases = Array.from(
    container.querySelectorAll<HTMLCanvasElement>("canvas.loupe"),
  );

  let lastVisible = false;

  function update(visible: boolean, worldX: number, worldY: number): void {
    const scene = sceneCanvas();
    if (!visible) {
      if (lastVisible) {
        for (const c of canvases) c.classList.add("hidden");
        lastVisible = false;
      }
      return;
    }
    if (!lastVisible) {
      for (const c of canvases) c.classList.remove("hidden");
      lastVisible = true;
    }

    // Draw to whichever canvas is currently visible (landscape or portrait)
    const canvas = canvases.find(
      (c) => c.clientWidth > 0 && c.clientHeight > 0,
    );
    if (!canvas) return;

    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;
    const dpr = devicePixelRatio || 1;
    const pw = Math.round(cssW * dpr);
    const ph = Math.round(cssH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }

    const canvasCtx = canvas.getContext("2d");
    if (!canvasCtx) return;

    const w = pw;
    const h = ph;
    const bw = Math.round(LOUPE_BORDER_WIDTH * dpr);
    const radius = Math.round(LOUPE_RADIUS * dpr);

    // Inner viewport
    const ix = bw;
    const iy = bw;
    const iw = w - bw * 2;
    const ih = h - bw * 2;
    const ir = Math.max(0, radius - bw);

    // Source rect on sceneCanvas (physical pixels — scene is OFFSCREEN_SCALE×).
    // Fixed size in world units; centered on the cursor without clamping to
    // the map bounds so the cursor/phantom is ALWAYS at the loupe's center
    // (edges of the world render as empty pixels, which `drawImage` handles
    // automatically by clipping the destination rect). The center is
    // delegated to `worldToScene` so renderers that transform the scene
    // (e.g. 3D tilt) can override where a given world point ends up in
    // scene-canvas space.
    const srcW = LOUPE_SOURCE_TILES_W * TILE_SIZE * OFFSCREEN_SCALE;
    const srcH = LOUPE_SOURCE_TILES_H * TILE_SIZE * OFFSCREEN_SCALE;
    const center = worldToScene
      ? worldToScene(worldX, worldY)
      : { x: worldX * OFFSCREEN_SCALE, y: worldY * OFFSCREEN_SCALE };
    const srcX = center.x - srcW / 2;
    const srcY = center.y - srcH / 2;

    // Clear
    canvasCtx.clearRect(0, 0, w, h);

    // Stone border
    roundedRect(canvasCtx, 0, 0, w, h, radius);
    canvasCtx.fillStyle = LOUPE_STONE_COLOR;
    canvasCtx.fill();

    // Clip inner viewport and draw magnified scene
    canvasCtx.save();
    roundedRect(canvasCtx, ix, iy, iw, ih, ir);
    canvasCtx.clip();
    canvasCtx.imageSmoothingEnabled = false;
    canvasCtx.drawImage(scene, srcX, srcY, srcW, srcH, ix, iy, iw, ih);
    canvasCtx.restore();

    // Inner border highlight
    roundedRect(canvasCtx, ix, iy, iw, ih, ir);
    canvasCtx.lineWidth = 1.5 * dpr;
    canvasCtx.strokeStyle = LOUPE_STONE_LIGHT;
    canvasCtx.stroke();

    // Outer border
    roundedRect(canvasCtx, 0, 0, w, h, radius);
    canvasCtx.lineWidth = 2 * dpr;
    canvasCtx.strokeStyle = LOUPE_STONE_LIGHT;
    canvasCtx.stroke();

    // Corner rivets
    const rivetR = Math.round(LOUPE_RIVET_RADIUS * dpr);
    const rivetInset = bw + rivetR + Math.round(2 * dpr);
    const rivets = [
      [rivetInset, rivetInset],
      [w - rivetInset, rivetInset],
      [rivetInset, h - rivetInset],
      [w - rivetInset, h - rivetInset],
    ];
    for (const [rx, ry] of rivets) {
      canvasCtx.beginPath();
      canvasCtx.arc(rx!, ry!, rivetR, 0, Math.PI * 2);
      canvasCtx.fillStyle = LOUPE_RIVET_COLOR;
      canvasCtx.fill();
      canvasCtx.beginPath();
      canvasCtx.arc(rx! - dpr, ry! - dpr, rivetR * 0.5, 0, Math.PI * 2);
      canvasCtx.fillStyle = LOUPE_RIVET_HIGHLIGHT;
      canvasCtx.fill();
    }

    // Crosshair
    const cx = ix + iw / 2;
    const cy = iy + ih / 2;
    const crossLen = Math.round(8 * dpr);
    canvasCtx.strokeStyle = LOUPE_CROSSHAIR_COLOR;
    canvasCtx.lineWidth = dpr;
    canvasCtx.beginPath();
    canvasCtx.moveTo(cx - crossLen, cy);
    canvasCtx.lineTo(cx + crossLen, cy);
    canvasCtx.moveTo(cx, cy - crossLen);
    canvasCtx.lineTo(cx, cy + crossLen);
    canvasCtx.stroke();
    canvasCtx.beginPath();
    canvasCtx.arc(cx, cy, 2 * dpr, 0, Math.PI * 2);
    canvasCtx.fillStyle = LOUPE_CROSSHAIR_DOT;
    canvasCtx.fill();
  }

  return { update };
}

/** Draw a rounded rectangle path (no stroke/fill). */
function roundedRect(
  canvasCtx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  canvasCtx.beginPath();
  canvasCtx.moveTo(x + radius, y);
  canvasCtx.lineTo(x + w - radius, y);
  canvasCtx.arcTo(x + w, y, x + w, y + radius, radius);
  canvasCtx.lineTo(x + w, y + h - radius);
  canvasCtx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  canvasCtx.lineTo(x + radius, y + h);
  canvasCtx.arcTo(x, y + h, x, y + h - radius, radius);
  canvasCtx.lineTo(x, y + radius);
  canvasCtx.arcTo(x, y, x + radius, y, radius);
  canvasCtx.closePath();
}
