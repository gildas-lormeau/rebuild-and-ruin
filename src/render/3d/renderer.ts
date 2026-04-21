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
  TILE_SIZE,
  TOP_MARGIN_CANVAS_PX,
  TOP_MARGIN_MAP_PX,
} from "../../shared/core/grid.ts";
import type { RendererInterface } from "../../shared/ui/overlay-types.ts";
import { createCanvasRenderer } from "../render-canvas.ts";
import {
  createLoupe,
  LOUPE_SOURCE_TILES_H,
  LOUPE_SOURCE_TILES_W,
} from "../render-loupe.ts";
import { updateCameraFromViewport } from "./camera.ts";
import type { FrameCtx } from "./frame-ctx.ts";
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

  // Banner prev-scene snapshot scratch canvases. Lazily created on first
  // capture; reused across phase transitions. The composite canvas matches
  // the display canvas dimensions (CANVAS_W × CANVAS_H) so the returned
  // ImageData reflects exactly what was on screen at capture time.
  let captureCompositeCanvas: HTMLCanvasElement | undefined;
  let captureCompositeCtx: CanvasRenderingContext2D | undefined;
  let captureBridgeCanvas: HTMLCanvasElement | undefined;
  let captureBridgeCtx: CanvasRenderingContext2D | undefined;

  // Loupe pointer state — stashed by the wrapped `LoupeHandle.update`
  // (see `createLoupe` below) every frame the touch UI runs. The
  // pre-pass is skipped entirely when loupe is hidden or when the
  // main view is already top-down (pitch === 0 — build / cannon
  // phases). When the loupe IS visible under tilt, the pre-pass
  // scissors to a window around `loupeFocus` instead of rendering
  // the whole map top-down — fragment cost drops to the scissored
  // area (roughly a LOUPE window + margin = ~11 × ~12 tiles out of
  // the whole map).
  let loupeVisible = false;
  let loupeFocusWx = 0;
  let loupeFocusWy = 0;
  // Margin (in tiles) around the LOUPE window so small pointer
  // movements between frames stay inside the scissored area — the
  // `update` callback runs AFTER `drawFrame`, so scissor bounds in
  // frame N+1 are positioned against frame N's pointer.
  const LOUPE_SCISSOR_MARGIN_TILES = 3;
  // Pre-pass runs every Nth frame when active. The scene render is
  // the single most expensive thing `drawFrame` does (scissor only
  // rejects fragments — vertex shader still runs on every primitive),
  // so cutting it in half buys back most of the budget at the cost of
  // a ~16ms staleness on the loupe image between refreshes. Pointer
  // hit-testing is unaffected; only the visible loupe pixels lag.
  const LOUPE_PREPASS_THROTTLE = 2;
  let loupeFrameCounter = 0;

  // Last main-render state — used by `loupeCompositeSource` to decide
  // whether the loupe should sample the pre-pass canvas (tilted main
  // view) or the main world canvas directly (pitch === 0 — already
  // top-down, no pre-pass this frame). `lastViewport` then positions
  // the viewport-cropped world canvas inside the loupe composite.
  let lastViewport: Viewport | undefined;
  let lastPitch = 0;

  // Loupe TOP-DOWN source — a dedicated 2D canvas that holds the full
  // map rendered at pitch=0, regardless of what the main view is doing.
  // `drawFrame` does a pre-pass into the WebGL canvas at full-map
  // pitch=0 and immediately copies the pixels here; the main tilted
  // render then runs and overwrites the WebGL canvas for display.
  // Result: the user sees the tilted 3/4 view, the loupe samples a
  // true top-down view (spec: "the loupe is always top-down").
  // Sized to the 2D scene canvas so the existing world→scene math in
  // render-loupe.ts still applies (loupe expects `worldX * OFFSCREEN_SCALE`
  // coordinates).
  let loupeTopDownCanvas: HTMLCanvasElement | undefined;
  let loupeTopDownCtx: CanvasRenderingContext2D | undefined;
  function ensureLoupeTopDownCanvas(): {
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
  } {
    const scene2d = canvas2d.sceneCanvas();
    const targetW = scene2d.width;
    const targetH = scene2d.height;
    if (!loupeTopDownCanvas || !loupeTopDownCtx) {
      loupeTopDownCanvas = document.createElement("canvas");
      loupeTopDownCtx = loupeTopDownCanvas.getContext("2d", {
        willReadFrequently: false,
      })!;
    }
    if (
      loupeTopDownCanvas.width !== targetW ||
      loupeTopDownCanvas.height !== targetH
    ) {
      loupeTopDownCanvas.width = targetW;
      loupeTopDownCanvas.height = targetH;
      loupeTopDownCtx.imageSmoothingEnabled = false;
    }
    return { canvas: loupeTopDownCanvas, context: loupeTopDownCtx };
  }

  // Loupe composite — merges the top-down world render with the 2D
  // scene canvas (UI + any game layers still on the 2D path). The
  // loupe samples this.
  //
  // When `lastPitch === 0` (build / cannon phases), the main
  // `worldCanvas` is already a top-down render at the runtime
  // viewport, so we sample IT directly — no pre-pass ran this
  // frame. When `lastPitch !== 0` (battle), the pre-pass in
  // `drawFrame` has scissored a top-down update into
  // `loupeTopDownCanvas` around the pointer; we sample that.
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
    if (lastPitch === 0) {
      // `worldCanvas` contains the viewport-cropped top-down view
      // stretched to fill MAP_PX_W × MAP_PX_H; draw it at the
      // viewport's world-space rect so the loupe's world-coord crop
      // math lands on the right pixels. Source rect crops off the
      // reserved top strip (scene renders into the bottom MAP_PX_H
      // rows only).
      const viewport = lastViewport;
      const destX = (viewport?.x ?? 0) * OFFSCREEN_SCALE;
      const destY = (viewport?.y ?? 0) * OFFSCREEN_SCALE;
      const destW = (viewport?.w ?? MAP_PX_W) * OFFSCREEN_SCALE;
      const destH = (viewport?.h ?? MAP_PX_H) * OFFSCREEN_SCALE;
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
    } else {
      const topDown = loupeTopDownCanvas;
      if (topDown) {
        loupeCompositeCtx.drawImage(topDown, 0, 0);
      }
    }
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
      // Loupe top-down pre-pass. Rendered BEFORE the main tilted pass
      // so we can snapshot a pitch=0 frame into `loupeTopDownCanvas`
      // via a 2D drawImage before the main render overwrites the WebGL
      // backbuffer. Both renders happen inside the same rAF callback,
      // so the browser composites only the final (tilted) frame — the
      // pre-pass is invisible to the user.
      //
      // Perf gates:
      //   - Skip when loupe is hidden (desktop, or touch UI hidden).
      //   - Skip when `pitch === 0` — the main render will produce a
      //     top-down worldCanvas anyway, and `loupeCompositeSource`
      //     samples IT directly in that case. This covers build /
      //     cannon phases (the only phases where the loupe is used
      //     outside battle) at zero extra GPU cost.
      //   - Throttle: run only every Nth frame (N = LOUPE_PREPASS_THROTTLE).
      //     Scissor cuts fragment work but not vertex work, so a second
      //     scene render is still expensive on mobile. Halving the rate
      //     keeps display at 60fps while loupe pixels refresh at ~30fps.
      //     Skipped frames leave the previous pre-pass's pixels in
      //     `loupeTopDownCanvas`, which `loupeCompositeSource` continues
      //     to sample — loupe image lags slightly, not black.
      //   - When active (loupe visible AND pitch != 0 AND throttle tick),
      //     scissor to just the LOUPE source window + a small margin
      //     around the pointer so fragment work stays tiny.
      const prepassDue =
        loupeVisible &&
        pitch !== 0 &&
        loupeFrameCounter % LOUPE_PREPASS_THROTTLE === 0;
      if (loupeVisible && pitch !== 0) {
        loupeFrameCounter = (loupeFrameCounter + 1) % LOUPE_PREPASS_THROTTLE;
      } else {
        loupeFrameCounter = 0;
      }
      if (prepassDue) {
        const loupeTopDown = ensureLoupeTopDownCanvas();
        const windowWpx =
          (LOUPE_SOURCE_TILES_W + 2 * LOUPE_SCISSOR_MARGIN_TILES) * TILE_SIZE;
        const windowHpx =
          (LOUPE_SOURCE_TILES_H + 2 * LOUPE_SCISSOR_MARGIN_TILES) * TILE_SIZE;
        // World-space scissor (top-down): centered on the pointer,
        // clamped to map bounds.
        const wx0 = Math.max(
          0,
          Math.min(MAP_PX_W - windowWpx, loupeFocusWx - windowWpx / 2),
        );
        const wy0 = Math.max(
          0,
          Math.min(MAP_PX_H - windowHpx, loupeFocusWy - windowHpx / 2),
        );
        // WebGL viewport origin is bottom-left. Scene renders into
        // the bottom MAP_PX_H rows of the canvas (top TOP_MARGIN_MAP_PX
        // is the reserved strip). In WebGL y coords: gl_y = MAP_PX_H - wy0 - windowH.
        const glScissorX = Math.floor(wx0);
        const glScissorY = Math.floor(MAP_PX_H - wy0 - windowHpx);
        const glScissorW = Math.ceil(windowWpx);
        const glScissorH = Math.ceil(windowHpx);
        updateCameraFromViewport(ctx.camera, undefined, 0);
        ctx.renderer.setRenderTarget(null);
        ctx.renderer.setViewport(0, 0, MAP_PX_W, MAP_PX_H);
        ctx.renderer.setScissor(glScissorX, glScissorY, glScissorW, glScissorH);
        ctx.renderer.setScissorTest(true);
        ctx.renderer.clear();
        ctx.renderer.render(ctx.scene, ctx.camera);
        ctx.renderer.setScissorTest(false);
        ctx.renderer.setViewport(0, 0, worldCanvas.width, worldCanvas.height);
        // Copy only the scissored region from the world canvas to the
        // loupe source canvas. Source rect is in CANVAS pixels (top
        // strip + world coords); dest rect is in OFFSCREEN_SCALE'd
        // loupe-canvas pixels.
        const srcX = Math.floor(wx0);
        const srcY = Math.floor(TOP_MARGIN_MAP_PX + wy0);
        const srcW = Math.ceil(windowWpx);
        const srcH = Math.ceil(windowHpx);
        const destX = Math.floor(wx0 * OFFSCREEN_SCALE);
        const destY = Math.floor(wy0 * OFFSCREEN_SCALE);
        const destW = Math.ceil(windowWpx * OFFSCREEN_SCALE);
        const destH = Math.ceil(windowHpx * OFFSCREEN_SCALE);
        loupeTopDown.context.clearRect(destX, destY, destW, destH);
        loupeTopDown.context.drawImage(
          worldCanvas,
          srcX,
          srcY,
          srcW,
          srcH,
          destX,
          destY,
          destW,
          destH,
        );
      }

      // Main tilted render — camera + pitch come from the runtime
      // viewport. The 2D overlay stays straight-down (UI layers only).
      updateCameraFromViewport(ctx.camera, viewport, pitch);
      lastViewport = viewport ?? undefined;
      lastPitch = pitch;
      // Render the scene once into the capture FBO (readable outside
      // the rAF tick by `captureScene`), then blit that FBO's texture
      // to the default framebuffer via a fullscreen quad. The blit is
      // a single fragment-shader pass — much cheaper than re-rendering
      // the whole scene. Avoids both `preserveDrawingBuffer: true`
      // (per-frame backbuffer-preservation overhead) and the prior
      // double-scene-render approach.
      //
      // Scene viewport: confine scene rendering to the BOTTOM MAP_PX_H
      // rows of the FBO — the top TOP_MARGIN_MAP_PX rows are the
      // reserved strip and stay at the clear color. WebGL viewport
      // origin is bottom-left, so `(0, 0, MAP_PX_W, MAP_PX_H)` lights
      // the bottom rows in WebGL space, which is the TOP-of-game-area
      // downward in browser coords — i.e. the top strip (canvas rows
      // 0..TOP_MARGIN_MAP_PX) stays blank. Reset the viewport before
      // the blit so the fullscreen quad covers the whole canvas.
      ctx.renderer.setRenderTarget(ctx.captureTarget);
      ctx.renderer.setViewport(0, 0, MAP_PX_W, MAP_PX_H);
      ctx.renderer.setScissor(0, 0, MAP_PX_W, MAP_PX_H);
      ctx.renderer.setScissorTest(true);
      ctx.renderer.clear();
      ctx.renderer.render(ctx.scene, ctx.camera);
      ctx.renderer.setScissorTest(false);
      ctx.renderer.setViewport(0, 0, worldCanvas.width, worldCanvas.height);
      ctx.renderer.setRenderTarget(null);
      ctx.renderer.clear();
      ctx.renderer.render(ctx.blitScene, ctx.blitCamera);
      canvas2d.drawFrame(map, overlay, viewport, now);
    },
    setLayersEnabled: canvas2d.setLayersEnabled,
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
    // Loupe samples the top-down composite (see `loupeCompositeSource` +
    // `loupeTopDownCanvas` comments). The source is always pitch=0, so
    // world→scene is the plain identity — same as 2D mode. The wrapping
    // around `handle.update` stashes pointer state the next `drawFrame`
    // uses to scissor its top-down pre-pass, and to skip it entirely
    // when the loupe is hidden.
    createLoupe: (container) => {
      const handle = createLoupe(
        container,
        loupeCompositeSource,
        (worldX, worldY) => ({
          x: worldX * OFFSCREEN_SCALE,
          y: worldY * OFFSCREEN_SCALE,
        }),
      );
      const innerUpdate = handle.update;
      return {
        update: (visible, worldX, worldY) => {
          loupeVisible = visible;
          loupeFocusWx = worldX;
          loupeFocusWy = worldY;
          innerUpdate(visible, worldX, worldY);
        },
      };
    },
  };
}
