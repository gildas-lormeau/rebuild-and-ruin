/**
 * Pure-math unit tests for the camera-projection module.
 *
 * These tests intentionally bypass the scenario runtime because
 * camera-projection is stateless math with no dependency on GameState.
 * The behavioural gate here is byte-parity with the inline viewport math
 * in runtime-camera.ts at pitch=0.
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  type CameraState,
  type CanvasSize,
  cameraStateFromViewport,
  fitTileBounds,
  fitTileBoundsToViewport,
  fitWorldRect,
  screenToWorld,
  toViewport,
  visibleGroundAABB,
  worldToScreen,
} from "../src/runtime/camera-projection.ts";
import { MAX_ZOOM_VIEWPORT_RATIO } from "../src/shared/core/game-constants.ts";
import type { TileBounds, Viewport } from "../src/shared/core/geometry-types.ts";
import {
  CANVAS_H,
  CANVAS_W,
  GRID_COLS,
  GRID_ROWS,
  MAP_PX_H,
  MAP_PX_W,
  SCALE,
  TILE_SIZE,
} from "../src/shared/core/grid.ts";

const EPS = 1e-9;
const MAIN_CANVAS: CanvasSize = { w: CANVAS_W, h: CANVAS_H };

Deno.test("screenToWorld ∘ worldToScreen is identity at pitch=0", () => {
  const cameras: CameraState[] = [
    makeCamera(MAP_PX_W / 2, MAP_PX_H / 2, SCALE), // default full-map zoom
    makeCamera(100, 80, 4),
    makeCamera(MAP_PX_W / 4, MAP_PX_H / 3, 8),
  ];
  const canvases: CanvasSize[] = [
    MAIN_CANVAS,
    { w: 800, h: 600 },
    { w: 1024, h: 768 },
  ];
  const points = [
    { x: 0, y: 0 },
    { x: 37.5, y: 91.25 },
    { x: MAP_PX_W, y: MAP_PX_H },
  ];
  for (const cam of cameras) {
    for (const canvas of canvases) {
      for (const point of points) {
        const { sx, sy } = worldToScreen(cam, canvas, point.x, point.y);
        const back = screenToWorld(cam, canvas, sx, sy);
        assertAlmostEquals(back.x, point.x, EPS);
        assertAlmostEquals(back.y, point.y, EPS);
      }
    }
  }
});

Deno.test(
  "worldToScreen matches runtime-camera inline formula (within fp epsilon)",
  () => {
    // The inline formula in runtime-camera.ts uses CANVAS_W/H constants, so
    // parity is only claimed against a camera sized to the main canvas.
    // Real viewports in the runtime always preserve canvas aspect ratio
    // (fitTileBoundsToViewport and the pinch handler both enforce this). Parity
    // is only defined for canvas-aspect inputs — a single zoom scalar can't
    // represent anisotropic scaling.
    const canvasAspect = MAIN_CANVAS.w / MAIN_CANVAS.h;
    const viewports: Viewport[] = [
      { x: 0, y: 0, w: MAP_PX_W, h: MAP_PX_H },
      { x: 32, y: 16, w: 256, h: 256 / canvasAspect },
      { x: 100, y: 64, w: 128, h: 128 / canvasAspect },
    ];
    for (const viewport of viewports) {
      const cam = cameraStateFromViewport(viewport, MAIN_CANVAS);
      for (const [screenX, screenY] of [
        [0, 0],
        [CANVAS_W / 2, CANVAS_H / 2],
        [CANVAS_W, CANVAS_H],
        [123, 456],
      ]) {
        const expected = inlineScreenToWorld(viewport, screenX!, screenY!);
        const got = screenToWorld(cam, MAIN_CANVAS, screenX!, screenY!);
        assertAlmostEquals(got.x, expected.wx, EPS);
        assertAlmostEquals(got.y, expected.wy, EPS);
      }
      for (const [worldX, worldY] of [
        [0, 0],
        [MAP_PX_W / 2, MAP_PX_H / 2],
        [MAP_PX_W, MAP_PX_H],
      ]) {
        const expected = inlineWorldToScreen(viewport, worldX!, worldY!);
        const got = worldToScreen(cam, MAIN_CANVAS, worldX!, worldY!);
        assertAlmostEquals(got.sx, expected.sx, EPS);
        assertAlmostEquals(got.sy, expected.sy, EPS);
      }
    }
  },
);

/** Replicate runtime-camera.ts's current formulas verbatim. The module under
 *  test must agree with these byte-for-byte when pitch=0 and the input camera
 *  was constructed via cameraStateFromViewport. */
function inlineScreenToWorld(
  viewport: Viewport,
  x: number,
  y: number,
): { wx: number; wy: number } {
  return {
    wx: viewport.x + (x / CANVAS_W) * viewport.w,
    wy: viewport.y + (y / CANVAS_H) * viewport.h,
  };
}

function inlineWorldToScreen(
  viewport: Viewport,
  wx: number,
  wy: number,
): { sx: number; sy: number } {
  return {
    sx: ((wx - viewport.x) / viewport.w) * CANVAS_W,
    sy: ((wy - viewport.y) / viewport.h) * CANVAS_H,
  };
}

Deno.test(
  "toViewport round-trips cameraStateFromViewport exactly (floats)",
  () => {
    const canvasAspect = MAIN_CANVAS.w / MAIN_CANVAS.h;
    const viewports: Viewport[] = [
      { x: 0, y: 0, w: MAP_PX_W, h: MAP_PX_H },
      { x: 32, y: 16, w: 256, h: 256 / canvasAspect },
      { x: 17.5, y: 9.25, w: 128.5, h: 128.5 / canvasAspect },
    ];
    for (const viewport of viewports) {
      const cam = cameraStateFromViewport(viewport, MAIN_CANVAS);
      const back = toViewport(cam, MAIN_CANVAS);
      assertAlmostEquals(back.x, viewport.x, EPS);
      assertAlmostEquals(back.y, viewport.y, EPS);
      assertAlmostEquals(back.w, viewport.w, EPS);
      assertAlmostEquals(back.h, viewport.h, EPS);
    }
  },
);

Deno.test(
  "cameraStateFromViewport(toViewport(state)) is identity within epsilon",
  () => {
    const cameras: CameraState[] = [
      makeCamera(MAP_PX_W / 2, MAP_PX_H / 2, SCALE),
      makeCamera(100, 80, 4),
      makeCamera(MAP_PX_W / 4, MAP_PX_H / 3, 8),
    ];
    for (const cam of cameras) {
      const viewport = toViewport(cam, MAIN_CANVAS);
      const back = cameraStateFromViewport(viewport, MAIN_CANVAS);
      assertAlmostEquals(back.center.x, cam.center.x, EPS);
      assertAlmostEquals(back.center.y, cam.center.y, EPS);
      assertAlmostEquals(back.zoom, cam.zoom, EPS);
      assertEquals(back.pitch, 0);
    }
  },
);

Deno.test("visibleGroundAABB at pitch=0 equals toViewport", () => {
  const cameras: CameraState[] = [
    makeCamera(MAP_PX_W / 2, MAP_PX_H / 2, SCALE),
    makeCamera(250, 180, 6),
  ];
  for (const cam of cameras) {
    const viewport = toViewport(cam, MAIN_CANVAS);
    const aabb = visibleGroundAABB(cam, MAIN_CANVAS);
    assertEquals(aabb.x, viewport.x);
    assertEquals(aabb.y, viewport.y);
    assertEquals(aabb.w, viewport.w);
    assertEquals(aabb.h, viewport.h);
  }
});

Deno.test("fitWorldRect produces a viewport that contains the rect", () => {
  const base = makeCamera(0, 0, 1);
  const rects = [
    { x: 0, y: 0, w: MAP_PX_W, h: MAP_PX_H },
    { x: 100, y: 50, w: 200, h: 100 },
    { x: 300, y: 200, w: 64, h: 64 }, // aspect mismatch: letterbox on one axis
  ];
  for (const rect of rects) {
    const fit = fitWorldRect(base, rect, MAIN_CANVAS);
    const viewport = toViewport(fit, MAIN_CANVAS);
    assert(
      viewport.x <= rect.x + EPS &&
        viewport.y <= rect.y + EPS &&
        viewport.x + viewport.w >= rect.x + rect.w - EPS &&
        viewport.y + viewport.h >= rect.y + rect.h - EPS,
      `fit viewport ${JSON.stringify(viewport)} should contain ${JSON.stringify(rect)}`,
    );
    // Camera center must coincide with rect center.
    assertAlmostEquals(fit.center.x, rect.x + rect.w / 2, EPS);
    assertAlmostEquals(fit.center.y, rect.y + rect.h / 2, EPS);
    // Viewport aspect ratio must match canvas aspect ratio.
    assertAlmostEquals(
      viewport.w / viewport.h,
      MAIN_CANVAS.w / MAIN_CANVAS.h,
      EPS,
    );
  }
});

Deno.test("fitWorldRect of the full map reproduces the default viewport", () => {
  // The current runtime default viewport is exactly the full map rect.
  // fitWorldRect of that rect on CANVAS_W x CANVAS_H (aspect-matched) must
  // reproduce it byte-for-byte through toViewport.
  const base = makeCamera(0, 0, 1);
  const fullMap = { x: 0, y: 0, w: MAP_PX_W, h: MAP_PX_H };
  const fit = fitWorldRect(base, fullMap, MAIN_CANVAS);
  const viewport = toViewport(fit, MAIN_CANVAS);
  assertEquals(viewport.x, fullMap.x);
  assertEquals(viewport.y, fullMap.y);
  assertEquals(viewport.w, fullMap.w);
  assertEquals(viewport.h, fullMap.h);
  // And zoom must equal SCALE (CANVAS_W / MAP_PX_W).
  assertEquals(fit.zoom, SCALE);
});

function makeCamera(
  centerX: number,
  centerY: number,
  zoom: number,
): CameraState {
  return { center: { x: centerX, y: centerY }, zoom, pitch: 0 };
}

Deno.test(
  "fitTileBoundsToViewport matches the legacy inline formula byte-for-byte",
  () => {
    // Representative inputs exercising each clamp branch:
    //   - tiny bounds (single tile) hits the MAX_ZOOM_VIEWPORT_RATIO clamp
    //   - wide bounds (full-width strip) hits the aspect-fit clamp
    //   - edge-hugging bounds hit the map-edge clamp
    const cases: Array<{ bounds: TileBounds; pad: number }> = [
      { bounds: { minR: 10, maxR: 11, minC: 10, maxC: 11 }, pad: 0 },
      { bounds: { minR: 5, maxR: 6, minC: 5, maxC: 6 }, pad: 2 },
      {
        bounds: { minR: 0, maxR: GRID_ROWS - 1, minC: 0, maxC: GRID_COLS - 1 },
        pad: 0,
      },
      {
        bounds: {
          minR: 2,
          maxR: 4,
          minC: 0,
          maxC: Math.floor(GRID_COLS / 2),
        },
        pad: 1,
      },
      {
        bounds: {
          minR: GRID_ROWS - 3,
          maxR: GRID_ROWS - 1,
          minC: GRID_COLS - 3,
          maxC: GRID_COLS - 1,
        },
        pad: 1,
      },
      { bounds: { minR: 0, maxR: 0, minC: 0, maxC: 0 }, pad: 3 },
    ];
    for (const { bounds, pad } of cases) {
      const got = fitTileBoundsToViewport(bounds, pad);
      const expected = legacyTileBoundsToViewport(
        bounds.minR,
        bounds.maxR,
        bounds.minC,
        bounds.maxC,
        pad,
      );
      assertEquals(got.x, expected.x);
      assertEquals(got.y, expected.y);
      assertEquals(got.w, expected.w);
      assertEquals(got.h, expected.h);
    }
  },
);

Deno.test(
  "fitTileBounds + toViewport equals fitTileBoundsToViewport",
  () => {
    const cases: Array<{ bounds: TileBounds; pad: number }> = [
      { bounds: { minR: 10, maxR: 11, minC: 10, maxC: 11 }, pad: 0 },
      { bounds: { minR: 5, maxR: 6, minC: 5, maxC: 6 }, pad: 2 },
      {
        bounds: { minR: 0, maxR: GRID_ROWS - 1, minC: 0, maxC: GRID_COLS - 1 },
        pad: 0,
      },
      {
        bounds: {
          minR: GRID_ROWS - 3,
          maxR: GRID_ROWS - 1,
          minC: GRID_COLS - 3,
          maxC: GRID_COLS - 1,
        },
        pad: 1,
      },
    ];
    for (const { bounds, pad } of cases) {
      const direct = fitTileBoundsToViewport(bounds, pad);
      const state = fitTileBounds(bounds, pad);
      assertEquals(state.pitch, 0);
      const viaState = toViewport(state, MAIN_CANVAS);
      assertAlmostEquals(viaState.x, direct.x, EPS);
      assertAlmostEquals(viaState.y, direct.y, EPS);
      assertAlmostEquals(viaState.w, direct.w, EPS);
      assertAlmostEquals(viaState.h, direct.h, EPS);
    }
  },
);

/** Verbatim copy of the pre-refactor spatial.ts body — oracle for parity. */
function legacyTileBoundsToViewport(
  minR: number,
  maxR: number,
  minC: number,
  maxC: number,
  pad: number,
): Viewport {
  minR = Math.max(0, minR - pad);
  maxR = Math.min(GRID_ROWS - 1, maxR + pad);
  minC = Math.max(0, minC - pad);
  maxC = Math.min(GRID_COLS - 1, maxC + pad);
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

Deno.test("nonzero pitch throws (TODO: implement tilt)", () => {
  const tilted: CameraState = {
    center: { x: 0, y: 0 },
    zoom: 1,
    pitch: 0.1,
  };
  let threw = false;
  try {
    worldToScreen(tilted, MAIN_CANVAS, 0, 0);
  } catch (_error) {
    threw = true;
  }
  assert(threw, "worldToScreen should throw for nonzero pitch");
});
