/**
 * Loupe (magnifying glass) overlay for precision placement on touch devices.
 *
 * Shows a circular magnified view of the area around the cursor during
 * WALL_BUILD and CANNON_PLACE phases, offset from the finger so the
 * piece/cannon is visible.
 *
 * Landscape: loupe to the left or right of the finger.
 * Portrait: loupe above or below the finger.
 */

import { GRID_COLS, GRID_ROWS, SCALE, TILE_SIZE } from "./grid.ts";
import {
  LOUPE_ACCENT_COLOR,
  LOUPE_BORDER_COLOR,
  LOUPE_BORDER_WIDTH,
  LOUPE_DIAMETER,
  LOUPE_OFFSET,
  LOUPE_ZOOM,
} from "./render-theme.ts";

interface LoupeState {
  visible: boolean;
  /** Screen-space touch position (canvas display pixels). */
  screenX: number;
  screenY: number;
  /** World-space cursor position (tile pixels on sceneCanvas). */
  worldX: number;
  worldY: number;
}

const state: LoupeState = { visible: false, screenX: 0, screenY: 0, worldX: 0, worldY: 0 };

export function showLoupe(screenX: number, screenY: number, worldX: number, worldY: number): void {
  state.visible = true;
  state.screenX = screenX;
  state.screenY = screenY;
  state.worldX = worldX;
  state.worldY = worldY;
}

export function hideLoupe(): void {
  state.visible = false;
}

export function drawLoupe(canvas: HTMLCanvasElement, sceneCanvas: HTMLCanvasElement): void {
  if (!state.visible) return;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const radius = LOUPE_DIAMETER / 2;
  const sceneW = GRID_COLS * TILE_SIZE;
  const sceneH = GRID_ROWS * TILE_SIZE;
  const canvasGameH = GRID_ROWS * TILE_SIZE * SCALE;
  const landscape = canvas.width >= canvasGameH;

  // --- Position based on orientation ---
  let centerX: number;
  let centerY: number;

  if (landscape) {
    // Landscape: offset horizontally, auto-flip left/right
    centerY = Math.max(radius, Math.min(canvasGameH - radius, state.screenY));
    centerX = state.screenX + LOUPE_OFFSET;
    if (centerX + radius > canvas.width) {
      centerX = state.screenX - LOUPE_OFFSET;
    }
    centerX = Math.max(radius, Math.min(canvas.width - radius, centerX));
  } else {
    // Portrait: offset vertically, auto-flip up/down
    centerX = Math.max(radius, Math.min(canvas.width - radius, state.screenX));
    centerY = state.screenY - LOUPE_OFFSET;
    if (centerY - radius < 0) {
      centerY = state.screenY + LOUPE_OFFSET;
    }
    centerY = Math.max(radius, Math.min(canvasGameH - radius, centerY));
  }

  // --- Source rect on sceneCanvas (tile-pixel space) ---
  const srcSize = LOUPE_DIAMETER / (SCALE * LOUPE_ZOOM);
  let srcX = state.worldX - srcSize / 2;
  let srcY = state.worldY - srcSize / 2;

  // Clamp source to scene bounds
  srcX = Math.max(0, Math.min(sceneW - srcSize, srcX));
  srcY = Math.max(0, Math.min(sceneH - srcSize, srcY));

  // --- Draw magnified area clipped to circle ---
  ctx.save();
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.clip();

  ctx.drawImage(
    sceneCanvas,
    srcX, srcY, srcSize, srcSize,
    centerX - radius, centerY - radius, LOUPE_DIAMETER, LOUPE_DIAMETER,
  );

  ctx.restore();

  // --- Border rings ---
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.lineWidth = LOUPE_BORDER_WIDTH;
  ctx.strokeStyle = LOUPE_BORDER_COLOR;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(centerX, centerY, radius - LOUPE_BORDER_WIDTH, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = LOUPE_ACCENT_COLOR;
  ctx.stroke();

  // --- Crosshair dot at center ---
  ctx.beginPath();
  ctx.arc(centerX, centerY, 2, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
  ctx.fill();
}
