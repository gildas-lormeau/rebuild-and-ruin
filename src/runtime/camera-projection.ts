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
 * Canvas dimensions are passed per-call rather than baked into
 * {@link CameraState} because the same camera state is meaningful across
 * different render targets (the main canvas, the loupe, the e2e bridge
 * capture buffer). Keeping canvas out of state keeps the projection pure.
 *
 * {@link CameraState} uses a single `zoom` scalar, so the visible ground
 * rect always has the canvas's aspect ratio at pitch=0. This matches the
 * runtime invariant that every Viewport produced by
 * {@link fitTileBoundsToViewport} and the pinch handler is canvas-aspect;
 * {@link cameraStateFromViewport} is only well-defined for canvas-aspect
 * inputs.
 *
 * Pitch semantics (ortho + X-axis tilt):
 *   - World coords in this module: +X right, +Y down (screen-aligned at
 *     pitch=0). This matches the 2D renderer's `Viewport` convention —
 *     the row axis of the map is world Y.
 *   - Pitch rotates the camera around the world X-axis. Pitch = 0 means
 *     the camera looks straight down onto the ground (original behaviour).
 *     Pitch > 0 means the camera "leans back" so the viewer is looking
 *     slightly forward: far-map rows (small worldY) compress toward the
 *     top of the screen while near-map rows (large worldY) spread out
 *     toward the bottom. Orientation at pitch=0 is preserved — small-Y
 *     world points stay at the top of the screen.
 *   - Projection is orthographic (no perspective divide), placed so the
 *     ortho "camera centre" sits on the ground plane at
 *     `(center.x, center.y, 0)`. Under X-only tilt this keeps
 *     `(center.x, center.y)` as the ground point that maps to the canvas
 *     centre, so all fit/inverse math stays a linear rescale:
 *
 *         sx = canvas.w/2 + zoom * (worldX - center.x)
 *         sy = canvas.h/2 + zoom * cos(pitch) * (worldY - center.y)
 *
 *     i.e. the Y axis foreshortens by `cos(pitch)`. Because the tilt is
 *     around X only (no roll, no yaw), the visible ground is still an
 *     axis-aligned rectangle — no trapezoid. Perspective trapezoids only
 *     appear under a perspective projection, which this module does not
 *     use.
 *   - Upper bound: pitch must satisfy |pitch| < MAX_PITCH. As pitch → π/2
 *     the Y foreshortening factor collapses to 0 and the ground plane
 *     becomes edge-on. MAX_PITCH = π/3 leaves plenty of headroom and is
 *     well short of that singularity.
 *
 * Nothing in the runtime constructs a pitched CameraState today; the
 * pitched branches exist so a later wiring step can turn tilt on without
 * touching this module again. Pitch=0 behaviour is byte-identical to the
 * untilted formulas.
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
/** Hard upper bound on |pitch|. π/3 (60°) is far enough from π/2 that the
 *  `cos(pitch)` foreshortening factor (~0.5) still leaves plenty of vertical
 *  resolution; going past this the ground plane starts to approach edge-on
 *  and the ortho model stops being useful. */
export const MAX_PITCH = Math.PI / 3;

export function worldToScreen(
  state: CameraState,
  canvas: CanvasSize,
  worldX: number,
  worldY: number,
): { sx: number; sy: number } {
  assertPitchInRange(state.pitch);
  const cosPitch = Math.cos(state.pitch);
  return {
    sx: canvas.w / 2 + state.zoom * (worldX - state.center.x),
    sy: canvas.h / 2 + state.zoom * cosPitch * (worldY - state.center.y),
  };
}

export function screenToWorld(
  state: CameraState,
  canvas: CanvasSize,
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  assertPitchInRange(state.pitch);
  const cosPitch = Math.cos(state.pitch);
  return {
    x: state.center.x + (screenX - canvas.w / 2) / state.zoom,
    y: state.center.y + (screenY - canvas.h / 2) / (state.zoom * cosPitch),
  };
}

/** Fit a world rect into the canvas, preserving canvas aspect ratio.
 *  The resulting camera's visible area fully contains `rect` and is centered
 *  on the rect's center. Letterboxing is along whichever axis has slack.
 *
 *  Under tilt, the rect's screen-space Y extent is `rect.h * cos(pitch)`,
 *  so the Y axis needs *less* zoom headroom to fit. Closed-form — no
 *  iteration required, because ortho + X-only tilt is a pure diagonal
 *  rescale (X and Y independent). */
export function fitWorldRect(
  state: CameraState,
  rect: Viewport,
  canvas: CanvasSize,
): CameraState {
  assertPitchInRange(state.pitch);
  const cosPitch = Math.cos(state.pitch);
  const zoomX = canvas.w / rect.w;
  const zoomY = canvas.h / (rect.h * cosPitch);
  const zoom = Math.min(zoomX, zoomY);
  return {
    center: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 },
    zoom,
    pitch: state.pitch,
  };
}

/** Axis-aligned bound of the visible ground. Under X-axis tilt the visible
 *  ground is still an axis-aligned rectangle (no trapezoid — that would
 *  require perspective), stretched vertically by 1/cos(pitch). */
export function visibleGroundAABB(
  state: CameraState,
  canvas: CanvasSize,
): Viewport {
  assertPitchInRange(state.pitch);
  const cosPitch = Math.cos(state.pitch);
  const visibleW = canvas.w / state.zoom;
  const visibleH = canvas.h / (state.zoom * cosPitch);
  return {
    x: state.center.x - visibleW / 2,
    y: state.center.y - visibleH / 2,
    w: visibleW,
    h: visibleH,
  };
}

/** Fit a padded tile-bounds rect into the main canvas, preserving map aspect
 *  ratio and respecting the max-zoom policy. Returns a pitch=0 CameraState
 *  whose `visibleGroundAABB(state, MAIN_CANVAS)` matches the flat-viewport form. */
export function fitTileBounds(bounds: TileBounds, pad: number): CameraState {
  const viewport = fitTileBoundsToViewport(bounds, pad);
  return cameraStateFromViewport(viewport, MAIN_CANVAS);
}

/** Inverse of {@link visibleGroundAABB} at pitch=0: recover a CameraState that
 *  reproduces `viewport` when re-projected onto `canvas`. `canvas` is
 *  required because zoom depends on the ratio of canvas to viewport size.
 *  `pitch` defaults to 0 for the flat case; callers animating tilt (see
 *  runtime-camera) pass the current pitch so screen↔world round-trips stay
 *  consistent with what the 3D renderer draws. */
export function cameraStateFromViewport(
  viewport: Viewport,
  canvas: CanvasSize,
  pitch: number = 0,
): CameraState {
  return {
    center: {
      x: viewport.x + viewport.w / 2,
      y: viewport.y + viewport.h / 2,
    },
    zoom: canvas.w / viewport.w,
    pitch,
  };
}

/** Flat-viewport form of {@link fitTileBounds}. Implicitly targets the main
 *  canvas (via MAP_PX_W/H) — callers in runtime-camera rely on this contract.
 *
 *  Pitch-agnostic by design: the function inputs are a tile-bounds rect plus
 *  a padding, neither of which knows about camera tilt. Under tilt the
 *  caller should feed this viewport back through
 *  {@link cameraStateFromViewport} + apply their own pitch; the ground
 *  rect fit here is what they want to frame regardless of tilt. */
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

function assertPitchInRange(pitch: number): void {
  if (!Number.isFinite(pitch)) {
    throw new Error(`camera-projection: pitch must be finite, got ${pitch}`);
  }
  if (Math.abs(pitch) >= MAX_PITCH) {
    throw new Error(
      `camera-projection: |pitch|=${Math.abs(pitch)} exceeds MAX_PITCH=${MAX_PITCH} (ortho model breaks down near π/2)`,
    );
  }
}
