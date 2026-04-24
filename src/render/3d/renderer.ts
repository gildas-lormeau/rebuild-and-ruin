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

import type { GameMap, Viewport } from "../../shared/core/geometry-types.ts";
import {
  CANVAS_H,
  CANVAS_W,
  MAP_PX_H,
  MAP_PX_W,
  OFFSCREEN_SCALE,
  TOP_MARGIN_CANVAS_PX,
  TOP_MARGIN_MAP_PX,
} from "../../shared/core/grid.ts";
import type {
  RendererInterface,
  RenderOverlay,
} from "../../shared/ui/overlay-types.ts";
import { createCanvasRenderer } from "../render-canvas.ts";
import { createLoupe } from "../render-loupe.ts";
import { updateCameraFromViewport } from "./camera.ts";
import type { FrameCtx } from "./frame-ctx.ts";
import { isPerfHudEnabled, updatePerfHud } from "./perf-hud.ts";
import { createRender3dScene, type Render3dContext } from "./scene.ts";

export function createRender3d(
  worldCanvas: HTMLCanvasElement,
  uiCanvas: HTMLCanvasElement,
): RendererInterface {
  // Delegate 2D work (including UI) to the existing canvas renderer.
  // `reserveTopStrip` is a construction-time flag: the 2D canvas is
  // sized with the extra strip for EVERY overlay (game, lobby, options,
  // controls) so its aspect ratio always matches the 3D worldCanvas
  // (which grew unconditionally below). Per-frame flipping would
  // cause mid-overlay aspect jumps — e.g. lobby would letterbox
  // differently than gameplay, shifting everything.
  const canvas2d = createCanvasRenderer(uiCanvas, { reserveTopStrip: true });

  // Match the world canvas's internal resolution to the 2D canvas so the
  // two stack 1:1 under CSS `object-fit: contain`. The extra
  // TOP_MARGIN_MAP_PX rows at the top host the reserved strip
  // (`overlay.ui.reserveTopStrip` — see runtime-render.ts); scene
  // rendering shifts down so the map occupies the bottom MAP_PX_H rows
  // and world-Y=0 aligns with the top of the game area on the 2D
  // canvas. Canvas dims stay constant across phases so CSS layout and
  // banner transitions don't jitter.
  worldCanvas.width = MAP_PX_W;
  worldCanvas.height = MAP_PX_H + TOP_MARGIN_MAP_PX;

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
    // Loupe samples the GAME AREA only. Crop the top strip off
    // `worldCanvas` (it's empty anyway — scene renders into the bottom
    // MAP_PX_H rows) so the composite's coordinate system matches the
    // 2D scene canvas at (0,0) = top-left of game area.
    loupeCompositeCtx.drawImage(
      worldCanvas,
      0,
      TOP_MARGIN_MAP_PX,
      MAP_PX_W,
      MAP_PX_H,
      destX,
      destY,
      destW,
      destH,
    );
    loupeCompositeCtx.drawImage(scene2d, 0, 0);
    return loupeCompositeCanvas;
  }

  // Scratch buffer + canvas for the 3D offscreen-capture path. Reused
  // across banner transitions. The buffer is sized to the FBO's backing-
  // store resolution (world canvas width × height); the bridge canvas
  // hosts the buffer as ImageData so it can be drawn into the compositor.
  let captureWorldPixels: Uint8Array | undefined;
  let captureWorldImageData: ImageData | undefined;
  let captureWorldBridgeCanvas: HTMLCanvasElement | undefined;
  let captureWorldBridgeCtx: CanvasRenderingContext2D | undefined;

  // Separate composite scratch canvas for the offscreen path so it doesn't
  // share state with the visible-canvas `captureScene` path (which may run
  // on the same tick for the A-snapshot).
  let offscreenCompositeCanvas: HTMLCanvasElement | undefined;
  let offscreenCompositeCtx: CanvasRenderingContext2D | undefined;

  // Composite a 2D UI snapshot (canvas) on top of a composite canvas
  // scaled to fill (targetW × targetH). Shared by the visible-canvas
  // capture path (`captureScene`) and the offscreen-capture path
  // (`captureSceneOffscreen`) so both composite the 2D UI identically.
  function compositeUiSnapshot(
    destCtx: CanvasRenderingContext2D,
    uiSnapshot: HTMLCanvasElement,
    targetW: number,
    targetH: number,
  ): void {
    destCtx.drawImage(
      uiSnapshot,
      0,
      0,
      uiSnapshot.width,
      uiSnapshot.height,
      0,
      0,
      targetW,
      targetH,
    );
  }

  // Runs the per-frame scene-graph updates + camera setup and renders into
  // the capture FBO. Shared by `drawFrame` (paired with a blit to the
  // default framebuffer so the user sees the result) and `captureSceneOffscreen`
  // (paired with a readback so the pixels go straight to CPU without
  // touching the visible canvas). The function never writes to the
  // default framebuffer itself — callers do that (or deliberately skip it).
  function renderSceneToFBO(
    map: GameMap,
    overlay: RenderOverlay | undefined,
    viewport: Viewport | null | undefined,
    now: number,
    pitch: number,
  ): void {
    ctx.terrain.ensureBuilt(map);
    const frame: FrameCtx = { overlay, map, now };
    ctx.terrain.update(frame);
    ctx.walls.update(frame);
    ctx.towers.update(frame);
    ctx.towerLabels.update(frame);
    ctx.houses.update(frame);
    ctx.debris.update(frame);
    ctx.cannons.update(frame);
    ctx.grunts.update(frame);
    ctx.cannonballs.update(frame);
    ctx.pits.update(frame);
    ctx.balloons.update(frame);
    ctx.phantoms.update(frame);
    ctx.impacts.update(frame);
    ctx.wallBurns.update(frame);
    ctx.cannonBurns.update(frame);
    ctx.crosshairs.update(frame);
    ctx.fog.update(frame);
    ctx.thawing.update(frame);
    ctx.terrainBitmap.update(frame);
    ctx.sinkholeOverlay.update(frame);
    ctx.bonusSquares.update(frame);
    ctx.waterWaves.update(frame);
    updateCameraFromViewport(ctx.camera, viewport, pitch);
    lastViewport = viewport ?? undefined;
    lastPitch = pitch;
    ctx.renderer.setRenderTarget(ctx.captureTarget);
    ctx.renderer.setViewport(0, 0, worldCanvas.width, worldCanvas.height);
    ctx.renderer.clear();
    ctx.renderer.render(ctx.scene, ctx.camera);
    ctx.renderer.setRenderTarget(null);
  }

  return {
    warmMapCache: (map) => {
      canvas2d.warmMapCache(map);
      // Phase 2: ensure the terrain mesh is ready before the first frame. The
      // geometry is fixed-size so the "build" step is cheap; `update` fills
      // in colors each frame.
      ctx.terrain.ensureBuilt(map);
    },
    drawFrame: (
      map,
      overlay,
      viewport,
      now,
      pitch = 0,
      skip3DScene = false,
    ) => {
      // Phase 2: render the WebGL scene (terrain mesh, driven by the runtime
      // viewport) behind the 2D canvas. The 2D renderer still handles
      // castles, entities, and UI; Phase 3+ progressively moves them off
      // the 2D path.
      //
      // `skip3DScene` short-circuits the whole 3D pipeline: during
      // banners, the 2D canvas composites a pre-captured scene snapshot
      // over everything below the banner strip, so re-rendering the
      // live 3D scene is pure waste (fully occluded). We keep the
      // WebGL framebuffer at its last-rendered contents; the snapshot
      // image is what the player sees underneath the banner art. The
      // 2D `canvas2d.drawFrame` call below MUST still run to draw the
      // banner sweep animation.
      if (!skip3DScene) {
        // Render the scene once into the capture FBO (readable outside
        // the rAF tick by `captureScene`), then blit that FBO's texture
        // to the default framebuffer via a fullscreen quad. The blit is
        // a single fragment-shader pass — much cheaper than re-rendering
        // the whole scene. Avoids both `preserveDrawingBuffer: true`
        // (per-frame backbuffer-preservation overhead) and the prior
        // double-scene-render approach.
        //
        // Scene viewport: render into the FULL FBO (height
        // MAP_PX_H + TOP_MARGIN_MAP_PX). The reserved top strip is
        // realized by the frustum extension in `updateCameraFromViewport`
        // — geometry outside that extended range (above `rect.y -
        // stripWorld`) is simply out of frustum and leaves the top rows
        // at the clear color; tall walls at row 0 project *into* the
        // strip under tilt, which is the whole purpose of the strip.
        renderSceneToFBO(map, overlay, viewport, now, pitch);
        ctx.renderer.clear();
        ctx.renderer.render(ctx.blitScene, ctx.blitCamera);
      }
      canvas2d.drawFrame(map, overlay, viewport, now);
      if (isPerfHudEnabled()) {
        const info = ctx.renderer.info;
        updatePerfHud(
          {
            drawCalls: info.render.calls,
            triangles: info.render.triangles,
            geometries: info.memory.geometries,
            textures: info.memory.textures,
            programs: info.programs?.length ?? 0,
          },
          now,
        );
      }
    },
    // 2D `clientToSurface` returns raw backing-store canvas pixels.
    // In 3D mode the display canvas is TOP_MARGIN_CANVAS_PX taller
    // than the game area (reserved strip above row 0 — see
    // runtime-render.ts `reserveTopStrip`). Subtract the strip offset
    // so (0, 0) reported by `clientToSurface` is the top-left of the
    // GAME AREA — same contract as in 2D mode, so downstream consumers
    // (mouse handlers, touch, hit-tests) don't branch on renderer
    // kind. A click inside the top strip returns a negative y, which
    // game-world hit-tests reject as off-map.
    clientToSurface: (clientX, clientY) => {
      const raw = canvas2d.clientToSurface(clientX, clientY);
      return { x: raw.x, y: raw.y - TOP_MARGIN_CANVAS_PX };
    },
    // `screenToContainerCSS` is the inverse coupling of `clientToSurface`:
    // callers feed it screen-pixel coords from `worldToScreen`, which
    // projects against a CANVAS_H-sized canvas (the game area), so sy=0
    // means "top of the game area". The actual display canvas in 3D is
    // TOP_MARGIN_CANVAS_PX taller, so add the strip offset before
    // delegating to the 2D impl — otherwise floating UI (dpad, confirm
    // buttons) renders one-tile too high.
    screenToContainerCSS: (sx, sy) =>
      canvas2d.screenToContainerCSS(sx, sy + TOP_MARGIN_CANVAS_PX),
    // Banner prev-scene snapshot in 3D mode: composite the live WebGL
    // world canvas (already viewport-cropped + tilted from the last
    // `drawFrame`) with the 2D display canvas (castles, UI, anything not
    // yet migrated) at display resolution. The snapshot therefore
    // reflects exactly what was on screen at capture time — no camera
    // reset, no re-render. `captureScene` runs synchronously from the
    // phase-transition hook immediately after the most recent
    // `drawFrame`, so `worldCanvas` is live — no need for
    // `preserveDrawingBuffer` or an FBO readback. `drawImage(worldCanvas)`
    // is a native browser canvas→canvas copy; any alpha round-trip
    // through `readRenderTargetPixels` / ImageData would double-apply
    // premultiplication and darken the snapshot, which used to surface
    // as a visibly-dimmer scene below the banner strip.
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
      // Crop off the reserved top strip from the world canvas: the
      // captured snapshot represents the GAME AREA only, so banner
      // prev-scene composition aligns with the 2D path's snapshot
      // (which is also game-area-only — see render-map.ts captureScene).
      // Source rect: worldCanvas rows [TOP_MARGIN_MAP_PX, height).
      captureCompositeCtx.drawImage(
        worldCanvas,
        0,
        TOP_MARGIN_MAP_PX,
        MAP_PX_W,
        MAP_PX_H,
        0,
        0,
        targetW,
        targetH,
      );
      // 2. Paint the 2D display canvas on top.
      compositeUiSnapshot(captureCompositeCtx, uiSnapshot, targetW, targetH);
      return captureCompositeCanvas;
    },
    // Flash-free B-snapshot capture for banners. Runs the full render
    // pipeline (entity updates + WebGL scene render + 2D UI draw) against
    // offscreen-only targets: the WebGL scene renders into the capture
    // FBO and is read back via `readRenderTargetPixels` (we skip the
    // fullscreen-quad blit that would otherwise paint the visible canvas),
    // and the 2D UI paints into a hidden sibling canvas via the 2D
    // renderer's `captureSceneOffscreen`. Both are composited into a
    // display-sized ImageData and returned. The visible WebGL canvas and
    // the visible 2D canvas are both untouched — the user never sees the
    // post-mutation scene before the banner's progressive reveal reaches
    // it. Returns undefined when the 2D path hasn't rendered a frame yet
    // (matches the `captureScene` contract).
    captureSceneOffscreen: (map, overlay, viewport, now, pitch = 0) => {
      const uiSnapshot = canvas2d.captureSceneOffscreen(
        map,
        overlay,
        viewport,
        now,
      );
      if (!uiSnapshot) return undefined;
      // Render the 3D scene into the capture FBO — same setup as
      // `drawFrame`'s 3D branch, but without the subsequent blit to the
      // default framebuffer. The FBO holds premultiplied-alpha pixels;
      // `readRenderTargetPixels` delivers them unchanged, and we paint
      // them through an ImageData bridge below (browsers interpret
      // ImageData as straight alpha, so premultiplication must be
      // undone — see the per-pixel unpremultiply loop).
      renderSceneToFBO(map, overlay, viewport, now, pitch);
      const fboW = worldCanvas.width;
      const fboH = worldCanvas.height;
      const byteLen = fboW * fboH * 4;
      if (!captureWorldPixels || captureWorldPixels.length !== byteLen) {
        captureWorldPixels = new Uint8Array(byteLen);
      }
      ctx.renderer.readRenderTargetPixels(
        ctx.captureTarget,
        0,
        0,
        fboW,
        fboH,
        captureWorldPixels,
      );
      if (
        !captureWorldImageData ||
        captureWorldImageData.width !== fboW ||
        captureWorldImageData.height !== fboH
      ) {
        captureWorldImageData = new ImageData(fboW, fboH);
      }
      // Flip Y and unpremultiply alpha in one pass.
      //   Flip Y: `readRenderTargetPixels` returns pixels in GL order
      //   (bottom-up), but ImageData is top-down — row 0 of the FBO maps
      //   to row (fboH-1) of the ImageData.
      //   Unpremultiply: the FBO stores RGB pre-multiplied by alpha. An
      //   ImageData with straight alpha would render darker than the
      //   blit path (which uses a custom blend matching the premultiplied
      //   backbuffer). Scale RGB back up by 255/alpha when alpha > 0.
      const src = captureWorldPixels;
      const dst = captureWorldImageData.data;
      for (let y = 0; y < fboH; y++) {
        const srcRow = (fboH - 1 - y) * fboW * 4;
        const dstRow = y * fboW * 4;
        for (let x = 0; x < fboW; x++) {
          const srcIdx = srcRow + x * 4;
          const dstIdx = dstRow + x * 4;
          const red = src[srcIdx]!;
          const green = src[srcIdx + 1]!;
          const blue = src[srcIdx + 2]!;
          const alpha = src[srcIdx + 3]!;
          if (alpha === 0 || alpha === 255) {
            dst[dstIdx] = red;
            dst[dstIdx + 1] = green;
            dst[dstIdx + 2] = blue;
          } else {
            const scale = 255 / alpha;
            dst[dstIdx] = Math.min(255, Math.round(red * scale));
            dst[dstIdx + 1] = Math.min(255, Math.round(green * scale));
            dst[dstIdx + 2] = Math.min(255, Math.round(blue * scale));
          }
          dst[dstIdx + 3] = alpha;
        }
      }
      // Paint the world ImageData onto a bridge canvas so it can be drawn
      // into the composite at the correct game-area rect (game area =
      // FBO rows [TOP_MARGIN_MAP_PX, fboH) scaled up to CANVAS_H).
      if (!captureWorldBridgeCanvas || !captureWorldBridgeCtx) {
        captureWorldBridgeCanvas = document.createElement("canvas");
        captureWorldBridgeCtx = captureWorldBridgeCanvas.getContext("2d", {
          willReadFrequently: true,
        })!;
      }
      if (
        captureWorldBridgeCanvas.width !== fboW ||
        captureWorldBridgeCanvas.height !== fboH
      ) {
        captureWorldBridgeCanvas.width = fboW;
        captureWorldBridgeCanvas.height = fboH;
        captureWorldBridgeCtx.imageSmoothingEnabled = false;
      }
      captureWorldBridgeCtx.putImageData(captureWorldImageData, 0, 0);

      const targetW = CANVAS_W;
      const targetH = CANVAS_H;
      if (!offscreenCompositeCanvas || !offscreenCompositeCtx) {
        offscreenCompositeCanvas = document.createElement("canvas");
        offscreenCompositeCtx = offscreenCompositeCanvas.getContext("2d", {
          willReadFrequently: true,
        })!;
      }
      if (
        offscreenCompositeCanvas.width !== targetW ||
        offscreenCompositeCanvas.height !== targetH
      ) {
        offscreenCompositeCanvas.width = targetW;
        offscreenCompositeCanvas.height = targetH;
        offscreenCompositeCtx.imageSmoothingEnabled = false;
      }
      offscreenCompositeCtx.clearRect(0, 0, targetW, targetH);
      offscreenCompositeCtx.drawImage(
        captureWorldBridgeCanvas,
        0,
        TOP_MARGIN_MAP_PX,
        MAP_PX_W,
        MAP_PX_H,
        0,
        0,
        targetW,
        targetH,
      );
      // Layer the 2D UI snapshot on top. Reuses the shared bridge canvas
      // with the visible-scene capture path — the two paths never
      // interleave within one synchronous call sequence (A via
      // `captureScene`, then B via `captureSceneOffscreen`), so sharing is
      // safe.
      compositeUiSnapshot(offscreenCompositeCtx, uiSnapshot, targetW, targetH);
      return offscreenCompositeCanvas;
    },
    // Runtime polls this between battle-end and camera untilt so the
    // transition waits for the cannons' rotation-back-to-rest ease to
    // complete — frame-synced instead of wall-clock timed. 2D path
    // doesn't ease facings, so only the 3D manager contributes.
    isCannonRotationEasing: () => ctx.cannons.isEasing(),
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
