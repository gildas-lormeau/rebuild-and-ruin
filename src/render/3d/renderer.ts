/**
 * Three.js implementation of `RendererInterface`. Hybrid: WebGL on
 * `#world-canvas` renders all world content (see scene.ts); the 2D
 * canvas renderer overlays UI + banner snapshots. `drawFrame` renders
 * both each tick; `captureScene*` composites WebGL + 2D for banner
 * prev/new-scene snapshots.
 */

import type { ShadowMaterial } from "three";
import * as THREE from "three";
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
import type { GetCannonFacing } from "./entities/cannons.ts";
import type { FrameCtx } from "./frame-ctx.ts";
import { updateLightDebug } from "./light-debug.ts";
import {
  SHADOW_OVERLAY_PEAK_OPACITY,
  setSunBlend,
  updateSunDirection,
} from "./lights.ts";
import { isPerfHudEnabled, updatePerfHud } from "./perf-hud.ts";
import {
  applyShadowFlags,
  createRender3dScene,
  type Render3dContext,
} from "./scene.ts";
import { buildWarmupOverlay } from "./warm-entities.ts";

export function createRender3d(
  worldCanvas: HTMLCanvasElement,
  uiCanvas: HTMLCanvasElement,
): RendererInterface {
  // Closure-bound accessor — the runtime installs the cannon-animator's
  // `getDisplayed` here via `setCannonFacingProvider` once composition is
  // built. Default returns `undefined` so the cannons manager falls back
  // to 0 (no animation) until the runtime wires the real provider.
  let cannonFacingProvider: GetCannonFacing = () => undefined;
  const getCannonFacing: GetCannonFacing = (col, row) =>
    cannonFacingProvider(col, row);
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
  // (`overlay.ui.reserveTopStrip` — see runtime/subsystems/render.ts); scene
  // rendering shifts down so the map occupies the bottom MAP_PX_H rows
  // and world-Y=0 aligns with the top of the game area on the 2D
  // canvas. Canvas dims stay constant across phases so CSS layout and
  // banner transitions don't jitter.
  worldCanvas.width = MAP_PX_W;
  worldCanvas.height = MAP_PX_H + TOP_MARGIN_MAP_PX;

  const ctx: Render3dContext = createRender3dScene(
    worldCanvas,
    canvas2d.getBlurredSdf,
    getCannonFacing,
  );

  // Cached viewport + pitch from the last `drawFrame`. Used by the
  // loupe composite (draws the WebGL world canvas at the correct
  // world-space rect) and by the loupe's `worldToScene` mapper (folds
  // the X-axis tilt into the world→scene projection so the source
  // rect stays centered on the cursor even when the scene is tilted).
  let lastViewport: Viewport | undefined;
  let lastPitch = 0;

  // Per-frame draw-call / triangle counts captured immediately after the
  // scene render in `renderSceneToFBO`, before the blit pass overwrites
  // them. `renderer.info.render.*` is reset on every `render()`, so the
  // perf HUD can't read it after the blit (it would always show 1 call).
  // Held across frames so banner frames (which skip the scene render)
  // surface the last real gameplay cost instead of zero.
  let lastSceneDrawCalls = 0;
  let lastSceneTriangles = 0;

  // Banner prev-scene snapshot scratch canvases. Lazily created on first
  // capture; reused across phase transitions. The composite canvas matches
  // the display canvas dimensions (CANVAS_W × CANVAS_H) so the returned
  // ImageData reflects exactly what was on screen at capture time.
  let captureCompositeCanvas: HTMLCanvasElement | undefined;
  let captureCompositeCtx: CanvasRenderingContext2D | undefined;

  // Loupe source canvas — a WebGL+2D composite. The loupe samples this
  // each frame to magnify "what the user sees", which in 3D mode is the
  // world canvas (terrain + entities) overlaid with the 2D renderer's
  // UI/HUD layer. Lazily created on first access; sized to the 2D scene
  // canvas so the magnification math in `render-loupe.ts` stays
  // unchanged.
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
  /** Run every entity/effect manager's per-frame reconcile against
   *  `frame`. Extracted from `renderSceneToFBO` so the warmup path
   *  (`warmEntityShaders`) drives the identical manager list — adding a
   *  new manager here is automatically covered by both paths. */
  function runEntityUpdates(frame: FrameCtx): void {
    ctx.terrainTileData.update(frame);
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
    ctx.wallDust.update(frame);
    ctx.cannonBurns.update(frame);
    ctx.gruntBurns.update(frame);
    ctx.houseBurns.update(frame);
    ctx.crosshairs.update(frame);
    for (const eff of ctx.modifierEffects) eff.update(frame);
    ctx.bonusSquares.update(frame);
  }

  function renderSceneToFBO(
    map: GameMap,
    overlay: RenderOverlay | undefined,
    viewport: Viewport | null | undefined,
    now: number,
    pitch: number,
    sunT: number | undefined,
    pitchMax: number,
  ): void {
    // Modifier-aware SDF projection: high_tide flooded grass tiles paint
    // as water, low_water exposed water tiles paint as grass. The bank
    // gradient regenerates against the new effective shoreline so the
    // river visibly widens / narrows, without the modifier needing to
    // mutate `state.map.tiles`.
    ctx.terrainSdfTexture.ensureBuilt(map, {
      phantomWater: overlay?.entities?.floodedTiles,
      phantomGrass: overlay?.entities?.exposedRiverbedTiles,
    });
    const frame: FrameCtx = { overlay, map, now, pitch, sunT };
    runEntityUpdates(frame);
    updateCameraFromViewport(ctx.camera, viewport, pitch);
    lastViewport = viewport ?? undefined;
    lastPitch = pitch;
    // Per-frame light + shadow refresh. `setSunBlend` lerps ambient/
    // directional intensities + shadow casting between non-battle and
    // full-battle stances using a `blend` factor derived from camera
    // `pitch`. Tying the blend to the camera tilt animation (rather
    // than to `sunT` directly) means shadows ease in/out smoothly as
    // the camera leans into / out of the 3D battle view, instead of
    // popping at the phase boundary. `updateSunDirection` lerps the
    // sun's position the same way: between the inactive direction
    // (camera flat) and the battle-arc direction (camera fully
    // tilted), so non-battle phases never inherit a stale battle-end
    // direction. All inputs are pure functions of state (no `now`,
    // no RNG, no per-peer state) — peers on the same pitch + timer
    // see identical lighting (parity-safe). `applyShadowFlags` is
    // idempotent over the scene tree, so running it every frame is
    // cheaper than wiring per-manager change notifications and lets
    // newly-built meshes pick up flags on the next frame.
    const blend = sunBlendFromPitch(pitch, pitchMax);
    setSunBlend(ctx.ambient, ctx.sun, blend);
    updateSunDirection(ctx.sun, sunT, blend);
    const overlayMaterial = ctx.groundShadowOverlay.material as ShadowMaterial;
    overlayMaterial.opacity = SHADOW_OVERLAY_PEAK_OPACITY * blend;
    applyShadowFlags(ctx.scene);
    updateLightDebug(ctx.scene, ctx.ambient, ctx.sun, sunT, blend);
    ctx.renderer.setRenderTarget(ctx.captureTarget);
    ctx.renderer.setViewport(0, 0, worldCanvas.width, worldCanvas.height);
    ctx.renderer.clear();
    ctx.renderer.render(ctx.scene, ctx.camera);
    lastSceneDrawCalls = ctx.renderer.info.render.calls;
    lastSceneTriangles = ctx.renderer.info.render.triangles;
    ctx.renderer.setRenderTarget(null);
  }

  /** Pre-compile the shadow-pass permutation of every entity material.
   *  At rest, `sun.castShadow = false` so three.js builds materials
   *  WITHOUT `USE_SHADOWMAP`. The first BATTLE frame flips `castShadow`
   *  ON (camera tilts in → `setSunBlend(blend > 0)`), which triggers a
   *  blocking recompile of every caster material on the critical frame
   *  (~84ms cold). Calling this once before BATTLE entry — when no one's
   *  watching frame times — seeds the permutation so the BATTLE-entry
   *  flip is a no-op. Idempotent: subsequent calls return immediately
   *  because programs are already linked. */
  async function warmShadowPermutations(): Promise<void> {
    const wasOn = ctx.sun.castShadow;
    ctx.sun.castShadow = true;
    applyShadowFlags(ctx.scene);
    try {
      await ctx.renderer.compileAsync(ctx.scene, ctx.camera);
    } finally {
      ctx.sun.castShadow = wasOn;
    }
  }

  // Permanent, never-rendered group of cloned entity materials. Built
  // once by the first `warmEntityShaders` call. Its job is to hold a
  // live (undisposed) material for every entity shader program so the
  // program stays in three.js's program cache for the whole session.
  // Several entity managers (cannonballs, the fire/smoke burst effects)
  // `dispose()` their materials whenever their entity set empties — which
  // happens during normal battle too, not just at warmup teardown — so
  // pre-compiling them once isn't enough: the program would be released
  // and re-linked on the next spawn. A retained clone with a matching
  // shader cacheKey keeps the program's ref-count ≥ 1, so the manager's
  // rebuild hits the cache (`acquireProgram`) instead of recompiling.
  const shaderKeepalive = new THREE.Group();
  shaderKeepalive.visible = false;
  shaderKeepalive.name = "shaderKeepalive";
  let keepaliveBuilt = false;
  // Guards the once-per-session entity-shader warmup kicked off from the
  // first `warmMapCache`.
  let entityShadersWarmed = false;

  /** Clone every entity mesh currently in the scene into the keepalive
   *  group, giving each clone an INDEPENDENT material (so the source
   *  manager disposing its own material doesn't take ours with it).
   *  Clones must be visible when `compileAsync` runs so their materials
   *  acquire the program (three's `compile` walks `traverseVisible`);
   *  the caller flips the group invisible afterwards. Terrain + the
   *  ground-shadow overlay are excluded — they live in the scene for the
   *  whole session and never lose their program. */
  function buildShaderKeepalive(): void {
    const sources: THREE.Mesh[] = [];
    ctx.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh === ctx.terrain.mesh || mesh === ctx.groundShadowOverlay) return;
      sources.push(mesh);
    });
    for (const mesh of sources) {
      const clone = mesh.clone();
      clone.material = Array.isArray(mesh.material)
        ? mesh.material.map((mat) => mat.clone())
        : mesh.material.clone();
      clone.visible = true;
      clone.frustumCulled = false;
      shaderKeepalive.add(clone);
    }
    // Visible for the compile pass (three's `compile` walks
    // `traverseVisible` and skips hidden subtrees); the caller hides it
    // again once the programs are linked.
    shaderKeepalive.visible = true;
    ctx.scene.add(shaderKeepalive);
    keepaliveBuilt = true;
  }

  /** Pre-compile the shader program of every ENTITY material — cannons
   *  (all modes/tiers), grunts, cannonballs (iron/fire/mortar), the
   *  fire/smoke/dust burst effects, balloons, pits, crosshairs, etc.
   *  `warmShadowPermutations` only seeds the shadow permutation of
   *  whatever meshes already exist in the scene; at CANNON_PLACE entry
   *  most battle entities have never been instantiated, so their
   *  programs link lazily on the frame each one first appears — the
   *  ~600–1000ms BATTLE hitches the perf trace shows.
   *
   *  This drives a synthetic "one of every entity" overlay through the
   *  identical manager reconcile loop the live renderer uses, so each
   *  manager builds its meshes (and thus their materials) into the
   *  scene. On the first call we also snapshot those materials into the
   *  permanent {@link shaderKeepalive} group so the programs survive the
   *  managers' own dispose-on-empty churn. `compileAsync` then links
   *  every program (manager meshes + keepalive clones) off the critical
   *  path. Finally the keepalive group is hidden and a second reconcile
   *  against an empty overlay tears the throwaway manager instances back
   *  down, so the warmup leaves no entities visible on the first real
   *  frame. Shadows are forced on for the compile so the caster
   *  permutation is seeded too. */
  async function warmEntityShaders(map: GameMap): Promise<void> {
    const warmOverlay = buildWarmupOverlay(map);
    const frame: FrameCtx = {
      overlay: warmOverlay,
      map,
      now: 0,
      pitch: 0,
      sunT: 0,
    };
    const wasOn = ctx.sun.castShadow;
    ctx.sun.castShadow = true;
    // Everything from building the synthetic meshes to tearing them back
    // down runs SYNCHRONOUSLY before the first `await`, so no rendered
    // frame ever observes the throwaway entities or the (briefly visible)
    // keepalive clones — no flash, regardless of when this fires. three's
    // `compileAsync` runs its synchronous `compile()` (which acquires every
    // program) before it returns the completion-poll promise, so by the
    // time we get `pending` the programs are already linked-in-flight and
    // safe to hide/dispose the source meshes.
    let pending: Promise<unknown>;
    try {
      runEntityUpdates(frame);
      if (!keepaliveBuilt) buildShaderKeepalive();
      applyShadowFlags(ctx.scene);
      pending = ctx.renderer.compileAsync(ctx.scene, ctx.camera);
    } finally {
      ctx.sun.castShadow = wasOn;
      // Keepalive clones' programs are acquired now — hide the group so it
      // never renders; the materials (and thus their programs) stay alive
      // via the retained references.
      shaderKeepalive.visible = false;
      // Tear the throwaway manager meshes back down so the next real frame
      // starts from a clean entity set (managers hide/dispose on an empty
      // overlay — same path as "all entities gone").
      runEntityUpdates({ overlay: undefined, map, now: 0, pitch: 0, sunT: 0 });
    }
    // Off the critical path: just await the GPU link completion poll.
    await pending;
  }

  return {
    warmMapCache: (map) => {
      canvas2d.warmMapCache(map);
      // Upload the SDF for the first frame so the shader's first sample
      // doesn't read the placeholder. The terrain mesh has no per-map
      // state — geometry is fixed-size, everything else flows through
      // shader uniforms + the SDF / tile-data textures.
      ctx.terrainSdfTexture.ensureBuilt(map);
      // First map warm of the session (lobby seed-gen) is the earliest the
      // game map is known and well ahead of any battle — pre-link every
      // entity shader program here so the per-spawn compiles that cause
      // ~600–1000ms BATTLE hitches are already cached. Fire-and-forget; the
      // synchronous portion can't flash (see `warmEntityShaders`), and the
      // keepalive guard makes it a no-op after the first call.
      if (!entityShadersWarmed) {
        entityShadersWarmed = true;
        void warmEntityShaders(map);
      }
    },
    warmShadowPermutations,
    drawFrame: (
      map,
      overlay,
      viewport,
      now,
      pitch = 0,
      skip3DScene = false,
      sunT,
      // Default to 0 so callers that don't plumb the camera's max
      // pitch get the "no shadows" stance from `sunBlendFromPitch`,
      // matching the 2D / headless branch. The runtime always passes
      // `camera.getPitchMax()` from composition — `runtime/subsystems/camera.ts`
      // is the single source of truth for the actual value.
      pitchMax = 0,
    ) => {
      // Render the WebGL scene (all world content) behind the 2D canvas;
      // the 2D renderer paints UI/HUD overlays on top.
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
        renderSceneToFBO(map, overlay, viewport, now, pitch, sunT, pitchMax);
        ctx.renderer.clear();
        ctx.renderer.render(ctx.blitScene, ctx.blitCamera);
      }
      canvas2d.drawFrame(map, overlay, viewport, now);
      if (isPerfHudEnabled()) {
        const info = ctx.renderer.info;
        updatePerfHud(
          {
            drawCalls: lastSceneDrawCalls,
            triangles: lastSceneTriangles,
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
    // runtime/subsystems/render.ts `reserveTopStrip`). Subtract the strip offset
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
    // `drawFrame`) with the 2D display canvas (UI/HUD overlay) at
    // display resolution. The snapshot therefore reflects exactly what
    // was on screen at capture time — no camera reset, no re-render. `captureScene` runs synchronously from the
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
    captureSceneOffscreen: (
      map,
      overlay,
      viewport,
      now,
      pitch = 0,
      sunT,
      // Default 0 = "no shadows" stance — see drawFrame above.
      pitchMax = 0,
    ) => {
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
      renderSceneToFBO(map, overlay, viewport, now, pitch, sunT, pitchMax);
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
    setCannonFacingProvider: (provider) => {
      cannonFacingProvider = provider;
    },
    snapCannonBarrelsToRest: () => {
      ctx.cannons.snapBarrelsToRest();
    },
  };
}

/** Camera `pitch` (radians, 0 = flat, increasing = tilted toward the
 *  3D battle view) → blend factor ∈ [0, 1] that drives the lighting +
 *  shadow-overlay fade. `0` is the flat non-battle look (no shadows);
 *  `1` is fully tilted into the 3D view (full-strength sun + peak
 *  shadow opacity).
 *
 *  Linear ratio of `pitch / pitchMax`, clamped. The camera's pitch
 *  animation already applies a cubic ease-out (see
 *  `runtime/subsystems/camera.ts`), so layering a second easing curve here would
 *  double-ease the fade. Linear keeps the curve identical to the
 *  camera's animation, which is the source of truth for "tilt
 *  progress".
 *
 *  `pitchMax` comes from the runtime camera's `getPitchMax()` so the
 *  fully-tilted target stays a single source of truth. A zero
 *  `pitchMax` (2D mode, headless) returns 0, matching the "no
 *  shadows" stance. */
function sunBlendFromPitch(pitch: number, pitchMax: number): number {
  if (pitchMax <= 0) return 0;
  return Math.min(Math.max(pitch / pitchMax, 0), 1);
}
