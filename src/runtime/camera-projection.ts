/**
 * Pure projection math for the game camera.
 *
 * This module is intentionally state-light: {@link CameraState} holds only
 * the three parameters that fully describe a projection (center, zoom, pitch)
 * and every function is a pure transform over that state + a canvas size.
 *
 * Zoom semantics: `zoom = 1` means the visible world rect matches the
 * canvas size 1:1 in units, i.e. no zoom. The existing 2D renderer's
 * "no zoom" viewport is the full map (MAP_PX_W x MAP_PX_H) stretched over
 * a CANVAS_W x CANVAS_H canvas — that corresponds to `zoom = SCALE` here
 * (canvas.w / MAP_PX_W == SCALE).
 *
 * Pitch is reserved for a future 3D-tilt pass. At pitch=0 every function
 * reduces to flat rect-viewport math identical to `runtime-camera.ts`'s
 * inline formulas. Nonzero pitch is not yet implemented and will throw.
 *
 * Canvas dimensions are passed per-call rather than baked into
 * {@link CameraState} because the same camera state is meaningful across
 * different render targets (the main canvas, the loupe, the e2e bridge
 * capture buffer). Keeping canvas out of state keeps the projection pure.
 *
 * {@link CameraState} uses a single `zoom` scalar, so the visible ground
 * rect always has the canvas's aspect ratio. This matches the runtime
 * invariant that every Viewport produced by {@link fitTileBoundsToViewport}
 * and the pinch handler is canvas-aspect; {@link cameraStateFromViewport} is
 * only well-defined for canvas-aspect inputs.
 */

import { MAX_ZOOM_VIEWPORT_RATIO } from "../shared/core/game-constants.ts";
import type { TileBounds, Viewport } from "../shared/core/geometry-types.ts";
import {
  CANVAS_H,
  CANVAS_W,
  GRID_COLS,
  GRID_ROWS,
  MAP_PX_H,
  MAP_PX_W,
  TILE_SIZE,
} from "../shared/core/grid.ts";

export type { TileBounds };

export interface CameraState {
  readonly center: { readonly x: number; readonly y: number };
  readonly zoom: number;
  readonly pitch: number;
}

export interface CanvasSize {
  readonly w: number;
  readonly h: number;
}

const MAIN_CANVAS: CanvasSize = { w: CANVAS_W, h: CANVAS_H };

export function worldToScreen(
  state: CameraState,
  canvas: CanvasSize,
  worldX: number,
  worldY: number,
): { sx: number; sy: number } {
  assertFlat(state);
  const visibleW = canvas.w / state.zoom;
  const visibleH = canvas.h / state.zoom;
  const originX = state.center.x - visibleW / 2;
  const originY = state.center.y - visibleH / 2;
  return {
    sx: ((worldX - originX) / visibleW) * canvas.w,
    sy: ((worldY - originY) / visibleH) * canvas.h,
  };
}

export function screenToWorld(
  state: CameraState,
  canvas: CanvasSize,
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  assertFlat(state);
  const visibleW = canvas.w / state.zoom;
  const visibleH = canvas.h / state.zoom;
  const originX = state.center.x - visibleW / 2;
  const originY = state.center.y - visibleH / 2;
  return {
    x: originX + (screenX / canvas.w) * visibleW,
    y: originY + (screenY / canvas.h) * visibleH,
  };
}

/** Fit a world rect into the canvas, preserving canvas aspect ratio.
 *  The resulting camera's visible area fully contains `rect` and is centered
 *  on the rect's center. Letterboxing is along whichever axis has slack. */
export function fitWorldRect(
  state: CameraState,
  rect: Viewport,
  canvas: CanvasSize,
): CameraState {
  assertFlat(state);
  const zoom = Math.min(canvas.w / rect.w, canvas.h / rect.h);
  return {
    center: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 },
    zoom,
    pitch: state.pitch,
  };
}

export function toViewport(state: CameraState, canvas: CanvasSize): Viewport {
  const rect = visibleGroundAABB(state, canvas);
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

export function visibleGroundAABB(
  state: CameraState,
  canvas: CanvasSize,
): Viewport {
  assertFlat(state);
  const visibleW = canvas.w / state.zoom;
  const visibleH = canvas.h / state.zoom;
  return {
    x: state.center.x - visibleW / 2,
    y: state.center.y - visibleH / 2,
    w: visibleW,
    h: visibleH,
  };
}

/** Fit a padded tile-bounds rect into the main canvas, preserving map aspect
 *  ratio and respecting the max-zoom policy. Returns a pitch=0 CameraState
 *  whose `toViewport(state, MAIN_CANVAS)` matches the flat-viewport form. */
export function fitTileBounds(bounds: TileBounds, pad: number): CameraState {
  const viewport = fitTileBoundsToViewport(bounds, pad);
  return cameraStateFromViewport(viewport, MAIN_CANVAS);
}

/** Inverse of {@link toViewport} at pitch=0: recover a CameraState that
 *  reproduces `viewport` when re-projected onto `canvas`. `canvas` is
 *  required because zoom depends on the ratio of canvas to viewport size. */
export function cameraStateFromViewport(
  viewport: Viewport,
  canvas: CanvasSize,
): CameraState {
  return {
    center: {
      x: viewport.x + viewport.w / 2,
      y: viewport.y + viewport.h / 2,
    },
    zoom: canvas.w / viewport.w,
    pitch: 0,
  };
}

/** Flat-viewport form of {@link fitTileBounds}. Implicitly targets the main
 *  canvas (via MAP_PX_W/H) — callers in runtime-camera rely on this contract. */
export function fitTileBoundsToViewport(
  bounds: TileBounds,
  pad: number,
): Viewport {
  const minR = Math.max(0, bounds.minR - pad);
  const maxR = Math.min(GRID_ROWS - 1, bounds.maxR + pad);
  const minC = Math.max(0, bounds.minC - pad);
  const maxC = Math.min(GRID_COLS - 1, bounds.maxC + pad);
  const fullW = MAP_PX_W;
  const fullH = MAP_PX_H;
  const maxW = fullW * MAX_ZOOM_VIEWPORT_RATIO;
  const maxH = fullH * MAX_ZOOM_VIEWPORT_RATIO;
  const targetAspect = GRID_COLS / GRID_ROWS;
  const tileW = (maxC - minC + 1) * TILE_SIZE;
  const tileH = (maxR - minR + 1) * TILE_SIZE;
  const vpAspect = tileW / tileH;
  const newW =
    vpAspect < targetAspect
      ? Math.min(maxW, tileH * targetAspect)
      : Math.min(maxW, Math.min(maxH, tileW / targetAspect) * targetAspect);
  const newH = newW / targetAspect;
  const cx = ((minC + maxC + 1) * TILE_SIZE) / 2;
  const cy = ((minR + maxR + 1) * TILE_SIZE) / 2;
  const x = Math.max(0, Math.min(fullW - newW, cx - newW / 2));
  const y = Math.max(0, Math.min(fullH - newH, cy - newH / 2));
  return { x, y, w: newW, h: newH };
}

function assertFlat(state: CameraState): void {
  if (state.pitch !== 0) {
    throw new Error(
      `camera-projection: pitch=${state.pitch} not yet implemented (flat-only)`,
    );
  }
}
