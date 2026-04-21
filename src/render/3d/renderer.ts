/**
 * Three.js implementation of `RendererInterface`.
 *
 * Hybrid design (see docs/3d-renderer-migration.md): the 3D renderer owns
 * the WebGL context on `#world-canvas` AND delegates to the 2D canvas
 * renderer for everything it doesn't yet handle. In Phase 0 the 2D
 * renderer still draws the entire frame (terrain, sprites, UI) to the
 * overlay canvas; the WebGL canvas just clears transparent. Subsequent
 * phases progressively move work from the 2D path to the 3D path
 * (Phase 2 terrain, Phase 3 static entities, …). By the end the 2D
 * renderer only draws UI.
 */

import type { Viewport } from "../../shared/core/geometry-types.ts";
import {
  CANVAS_H,
  CANVAS_W,
  MAP_PX_H,
  MAP_PX_W,
  OFFSCREEN_SCALE,
} from "../../shared/core/grid.ts";
import type { RendererInterface } from "../../shared/ui/overlay-types.ts";
import { createCanvasRenderer } from "../render-canvas.ts";
import { createLoupe } from "../render-loupe.ts";
import { updateCameraFromViewport } from "./camera.ts";
import type { FrameCtx } from "./frame-ctx.ts";
import { createRender3dScene, type Render3dContext } from "./scene.ts";

export function createRender3d(
  worldCanvas: HTMLCanvasElement,
  uiCanvas: HTMLCanvasElement,
): RendererInterface {
  // Delegate 2D work (including UI) to the existing canvas renderer.
  const canvas2d = createCanvasRenderer(uiCanvas);

  // Match the world canvas's internal resolution to the 2D canvas so Phase 1
  // can pin the camera to the same pixel grid. CSS `object-fit: contain`
  // handles external letterboxing identically to the 2D canvas.
  worldCanvas.width = MAP_PX_W;
  worldCanvas.height = MAP_PX_H;

  const ctx: Render3dContext = createRender3dScene(
    worldCanvas,
    canvas2d.getTerrainBitmap,
    canvas2d.getSinkholeOverlayBitmap,
  );

  // Cached viewport + pitch from the last `drawFrame`. Used by the
  // loupe composite (draws the WebGL world canvas at the correct
  // world-space rect) and by the loupe's `worldToScene` mapper (folds
  // the X-axis tilt into the world→scene projection so the source
  // rect stays centered on the cursor even when the scene is tilted).
  let lastViewport: Viewport | undefined;
  let lastPitch = 0;

  // Banner prev-scene snapshot scratch canvases. Lazily created on first
  // capture; reused across phase transitions. The composite canvas matches
  // the display canvas dimensions (CANVAS_W × CANVAS_H) so the returned
  // ImageData reflects exactly what was on screen at capture time.
  let captureCompositeCanvas: HTMLCanvasElement | undefined;
  let captureCompositeCtx: CanvasRenderingContext2D | undefined;
  let captureBridgeCanvas: HTMLCanvasElement | undefined;
  let captureBridgeCtx: CanvasRenderingContext2D | undefined;
  // Scratch canvas used to stage FBO pixels before stretching into the
  // composite. Sized to the world canvas backing-store (MAP_PX_W ×
  // MAP_PX_H). Kept separate from `captureBridgeCanvas` (which sizes
  // to the 2D ImageData) because the two scales differ.
  let captureFboCanvas: HTMLCanvasElement | undefined;
  let captureFboCtx: CanvasRenderingContext2D | undefined;
  let captureFboPixels: Uint8ClampedArray | undefined;

  // Loupe source canvas — a WebGL+2D composite. The loupe samples this
  // each frame to magnify "what the user sees", which in 3D mode is the
  // world canvas (terrain + entities) overlaid with whatever the 2D
  // renderer still draws (castles, UI). Lazily created on first access;
  // sized to the 2D scene canvas so the magnification math in
  // `render-loupe.ts` stays unchanged.
  let loupeCompositeCanvas: HTMLCanvasElement | undefined;
  let loupeCompositeCtx: CanvasRenderingContext2D | undefined;
  function loupeCompositeSource(): HTMLCanvasElement {
    const scene2d = canvas2d.sceneCanvas();
    const targetW = scene2d.width;
    const targetH = scene2d.height;
    if (!loupeCompositeCanvas || !loupeCompositeCtx) {
      loupeCompositeCanvas = document.createElement("canvas");
      loupeCompositeCtx = loupeCompositeCanvas.getContext("2d", {
        willReadFrequently: false,
      })!;
    }
    if (
      loupeCompositeCanvas.width !== targetW ||
      loupeCompositeCanvas.height !== targetH
    ) {
      loupeCompositeCanvas.width = targetW;
      loupeCompositeCanvas.height = targetH;
      loupeCompositeCtx.imageSmoothingEnabled = false;
    }
    loupeCompositeCtx.clearRect(0, 0, targetW, targetH);
    // `worldCanvas` contains the viewport-cropped view stretched to
    // fill MAP_PX_W × MAP_PX_H, so it must be drawn into the composite
    // at the viewport's world-space rect — NOT at (0,0)-fullmap. Source
    // = full worldCanvas; dest = `lastViewport` × OFFSCREEN_SCALE. When
    // no viewport crop is active (`lastViewport === undefined`) the
    // viewport is the whole map, and dest collapses to the full
    // composite. The 2D scene canvas is already at full-map coords, so
    // it draws at (0,0).
    const viewport = lastViewport;
    const destX = (viewport?.x ?? 0) * OFFSCREEN_SCALE;
    const destY = (viewport?.y ?? 0) * OFFSCREEN_SCALE;
    const destW = (viewport?.w ?? MAP_PX_W) * OFFSCREEN_SCALE;
    const destH = (viewport?.h ?? MAP_PX_H) * OFFSCREEN_SCALE;
    loupeCompositeCtx.drawImage(
      worldCanvas,
      0,
      0,
      worldCanvas.width,
      worldCanvas.height,
      destX,
      destY,
      destW,
      destH,
    );
    loupeCompositeCtx.drawImage(scene2d, 0, 0);
    return loupeCompositeCanvas;
  }

  // Phase 2: tell the 2D renderer to stop drawing the terrain layer. The 3D
  // path renders terrain into `worldCanvas` beneath the UI canvas, and the
  // UI canvas remains transparent in those regions (via the CSS rule that
  // clears the UI canvas' background to transparent in 3D mode). Every other
  // 2D layer (castles, entities, banners, UI) still renders normally — later
  // phases flip more layers off.
  canvas2d.setLayersEnabled({
    terrain: false,
    walls: false,
    interiors: false,
    towers: false,
    houses: false,
    debris: false,
    cannons: false,
    grunts: false,
    cannonballs: false,
    pits: false,
    balloons: false,
    impacts: false,
    crosshairs: false,
    fog: false,
    thawingTiles: false,
    phantoms: false,
  });

  return {
    warmMapCache: (map) => {
      canvas2d.warmMapCache(map);
      // Phase 2: ensure the terrain mesh is ready before the first frame. The
      // geometry is fixed-size so the "build" step is cheap; `update` fills
      // in colors each frame.
      ctx.terrain.ensureBuilt(map);
    },
    drawFrame: (map, overlay, viewport, now, pitch = 0) => {
      // Phase 2: render the WebGL scene (terrain mesh, driven by the runtime
      // viewport) behind the 2D canvas. The 2D renderer still handles
      // castles, entities, and UI; Phase 3+ progressively moves them off
      // the 2D path.
      ctx.terrain.ensureBuilt(map);
      // Build the per-frame context once and hand the same object to
      // every manager — each one unpacks only the fields it needs. The
      // lifecycle call `terrain.ensureBuilt(map)` stays outside this
      // contract because it's not a per-frame update.
      const frame: FrameCtx = { overlay, map, now };
      ctx.terrain.update(frame);
      ctx.walls.update(frame);
      ctx.towers.update(frame);
      ctx.houses.update(frame);
      ctx.debris.update(frame);
      ctx.cannons.update(frame);
      ctx.grunts.update(frame);
      ctx.cannonballs.update(frame);
      ctx.pits.update(frame);
      ctx.balloons.update(frame);
      ctx.phantoms.update(frame);
      ctx.impacts.update(frame);
      ctx.crosshairs.update(frame);
      ctx.fog.update(frame);
      ctx.thawing.update(frame);
      ctx.terrainBitmap.update(frame);
      ctx.sinkholeOverlay.update(frame);
      ctx.bonusSquares.update(frame);
      ctx.waterWaves.update(frame);
      // Camera: ortho view driven by the runtime viewport, tilted by
      // `pitch` (radians, X-axis tilt). Runtime-camera animates pitch
      // toward a phase-specific target so battle renders with a
      // classic Rampart 3/4 view. The 2D overlay is still drawn
      // straight-down — it only carries UI + still-2D layers that
      // are unaffected by tilt.
      updateCameraFromViewport(ctx.camera, viewport, pitch);
      lastViewport = viewport ?? undefined;
      lastPitch = pitch;
      // Render twice: once into the capture FBO (readable outside the
      // rAF tick by `captureScene`), once to the default framebuffer
      // for display. Cheaper than rebuilding the scene state at capture
      // time and doesn't require `preserveDrawingBuffer: true` (which
      // keeps the on-screen backbuffer alive between swaps at a per-
      // frame perf cost). The scene is small enough that doubling the
      // render pass is a measurable wash against the preserved-buffer
      // overhead on mid-range GPUs.
      ctx.renderer.setRenderTarget(ctx.captureTarget);
      ctx.renderer.clear();
      ctx.renderer.render(ctx.scene, ctx.camera);
      ctx.renderer.setRenderTarget(null);
      ctx.renderer.clear();
      ctx.renderer.render(ctx.scene, ctx.camera);
      canvas2d.drawFrame(map, overlay, viewport, now);
    },
    setLayersEnabled: canvas2d.setLayersEnabled,
    // Top-down ortho — the UI canvas has the same aspect ratio as the
    // world canvas (status bar is hidden in 3D mode), so the 2D
    // projection is correct as-is.
    clientToSurface: canvas2d.clientToSurface,
    screenToContainerCSS: canvas2d.screenToContainerCSS,
    // Banner prev-scene snapshot in 3D mode: composite the WebGL render
    // target (already viewport-cropped + tilted from the last `drawFrame`)
    // with the 2D display canvas (castles, UI, anything not yet migrated)
    // at display resolution. The snapshot therefore reflects exactly what
    // was on screen at capture time — no camera reset, no re-render.
    // Returns `undefined` when the 2D display hasn't been initialized yet
    // (matches the 2D path's "no scene to capture" signal).
    captureScene: () => {
      const uiSnapshot = canvas2d.captureScene();
      if (!uiSnapshot) return undefined;
      const targetW = CANVAS_W;
      const targetH = CANVAS_H;
      if (!captureCompositeCanvas || !captureCompositeCtx) {
        captureCompositeCanvas = document.createElement("canvas");
        captureCompositeCtx = captureCompositeCanvas.getContext("2d", {
          willReadFrequently: true,
        })!;
      }
      if (
        captureCompositeCanvas.width !== targetW ||
        captureCompositeCanvas.height !== targetH
      ) {
        captureCompositeCanvas.width = targetW;
        captureCompositeCanvas.height = targetH;
        captureCompositeCtx.imageSmoothingEnabled = false;
      }
      captureCompositeCtx.clearRect(0, 0, targetW, targetH);
      // 1. Stage the FBO pixels in an intermediate canvas, then stretch
      //    into the composite. `readRenderTargetPixels` returns RGBA in
      //    WebGL Y-up order; the canvas 2D context is Y-down, so a
      //    `scale(1, -1)` transform on `drawImage` flips vertically. The
      //    FBO is live after every `drawFrame`, so this path works
      //    outside the rAF tick (no `preserveDrawingBuffer`).
      const fboW = worldCanvas.width;
      const fboH = worldCanvas.height;
      const pixelCount = fboW * fboH * 4;
      if (!captureFboPixels || captureFboPixels.length !== pixelCount) {
        captureFboPixels = new Uint8ClampedArray(pixelCount);
      }
      ctx.renderer.readRenderTargetPixels(
        ctx.captureTarget,
        0,
        0,
        fboW,
        fboH,
        captureFboPixels,
      );
      if (!captureFboCanvas || !captureFboCtx) {
        captureFboCanvas = document.createElement("canvas");
        captureFboCtx = captureFboCanvas.getContext("2d", {
          willReadFrequently: true,
        })!;
      }
      if (captureFboCanvas.width !== fboW || captureFboCanvas.height !== fboH) {
        captureFboCanvas.width = fboW;
        captureFboCanvas.height = fboH;
        captureFboCtx.imageSmoothingEnabled = false;
      }
      const fboImageData = captureFboCtx.createImageData(fboW, fboH);
      fboImageData.data.set(captureFboPixels);
      captureFboCtx.putImageData(fboImageData, 0, 0);
      captureCompositeCtx.save();
      captureCompositeCtx.translate(0, targetH);
      captureCompositeCtx.scale(1, -1);
      captureCompositeCtx.drawImage(
        captureFboCanvas,
        0,
        0,
        fboW,
        fboH,
        0,
        0,
        targetW,
        targetH,
      );
      captureCompositeCtx.restore();
      // 2. Paint the 2D display canvas on top. The 2D path returns a
      //    CANVAS_W × CANVAS_H ImageData of the display's game region —
      //    putImageData ignores context transforms, so bridge through an
      //    intermediate canvas.
      if (!captureBridgeCanvas || !captureBridgeCtx) {
        captureBridgeCanvas = document.createElement("canvas");
        captureBridgeCtx = captureBridgeCanvas.getContext("2d", {
          willReadFrequently: true,
        })!;
      }
      if (
        captureBridgeCanvas.width < uiSnapshot.width ||
        captureBridgeCanvas.height < uiSnapshot.height
      ) {
        captureBridgeCanvas.width = Math.max(
          captureBridgeCanvas.width,
          uiSnapshot.width,
        );
        captureBridgeCanvas.height = Math.max(
          captureBridgeCanvas.height,
          uiSnapshot.height,
        );
        captureBridgeCtx.imageSmoothingEnabled = false;
      }
      captureBridgeCtx.putImageData(uiSnapshot, 0, 0);
      captureCompositeCtx.drawImage(
        captureBridgeCanvas,
        0,
        0,
        uiSnapshot.width,
        uiSnapshot.height,
        0,
        0,
        targetW,
        targetH,
      );
      return captureCompositeCtx.getImageData(0, 0, targetW, targetH);
    },
    eventTarget: canvas2d.eventTarget,
    container: canvas2d.container,
    // Loupe samples a WebGL+2D composite (not the 2D scene alone,
    // which in 3D mode is missing terrain + entities). Under tilt the
    // scene canvas Y of a world point is not `worldY * OFFSCREEN_SCALE`
    // anymore — the WebGL render has foreshortened Y by `cos(pitch)`
    // around the viewport's center, and the composite stretch preserves
    // that. Reproduce the same transform here so the loupe's source
    // rect centers on the cursor's true scene position.
    createLoupe: (container) =>
      createLoupe(container, loupeCompositeSource, (worldX, worldY) => {
        const viewport = lastViewport;
        const centerY = (viewport?.y ?? 0) + (viewport?.h ?? MAP_PX_H) / 2;
        const cosPitch = Math.cos(lastPitch);
        return {
          x: worldX * OFFSCREEN_SCALE,
          y: (centerY + cosPitch * (worldY - centerY)) * OFFSCREEN_SCALE,
        };
      }),
  };
}
