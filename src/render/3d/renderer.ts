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

  const ctx: Render3dContext = createRender3dScene(worldCanvas);

  // Cached viewport from the last `drawFrame`. Used by the loupe composite
  // to draw the WebGL world canvas at the correct world-space rect.
  let lastViewport: Viewport | undefined;

  // Banner prev-scene snapshot scratch canvases. Lazily created on first
  // capture; reused across phase transitions. The composite canvas matches
  // the display canvas dimensions (CANVAS_W × CANVAS_H) so the returned
  // ImageData reflects exactly what was on screen at capture time.
  let captureCompositeCanvas: HTMLCanvasElement | undefined;
  let captureCompositeCtx: CanvasRenderingContext2D | undefined;
  let captureBridgeCanvas: HTMLCanvasElement | undefined;
  let captureBridgeCtx: CanvasRenderingContext2D | undefined;

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
      ctx.terrain.update(map, overlay, now);
      // Phase 3: reconcile wall meshes with the current overlay. The
      // manager early-outs when wall sets haven't changed, so this is
      // cheap on steady-state frames.
      ctx.walls.update(overlay);
      // Phase 3: reconcile tower meshes with the map + overlay. Dead
      // towers are skipped here — their rubble is rendered by the
      // debris manager below under the separate `debris` layer.
      ctx.towers.update(overlay, map.towers);
      // Phase 3: reconcile house meshes with the map's house list. The
      // manager filters destroyed houses the same way the 2D path does
      // and early-outs when the living-house set is unchanged.
      ctx.houses.update(map.houses);
      // Phase 3: reconcile rubble meshes for dead walls / cannons /
      // towers. One manager covers all three rubble kinds — the 2D
      // path's `debris` layer is flipped off above.
      ctx.debris.update(overlay, map.towers);
      // Phase 4: reconcile live cannon meshes (normal/super/mortar/
      // rampart). Dead cannons are owned by `debris` above; balloon
      // cannons are deferred to the balloon entity manager task.
      ctx.cannons.update(overlay, map);
      // Phase 4: reconcile grunt meshes. Grunts are ownerless 1×1
      // hazards; the manager rotates a single base variant by
      // `-grunt.facing` to match the game's CW-from-north convention.
      ctx.grunts.update(overlay);
      // Phase 4: reconcile cannonball meshes. Ball set fingerprint
      // (count + variant list) rebuilds meshes on spawn/despawn;
      // positions + scales rewrite every frame to follow sub-tile
      // flight motion.
      ctx.cannonballs.update(overlay);
      // Phase 4: reconcile burning-pit meshes. Fingerprint is per-pit
      // `col:row:variant`; a round decrement or set change rebuilds.
      ctx.pits.update(overlay);
      // Phase 4: reconcile balloon meshes (grounded bases + in-flight
      // envelopes). Grounded bases rebuild on cannon set change;
      // flights position per-frame along the 2D parabolic arc.
      ctx.balloons.update(overlay, map);
      // Placement phantoms: tetris-piece cell previews during
      // WALL_BUILD and cannon footprint previews during CANNON_PLACE.
      // Rebuilds every frame — the 2D layer is flipped off above so
      // only the 3D ghost meshes render over the world canvas.
      ctx.phantoms.update(overlay);
      // Phase 6: battle effects. Impacts, crosshairs, fog-of-war, and
      // thawing tiles each render to flat ground-plane meshes and
      // derive their animation from the same state fields the 2D path
      // reads (Impact.age, crosshair x/y, castle dilation, ThawingTile
      // age). The matching 2D layer flags were flipped off above so
      // the 2D renderer leaves those pixels transparent.
      ctx.impacts.update(overlay);
      ctx.crosshairs.update(overlay, now);
      ctx.fog.update(overlay, now);
      ctx.thawing.update(overlay);
      ctx.renderer.clear();
      // Camera: ortho view driven by the runtime viewport, tilted by
      // `pitch` (radians, X-axis tilt). Runtime-camera animates pitch
      // toward a phase-specific target so battle renders with a
      // classic Rampart 3/4 view. The 2D overlay is still drawn
      // straight-down — it only carries UI + still-2D layers that
      // are unaffected by tilt.
      updateCameraFromViewport(ctx.camera, viewport, pitch);
      lastViewport = viewport ?? undefined;
      ctx.renderer.render(ctx.scene, ctx.camera);
      canvas2d.drawFrame(map, overlay, viewport, now);
    },
    setLayersEnabled: canvas2d.setLayersEnabled,
    // Top-down ortho — the UI canvas has the same aspect ratio as the
    // world canvas (status bar is hidden in 3D mode), so the 2D
    // projection is correct as-is.
    clientToSurface: canvas2d.clientToSurface,
    screenToContainerCSS: canvas2d.screenToContainerCSS,
    // Banner prev-scene snapshot in 3D mode: composite the WebGL world
    // canvas (already viewport-cropped + tilted from the last `drawFrame`)
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
      // 1. Paint the WebGL world canvas stretched to the display size.
      //    `worldCanvas` already holds the viewport-cropped, tilted view
      //    from the last `drawFrame`; `preserveDrawingBuffer: true` in
      //    scene.ts keeps those pixels readable outside the rAF tick.
      captureCompositeCtx.drawImage(worldCanvas, 0, 0, targetW, targetH);
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
    // which in 3D mode is missing terrain + entities).
    createLoupe: (container) => createLoupe(container, loupeCompositeSource),
  };
}
