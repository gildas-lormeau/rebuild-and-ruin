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

import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "./grid.ts";
import {
  LOUPE_BORDER_WIDTH,
  LOUPE_CROSSHAIR_COLOR,
  LOUPE_CROSSHAIR_DOT,
  LOUPE_RADIUS,
  LOUPE_RIVET_COLOR,
  LOUPE_RIVET_HIGHLIGHT,
  LOUPE_RIVET_RADIUS,
  LOUPE_STONE_COLOR,
  LOUPE_STONE_LIGHT,
  LOUPE_ZOOM,
} from "./render-theme.ts";

export interface LoupeHandle {
  /** Update the loupe content — call from render(). */
  update: (visible: boolean, worldX: number, worldY: number, sceneCanvas: HTMLCanvasElement) => void;
}

/**
 * Find all loupe canvases within a container and return a handle
 * that draws to whichever is currently visible (has non-zero dimensions).
 */
export function createLoupe(container: HTMLElement): LoupeHandle {
  const canvases = Array.from(container.querySelectorAll<HTMLCanvasElement>("canvas.loupe"));

  let lastVisible = false;

  function update(visible: boolean, worldX: number, worldY: number, sceneCanvas: HTMLCanvasElement): void {
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
    const canvas = canvases.find(c => c.clientWidth > 0 && c.clientHeight > 0);
    if (!canvas) return;

    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(cssW * dpr);
    const ph = Math.round(cssH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = pw;
    const h = ph;
    const bw = Math.round(LOUPE_BORDER_WIDTH * dpr);
    const r = Math.round(LOUPE_RADIUS * dpr);

    // Inner viewport
    const ix = bw;
    const iy = bw;
    const iw = w - bw * 2;
    const ih = h - bw * 2;
    const ir = Math.max(0, r - bw);

    // Source rect on sceneCanvas (tile-pixel space)
    const sceneW = GRID_COLS * TILE_SIZE;
    const sceneH = GRID_ROWS * TILE_SIZE;
    const srcW = iw / (dpr * LOUPE_ZOOM);
    const srcH = ih / (dpr * LOUPE_ZOOM);
    let srcX = worldX - srcW / 2;
    let srcY = worldY - srcH / 2;
    srcX = Math.max(0, Math.min(sceneW - srcW, srcX));
    srcY = Math.max(0, Math.min(sceneH - srcH, srcY));

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Stone border
    roundedRect(ctx, 0, 0, w, h, r);
    ctx.fillStyle = LOUPE_STONE_COLOR;
    ctx.fill();

    // Clip inner viewport and draw magnified scene
    ctx.save();
    roundedRect(ctx, ix, iy, iw, ih, ir);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sceneCanvas, srcX, srcY, srcW, srcH, ix, iy, iw, ih);
    ctx.restore();

    // Inner border highlight
    roundedRect(ctx, ix, iy, iw, ih, ir);
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = LOUPE_STONE_LIGHT;
    ctx.stroke();

    // Outer border
    roundedRect(ctx, 0, 0, w, h, r);
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = LOUPE_STONE_LIGHT;
    ctx.stroke();

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
      ctx.beginPath();
      ctx.arc(rx!, ry!, rivetR, 0, Math.PI * 2);
      ctx.fillStyle = LOUPE_RIVET_COLOR;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(rx! - dpr, ry! - dpr, rivetR * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = LOUPE_RIVET_HIGHLIGHT;
      ctx.fill();
    }

    // Crosshair
    const cx = ix + iw / 2;
    const cy = iy + ih / 2;
    const crossLen = Math.round(8 * dpr);
    ctx.strokeStyle = LOUPE_CROSSHAIR_COLOR;
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(cx - crossLen, cy);
    ctx.lineTo(cx + crossLen, cy);
    ctx.moveTo(cx, cy - crossLen);
    ctx.lineTo(cx, cy + crossLen);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 2 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = LOUPE_CROSSHAIR_DOT;
    ctx.fill();
  }

  return { update };
}

/** Draw a rounded rectangle path (no stroke/fill). */
function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
