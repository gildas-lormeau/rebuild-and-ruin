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
  MAX_PITCH,
  screenToWorld,
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
const TILT_EPS = 1e-9;

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
  "visibleGroundAABB round-trips cameraStateFromViewport exactly (floats)",
  () => {
    const canvasAspect = MAIN_CANVAS.w / MAIN_CANVAS.h;
    const viewports: Viewport[] = [
      { x: 0, y: 0, w: MAP_PX_W, h: MAP_PX_H },
      { x: 32, y: 16, w: 256, h: 256 / canvasAspect },
      { x: 17.5, y: 9.25, w: 128.5, h: 128.5 / canvasAspect },
    ];
    for (const viewport of viewports) {
      const cam = cameraStateFromViewport(viewport, MAIN_CANVAS);
      const back = visibleGroundAABB(cam, MAIN_CANVAS);
      assertAlmostEquals(back.x, viewport.x, EPS);
      assertAlmostEquals(back.y, viewport.y, EPS);
      assertAlmostEquals(back.w, viewport.w, EPS);
      assertAlmostEquals(back.h, viewport.h, EPS);
    }
  },
);

Deno.test(
  "cameraStateFromViewport(visibleGroundAABB(state)) is identity within epsilon",
  () => {
    const cameras: CameraState[] = [
      makeCamera(MAP_PX_W / 2, MAP_PX_H / 2, SCALE),
      makeCamera(100, 80, 4),
      makeCamera(MAP_PX_W / 4, MAP_PX_H / 3, 8),
    ];
    for (const cam of cameras) {
      const viewport = visibleGroundAABB(cam, MAIN_CANVAS);
      const back = cameraStateFromViewport(viewport, MAIN_CANVAS);
      assertAlmostEquals(back.center.x, cam.center.x, EPS);
      assertAlmostEquals(back.center.y, cam.center.y, EPS);
      assertAlmostEquals(back.zoom, cam.zoom, EPS);
      assertEquals(back.pitch, 0);
    }
  },
);

Deno.test("fitWorldRect produces a viewport that contains the rect", () => {
  const base = makeCamera(0, 0, 1);
  const rects = [
    { x: 0, y: 0, w: MAP_PX_W, h: MAP_PX_H },
    { x: 100, y: 50, w: 200, h: 100 },
    { x: 300, y: 200, w: 64, h: 64 }, // aspect mismatch: letterbox on one axis
  ];
  for (const rect of rects) {
    const fit = fitWorldRect(base, rect, MAIN_CANVAS);
    const viewport = visibleGroundAABB(fit, MAIN_CANVAS);
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
  // reproduce it byte-for-byte through visibleGroundAABB.
  const base = makeCamera(0, 0, 1);
  const fullMap = { x: 0, y: 0, w: MAP_PX_W, h: MAP_PX_H };
  const fit = fitWorldRect(base, fullMap, MAIN_CANVAS);
  const viewport = visibleGroundAABB(fit, MAIN_CANVAS);
  assertEquals(viewport.x, fullMap.x);
  assertEquals(viewport.y, fullMap.y);
  assertEquals(viewport.w, fullMap.w);
  assertEquals(viewport.h, fullMap.h);
  // And zoom must equal SCALE (CANVAS_W / MAP_PX_W).
  assertEquals(fit.zoom, SCALE);
});

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
  "fitTileBounds + visibleGroundAABB equals fitTileBoundsToViewport",
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
      const viaState = visibleGroundAABB(state, MAIN_CANVAS);
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

Deno.test(
  "screenToWorld ∘ worldToScreen is identity under tilt",
  () => {
    // A coarse grid of ground-plane points near the visible region. These
    // are round-tripped through the projection and back — must recover
    // the input to high precision regardless of pitch.
    const pitches = [0.1, 0.3, Math.PI / 6, Math.PI / 4];
    const cameras: CameraState[] = [
      { center: { x: MAP_PX_W / 2, y: MAP_PX_H / 2 }, zoom: SCALE, pitch: 0 },
      { center: { x: 200, y: 150 }, zoom: 4, pitch: 0 },
      { center: { x: MAP_PX_W / 3, y: MAP_PX_H / 4 }, zoom: 6, pitch: 0 },
    ];
    const canvases: CanvasSize[] = [MAIN_CANVAS, { w: 800, h: 600 }];
    const offsets = [-40, -10, 0, 10, 40];
    for (const pitch of pitches) {
      for (const baseCam of cameras) {
        const cam: CameraState = { ...baseCam, pitch };
        for (const canvas of canvases) {
          for (const dx of offsets) {
            for (const dy of offsets) {
              const point = { x: cam.center.x + dx, y: cam.center.y + dy };
              const { sx, sy } = worldToScreen(cam, canvas, point.x, point.y);
              const back = screenToWorld(cam, canvas, sx, sy);
              assertAlmostEquals(back.x, point.x, TILT_EPS);
              assertAlmostEquals(back.y, point.y, TILT_EPS);
            }
          }
        }
      }
    }
  },
);

Deno.test(
  "pitch→0 limit: tiny pitch matches pitch=0 within loose epsilon",
  () => {
    const tinyPitch = 1e-6;
    const flat = makeCamera(MAP_PX_W / 2, MAP_PX_H / 2, SCALE);
    const tilted: CameraState = { ...flat, pitch: tinyPitch };
    const looseEps = 1e-3;

    for (const [worldX, worldY] of [
      [0, 0],
      [MAP_PX_W / 2, MAP_PX_H / 2],
      [MAP_PX_W, MAP_PX_H],
      [123, 456],
    ]) {
      const flatScreen = worldToScreen(flat, MAIN_CANVAS, worldX!, worldY!);
      const tiltScreen = worldToScreen(tilted, MAIN_CANVAS, worldX!, worldY!);
      assertAlmostEquals(tiltScreen.sx, flatScreen.sx, looseEps);
      assertAlmostEquals(tiltScreen.sy, flatScreen.sy, looseEps);
    }

    for (const [screenX, screenY] of [
      [0, 0],
      [CANVAS_W / 2, CANVAS_H / 2],
      [CANVAS_W, CANVAS_H],
    ]) {
      const flatWorld = screenToWorld(flat, MAIN_CANVAS, screenX!, screenY!);
      const tiltWorld = screenToWorld(tilted, MAIN_CANVAS, screenX!, screenY!);
      assertAlmostEquals(tiltWorld.x, flatWorld.x, looseEps);
      assertAlmostEquals(tiltWorld.y, flatWorld.y, looseEps);
    }

    const flatAabb = visibleGroundAABB(flat, MAIN_CANVAS);
    const tiltAabb = visibleGroundAABB(tilted, MAIN_CANVAS);
    assertAlmostEquals(tiltAabb.x, flatAabb.x, looseEps);
    assertAlmostEquals(tiltAabb.y, flatAabb.y, looseEps);
    assertAlmostEquals(tiltAabb.w, flatAabb.w, looseEps);
    assertAlmostEquals(tiltAabb.h, flatAabb.h, looseEps);
  },
);

Deno.test(
  "visibleGroundAABB height grows monotonically with pitch",
  () => {
    const base = makeCamera(MAP_PX_W / 2, MAP_PX_H / 2, SCALE);
    const pitches = [0, 0.05, 0.15, 0.3, Math.PI / 6];
    let prevHeight = -Infinity;
    let prevWidth: number | undefined;
    for (const pitch of pitches) {
      const cam: CameraState = { ...base, pitch };
      const aabb = visibleGroundAABB(cam, MAIN_CANVAS);
      assert(
        aabb.h > prevHeight,
        `AABB height should grow with pitch; prev=${prevHeight}, cur=${aabb.h} at pitch=${pitch}`,
      );
      prevHeight = aabb.h;
      // Width must stay constant — tilt only stretches Y.
      if (prevWidth !== undefined) {
        assertAlmostEquals(aabb.w, prevWidth, TILT_EPS);
      }
      prevWidth = aabb.w;
    }
  },
);

function makeCamera(
  centerX: number,
  centerY: number,
  zoom: number,
): CameraState {
  return { center: { x: centerX, y: centerY }, zoom, pitch: 0 };
}

Deno.test("fitWorldRect under tilt contains the rect in screen space", () => {
  const pitches = [0, 0.1, 0.3, Math.PI / 6, Math.PI / 4];
  const rects: Viewport[] = [
    { x: 100, y: 50, w: 200, h: 100 },
    { x: 300, y: 200, w: 64, h: 64 },
    { x: 0, y: 0, w: MAP_PX_W, h: MAP_PX_H },
  ];
  for (const pitch of pitches) {
    const base: CameraState = { center: { x: 0, y: 0 }, zoom: 1, pitch };
    for (const rect of rects) {
      const fit = fitWorldRect(base, rect, MAIN_CANVAS);
      assertEquals(fit.pitch, pitch);
      // Centre of the fitted camera must coincide with the rect centre.
      assertAlmostEquals(fit.center.x, rect.x + rect.w / 2, TILT_EPS);
      assertAlmostEquals(fit.center.y, rect.y + rect.h / 2, TILT_EPS);
      // Every rect corner must land inside [0, canvas] after projection.
      const corners = [
        { x: rect.x, y: rect.y },
        { x: rect.x + rect.w, y: rect.y },
        { x: rect.x, y: rect.y + rect.h },
        { x: rect.x + rect.w, y: rect.y + rect.h },
      ];
      for (const corner of corners) {
        const { sx, sy } = worldToScreen(fit, MAIN_CANVAS, corner.x, corner.y);
        assert(
          sx >= -1e-6 && sx <= MAIN_CANVAS.w + 1e-6,
          `corner (${corner.x},${corner.y}) sx=${sx} out of [0,${MAIN_CANVAS.w}] at pitch=${pitch}`,
        );
        assert(
          sy >= -1e-6 && sy <= MAIN_CANVAS.h + 1e-6,
          `corner (${corner.x},${corner.y}) sy=${sy} out of [0,${MAIN_CANVAS.h}] at pitch=${pitch}`,
        );
      }
    }
  }
});

Deno.test("pitch at or beyond MAX_PITCH throws with a clear message", () => {
  const nearMax: CameraState = {
    center: { x: 0, y: 0 },
    zoom: 1,
    pitch: MAX_PITCH,
  };
  const beyond: CameraState = {
    center: { x: 0, y: 0 },
    zoom: 1,
    pitch: MAX_PITCH + 0.1,
  };
  for (const cam of [nearMax, beyond]) {
    let caught: Error | undefined;
    try {
      worldToScreen(cam, MAIN_CANVAS, 0, 0);
    } catch (error) {
      caught = error as Error;
    }
    assert(caught, `pitch=${cam.pitch} should have thrown`);
    assert(
      caught!.message.includes("MAX_PITCH"),
      `error message should mention MAX_PITCH, got: ${caught!.message}`,
    );
  }
});

Deno.test("pitch just below MAX_PITCH still works", () => {
  const cam: CameraState = {
    center: { x: 100, y: 100 },
    zoom: 4,
    pitch: MAX_PITCH - 1e-4,
  };
  const { sx, sy } = worldToScreen(cam, MAIN_CANVAS, 100, 100);
  assertAlmostEquals(sx, MAIN_CANVAS.w / 2, TILT_EPS);
  assertAlmostEquals(sy, MAIN_CANVAS.h / 2, TILT_EPS);
});

Deno.test("non-finite pitch throws", () => {
  const nan: CameraState = { center: { x: 0, y: 0 }, zoom: 1, pitch: NaN };
  let threw = false;
  try {
    worldToScreen(nan, MAIN_CANVAS, 0, 0);
  } catch (_error) {
    threw = true;
  }
  assert(threw, "NaN pitch should throw");
});
