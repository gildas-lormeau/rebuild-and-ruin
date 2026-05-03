/**
 * Map Renderer — browser-side ES module for rendering game maps on a canvas.
 *
 * Coordinate naming conventions across render-*.ts files:
 *   - row/col: tile-grid coordinates (integers)
 *   - px/py: pixel position within tile-space (row * TILE_SIZE, col * TILE_SIZE)
 *   - cx/cy: center-based pixel position (e.g., tower center)
 *   - sx/sy: screen-space pixels (after camera/viewport transform)
 *   - wx/wy: world-space pixels (same as px/py but typed as WorldPos)
 *   - W/H: canvas dimensions in tile-space pixels (MAP_PX_W, MAP_PX_H)
 */

import type { GameMap, Viewport } from "../shared/core/geometry-types.ts";
import {
  CANVAS_H,
  CANVAS_W,
  GRID_COLS,
  GRID_ROWS,
  MAP_PX_H,
  MAP_PX_W,
  OFFSCREEN_SCALE,
  SCALE,
  TILE_SIZE,
  TOP_MARGIN_CANVAS_PX,
} from "../shared/core/grid.ts";
import { isWater, pxToTile } from "../shared/core/spatial.ts";
import type {
  RenderObserver,
  RenderOverlay,
} from "../shared/ui/overlay-types.ts";
import type { RGB } from "../shared/ui/theme.ts";
import {
  drawAnnouncement,
  drawBanner,
  drawComboFloats,
  drawGameOver,
  drawLifeLostDialog,
  drawLobby,
  drawPhaseTimer,
  drawScoreDeltas,
  drawSelectionCursor,
  drawStatusBar,
  drawUpgradePick,
} from "./render-ui.ts";
import { drawControlsScreen, drawOptionsScreen } from "./render-ui-settings.ts";

interface TerrainImageCache {
  width: number;
  height: number;
  mapVersion: number;
  normal?: ImageData;
  battle?: ImageData;
  /** Packed `(row << 8) | col` tile coords of the nearest water-tile pixel for
   *  every pixel — populated lazily on first `getNearestWaterTilePerPixel`
   *  call. `NEAREST_WATER_NONE` sentinel marks cells that didn't receive any
   *  water propagation (water-free map). Shape: `width * height`. */
  nearestWaterTile?: Uint16Array;
  /** Blurred signed distance field (positive in water, negative in grass,
   *  smoothed by the box-blur passes). Uploaded by the 3D terrain shader as
   *  an R32F DataTexture so the per-pixel bank gradient inside owned-sinkhole
   *  tiles can be computed in GLSL. Shape: `width * height`. */
  blurredSdf?: Float32Array;
}

interface OffscreenPair {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

/** Construction-time deps for `createRenderMap`. Both fields are optional —
 *  production callers (`createCanvasRenderer`) typically pass nothing and get
 *  the browser-default canvas factory. Tests pass a recording canvas factory
 *  and an observer to capture terrain-draw intents.
 *
 *  The deps bag replaces the previous module-level `setCanvasFactory` /
 *  `setRenderObserver` seams: each `createRenderMap` call owns its own
 *  scene/banner/cache state, so multiple test scenarios in the same file
 *  remain isolated without any cleanup step. */
export interface RenderMapDeps {
  /** Factory used to create offscreen canvases. Defaults to
   *  `document.createElement("canvas")` in browsers; tests inject a
   *  recording mock so the module can be loaded in environments without
   *  `document` (deno). */
  canvasFactory?: () => HTMLCanvasElement;
  /** Test observer — receives every `terrainDrawn` intent. Production
   *  callers omit it. */
  observer?: RenderObserver;
  /** Reserve a TOP_MARGIN_CANVAS_PX strip at the top of the display
   *  canvas and translate game-area drawing down by the strip height.
   *  Construction-level flag (not per-frame) so the canvas size stays
   *  stable across every overlay (game, lobby, options, controls) —
   *  otherwise aspect mismatches with the WebGL worldCanvas's top
   *  strip would letterbox the two canvases differently. Set by
   *  `createRender3d` when it creates the 2D UI canvas; tests that
   *  exercise `createCanvasRenderer` directly leave it unset. Hosts
   *  the status-bar HUD. */
  reserveTopStrip?: boolean;
}

/** Per-renderer instance returned by `createRenderMap`. Holds the closure
 *  state previously kept at module scope (scene canvases, banner cache,
 *  observer, terrain cache). Created once per `createCanvasRenderer` call. */
interface RenderMap {
  drawMap: (
    map: GameMap,
    canvas: HTMLCanvasElement,
    overlay?: RenderOverlay,
    viewport?: Viewport | null,
    now?: number,
  ) => void;
  /** Pre-compute terrain bitmaps for `map` so the first frame doesn't stall.
   *  Per-renderer-instance: each `createRenderMap` owns its own cache, so
   *  warming a map for one renderer doesn't affect another.
   *  `frozenTiles` participates in the bake — when the frozen-river modifier
   *  fires, `state.map.mapVersion` bumps and the cache re-bakes with ice. */
  precomputeTerrainCache: (
    map: GameMap,
    frozenTiles?: ReadonlySet<number>,
  ) => void;
  /** Return the baked terrain bitmap (grass + water + bank + checkerboard
   *  noise + frozen ice) for `map` in either peacetime or battle palette.
   *  Populates the cache on first call via `precomputeTerrainCache`. The 3D
   *  renderer uploads this as a CanvasTexture so water/grass/bank/ice
   *  visuals stay pixel-identical across 2D and 3D. */
  getTerrainBitmap: (
    map: GameMap,
    inBattle: boolean,
    frozenTiles?: ReadonlySet<number>,
  ) => ImageData;
  /** Per-pixel packed `(row << 8) | col` tile coords of the nearest water-tile
   *  pixel, derived from the SDF source-tracking. Available for future
   *  shader effects that need to spread an effect from water tiles into
   *  surrounding grass (the current owned-sinkhole bank gradient is fully
   *  contained within the water tile, so it doesn't consume this).
   *  `mapVersion`-keyed; populated lazily on first call. Each cell holds
   *  `NEAREST_WATER_NONE` when no water tile is reachable from that pixel
   *  (water-free map). */
  getNearestWaterTilePerPixel: (map: GameMap) => Uint16Array | undefined;
  /** Blurred signed-distance field for `map` — positive in water, negative in
   *  grass, magnitude = pixel distance from the water/grass boundary. Used by
   *  the 3D terrain shader to compute the grass→bank→water gradient
   *  per-fragment instead of baking it into the bitmap and a second-plane
   *  sinkhole overlay. `mapVersion`-keyed; populated lazily on first call. */
  getBlurredSdf: (map: GameMap) => Float32Array | undefined;
  sceneCanvas: () => HTMLCanvasElement;
  /** Capture the current display's game area into a banner-owned bridge
   *  canvas and return it (banner prev-scene A-snapshot). Returns
   *  undefined if the scene canvas hasn't been initialized yet. */
  captureScene: () => HTMLCanvasElement | undefined;
  /** Flash-free post-mutation capture for banner B-snapshot. Runs the full
   *  2D draw pipeline into a hidden offscreen display-sized canvas (never the
   *  visible one), copies the game area into a banner-owned bridge canvas,
   *  and returns it. The visible canvas is untouched — the user never sees
   *  the new scene before the banner's progressive reveal reaches it.
   *  Returns undefined if the scene hasn't been initialized yet
   *  (pre-first-frame). */
  captureSceneOffscreen: (
    map: GameMap,
    overlay: RenderOverlay | undefined,
    viewport: Viewport | null | undefined,
    now: number,
  ) => HTMLCanvasElement | undefined;
}

// Water/grass terrain transition thresholds (in blurred SDF units, ~1 unit ≈ 1 pixel distance).
// GRASS_TO_BANK_DIST: start bank texture blend at this distance from water edge
// BANK_TO_WATER_DIST: complete transition to water texture at this distance
// TRANSITION_WIDTH: smoothstep blend width (larger = softer edge)
// Tuned so a 4-tile sinkhole cluster (raw peak distance ~8-9 px, down to
// ~5-6 px after the radius-2 blur) still reaches the water zone at its
// deepest point instead of rendering entirely as bank.
const GRASS_TO_BANK_DIST = 2;
const BANK_TO_WATER_DIST = 4;
const TRANSITION_WIDTH = 1.5;
// Tile fill colors — RGB tuples fed into ImageData pixel arrays.
const GRASS_DARK: RGB = [45, 140, 45];
// checkerboard dark square
const GRASS_LIGHT: RGB = [51, 153, 51];
// checkerboard light square
const GRASS_BATTLE: RGB = [
  // darkened 85% of light grass during battle phase
  Math.floor(51 * 0.85),
  Math.floor(153 * 0.85),
  Math.floor(51 * 0.85),
];
const WATER_COLOR: RGB = [40, 104, 176];
// river fill
const ICE_COLOR: RGB = [165, 210, 230];
// frozen river fill (replaces WATER_COLOR for frozen tiles)
const BANK_COLOR: RGB = [139, 58, 26];
// river bank / shoreline
// Grass blade texture pattern (local pixel offsets within a 16x16 tile)
const BLADE_DARK: [number, number][] = [
  [2, 1],
  [7, 3],
  [12, 0],
  [4, 6],
  [10, 7],
  [1, 10],
  [8, 11],
  [14, 9],
  [5, 13],
  [11, 14],
  [2, 2],
  [7, 4],
  [12, 1],
  [4, 7],
  [10, 8],
  [1, 11],
  [8, 12],
  [14, 10],
  [5, 14],
  [11, 15],
];
const BLADE_LIGHT: [number, number][] = [
  [3, 4],
  [9, 2],
  [13, 6],
  [6, 9],
  [0, 13],
  [11, 12],
];
// Water wave texture offsets
const WAVE_HI: { x: number; y: number; w: number }[] = [
  { x: 1, y: 3, w: 5 },
  { x: 9, y: 7, w: 4 },
  { x: 3, y: 11, w: 6 },
  { x: 11, y: 14, w: 3 },
];
const WAVE_LO: { x: number; y: number; w: number }[] = [
  { x: 1, y: 4, w: 5 },
  { x: 9, y: 8, w: 4 },
  { x: 3, y: 12, w: 6 },
  { x: 11, y: 15, w: 3 },
];
// Precomputed per-pixel texture offsets (built once, reused every frame)
const GRASS_TEX = new Int8Array(TILE_SIZE * TILE_SIZE);
const WATER_TEX = new Int8Array(TILE_SIZE * TILE_SIZE);
// Transition width in pixels for ice→water blend at frozen tile boundaries.
const ICE_BLEND_WIDTH = 4;
/** Sentinel value for `getNearestWaterTilePerPixel` cells that didn't receive
 *  any water-tile propagation (only happens on water-free maps, but exported
 *  so shader/test consumers can compare without magic-numbering 0xFFFF). */
export const NEAREST_WATER_NONE = 0xffff;

export function createRenderMap(deps: RenderMapDeps = {}): RenderMap {
  const observer = deps.observer;
  const createOffscreenCanvas =
    deps.canvasFactory ?? (() => document.createElement("canvas"));

  let scene: OffscreenPair | undefined;
  // Dedicated bridge canvases for banner snapshots. Sized to the game area
  // (CANVAS_W × CANVAS_H). `captureScene` copies from the visible canvas into
  // `bannerACapture`; `captureSceneOffscreen` copies from `offscreenDisplay`
  // into `bannerBCapture`. Each capture populates a canvas and returns it —
  // the banner state holds the reference for the duration of the sweep, so
  // the canvas must not be stomped on mid-banner. Each is reused across
  // banners (a new showBanner replaces the current state before re-capturing),
  // and captureScene + captureSceneOffscreen write to different canvases so
  // they can't collide within a single showBanner call.
  let bannerACapture: OffscreenPair | undefined;
  let bannerBCapture: OffscreenPair | undefined;
  // Offscreen display-sized canvas for flash-free banner B-snapshot capture.
  // `drawFrame` paints into this instead of the visible canvas when the banner
  // system wants a post-mutation snapshot — the visible canvas stays
  // untouched so the user never sees the new scene before the banner's
  // progressive reveal reaches it. Sized on demand to match the visible
  // canvas dimensions (CANVAS_W × TOP_STRIP_H + CANVAS_H + STATUS_BAR_H).
  let offscreenDisplay: OffscreenPair | undefined;
  // Cached context for the visible canvas — avoids per-frame getContext
  // overhead on Chrome mobile, and captureScene reads pixels back from it.
  let visibleCtxCache:
    | {
        canvas: HTMLCanvasElement;
        canvasCtx: CanvasRenderingContext2D;
      }
    | undefined;
  // Cached context for the offscreen display canvas. Kept separate from
  // `visibleCtxCache` so the two don't thrash each other when banner capture
  // interleaves with the live render loop.
  let offscreenCtxCache:
    | {
        canvas: HTMLCanvasElement;
        canvasCtx: CanvasRenderingContext2D;
      }
    | undefined;
  /** Pixel offset from the top of the display canvas to the top of the
   *  game area. Equal to `TOP_MARGIN_CANVAS_PX` when the renderer was
   *  constructed with `deps.reserveTopStrip = true`; 0 otherwise.
   *  Constant across frames — derived once from the construction-time
   *  flag and referenced by `captureScene` so banner snapshots cover
   *  the game area only, not the reserved strip. */
  const topStripH = deps.reserveTopStrip ? TOP_MARGIN_CANVAS_PX : 0;

  // Per-instance terrain cache. Was previously a module-level WeakMap, which
  // meant `precomputeTerrainCache` (the module export) and every `RenderMap`
  // instance shared the same cache state. The doc-comment on this factory
  // promised "each call owns its own scene/banner/cache state, so multiple
  // test scenarios in the same file remain isolated" — but the terrain cache
  // didn't honor that promise. Now it does: the WeakMap lives in this
  // closure, `getTerrainCache` reads/writes it, and the new
  // `precomputeTerrainCache` method on the returned `RenderMap` shape
  // replaces the module export so production callers also share state per
  // renderer instance.
  //
  // The WeakMap key is still `GameMap`, so a fresh map gets a fresh entry —
  // production never re-uses a map across renderer instances (each game
  // generates its own), so the same-renderer hot path stays cache-warm.
  const terrainImageCache = new WeakMap<GameMap, TerrainImageCache>();

  function getTerrainCache(
    map: GameMap,
    width: number,
    height: number,
  ): TerrainImageCache {
    const existing = terrainImageCache.get(map);
    if (
      existing &&
      existing.width === width &&
      existing.height === height &&
      existing.mapVersion === map.mapVersion
    ) {
      return existing;
    }
    const next: TerrainImageCache = {
      width,
      height,
      mapVersion: map.mapVersion,
    };
    terrainImageCache.set(map, next);
    return next;
  }

  /** Pre-compute both terrain variants (normal + battle) so the first
   *  render of each doesn't stall the frame. Call during game init.
   *  `frozenTiles` is baked into the bitmap when present — `mapVersion`
   *  bumps on freeze/thaw invalidate the cache. */
  /** Compute + cache the blurred SDF and the nearest-water-tile array.
   *  Independent of `frozenTiles` (the SDF shape depends only on the map's
   *  tile geometry), so this can safely run before the 3D-side accessors
   *  (`getBlurredSdf`, `getNearestWaterTilePerPixel`) without prejudicing
   *  the bitmap-bake side, which still needs the latest `frozenTiles`. */
  function ensureTerrainSdfCache(map: GameMap): void {
    const cache = getTerrainCache(map, MAP_PX_W, MAP_PX_H);
    if (cache.blurredSdf && cache.nearestWaterTile) return;
    const W = MAP_PX_W;
    const H = MAP_PX_H;
    const nearestWater = cache.nearestWaterTile ?? new Uint16Array(W * H);
    const sdf = computeSignedDistanceField(W, H, map, nearestWater);
    blurSignedDistanceField(sdf, W, H);
    cache.nearestWaterTile = nearestWater;
    cache.blurredSdf = sdf;
  }

  function precomputeTerrainCache(
    map: GameMap,
    frozenTiles?: ReadonlySet<number>,
  ): void {
    ensureTerrainSdfCache(map);
    const cache = getTerrainCache(map, MAP_PX_W, MAP_PX_H);
    if (cache.normal && cache.battle) return;
    const sdf = cache.blurredSdf!;
    const W = MAP_PX_W;
    const H = MAP_PX_H;
    if (!cache.normal) {
      const imgData = new ImageData(W, H);
      renderTerrainPixels(imgData, sdf, W, H, map, false, frozenTiles);
      cache.normal = imgData;
    }
    if (!cache.battle) {
      const imgData = new ImageData(W, H);
      renderTerrainPixels(imgData, sdf, W, H, map, true, frozenTiles);
      cache.battle = imgData;
    }
  }

  function getNearestWaterTilePerPixel(map: GameMap): Uint16Array | undefined {
    ensureTerrainSdfCache(map);
    return getTerrainCache(map, MAP_PX_W, MAP_PX_H).nearestWaterTile;
  }

  function getBlurredSdf(map: GameMap): Float32Array | undefined {
    ensureTerrainSdfCache(map);
    return getTerrainCache(map, MAP_PX_W, MAP_PX_H).blurredSdf;
  }

  function getMainCtx(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    // The offscreen-display canvas has its own cache slot so capture-path
    // draws don't evict the visible canvas's cached context (and vice-versa).
    if (offscreenCtxCache?.canvas === canvas)
      return offscreenCtxCache.canvasCtx;
    if (visibleCtxCache?.canvas === canvas) return visibleCtxCache.canvasCtx;
    // `alpha: true` (the default) so the regions outside the 2D UI
    // overlays remain transparent, letting the WebGL canvas below
    // show through.
    const canvasCtx = canvas.getContext("2d")!;
    if (offscreenDisplay?.canvas === canvas) {
      offscreenCtxCache = { canvas, canvasCtx };
    } else {
      visibleCtxCache = { canvas, canvasCtx };
    }
    return canvasCtx;
  }

  function getOffscreenDisplay(): OffscreenPair {
    if (!offscreenDisplay) {
      const canvas = createOffscreenCanvas();
      // `willReadFrequently: true` because the capture path immediately
      // calls `getImageData` on this context after each draw. Matches the
      // default 2D `captureScene` path that reads back from the visible
      // canvas.
      const canvasCtx = canvas.getContext("2d", {
        willReadFrequently: true,
      })!;
      offscreenDisplay = { canvas, ctx: canvasCtx };
      offscreenCtxCache = { canvas, canvasCtx };
    }
    return offscreenDisplay;
  }

  function getScene(): OffscreenPair {
    if (!scene) {
      const canvas = createOffscreenCanvas();
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      scene = { canvas, ctx };
    }
    return scene;
  }

  function getBannerACapture(): OffscreenPair {
    if (!bannerACapture) {
      const canvas = createOffscreenCanvas();
      canvas.width = CANVAS_W;
      canvas.height = CANVAS_H;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.imageSmoothingEnabled = false;
      bannerACapture = { canvas, ctx };
    }
    return bannerACapture;
  }

  function getBannerBCapture(): OffscreenPair {
    if (!bannerBCapture) {
      const canvas = createOffscreenCanvas();
      canvas.width = CANVAS_W;
      canvas.height = CANVAS_H;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.imageSmoothingEnabled = false;
      bannerBCapture = { canvas, ctx };
    }
    return bannerBCapture;
  }

  function ensureOffscreenSize(width: number, height: number): void {
    const physW = width * OFFSCREEN_SCALE;
    const physH = height * OFFSCREEN_SCALE;
    const { canvas: sceneCanvas, ctx: sceneCtx } = getScene();
    if (sceneCanvas.width !== physW || sceneCanvas.height !== physH) {
      sceneCanvas.width = physW;
      sceneCanvas.height = physH;
      sceneCtx.setTransform(OFFSCREEN_SCALE, 0, 0, OFFSCREEN_SCALE, 0, 0);
      sceneCtx.imageSmoothingEnabled = false;
    }
  }

  // Banner prev-scene is a display-resolution snapshot. It paints onto
  // the DISPLAY canvas at 1:1 — never through the offscreen-scene →
  // display blit — because a tilted or viewport-cropped camera has no
  // "full-map" rect to re-crop from. The banner strip itself is drawn
  // in the offscreen at map coords and carried to the display by the
  // normal blit, so we clip the snapshot to the region BELOW the
  // banner strip to keep the strip visible on top.
  function drawBannerPrevScene(
    displayCtx: CanvasRenderingContext2D,
    displayW: number,
    displayH: number,
    overlay: RenderOverlay | undefined,
  ): void {
    if (!overlay?.ui?.banner?.prevScene) return;
    const prev = overlay.ui.banner.prevScene;

    // Banner strip bounds are map-pixel coords. During a banner the
    // viewport is always at fullMapVp (onCameraReady gates the banner
    // display chain on convergence), so map→display is a uniform SCALE
    // multiply.
    const bannerTopMap = overlay.ui.banner.top;
    const bannerBottomMap = overlay.ui.banner.bottom;
    const bannerHMap = bannerBottomMap - bannerTopMap;
    const clipY = bannerBottomMap * SCALE;
    if (clipY >= displayH) return;

    displayCtx.save();
    displayCtx.beginPath();
    displayCtx.rect(0, clipY, displayW, displayH - clipY);
    displayCtx.clip();
    displayCtx.drawImage(prev.canvas, 0, 0, displayW, displayH);
    displayCtx.restore();
    observer?.bannerComposited?.({
      clipY,
      H: displayH,
      W: displayW,
      bannerH: bannerHMap * SCALE,
    });
  }

  // Companion to `drawBannerPrevScene`: paints the NEW scene (post-mutation
  // snapshot) into the region ABOVE the banner strip. Together, the two
  // snapshots form a progressive reveal of the new scene over the old
  // scene — both frozen for the duration of the sweep, so the live
  // renderer never repaints world contents during a banner.
  function drawBannerNewScene(
    displayCtx: CanvasRenderingContext2D,
    displayW: number,
    displayH: number,
    overlay: RenderOverlay | undefined,
  ): void {
    if (!overlay?.ui?.banner?.newScene) return;
    const next = overlay.ui.banner.newScene;

    // Banner strip bounds in display pixels. Above the top edge is the
    // region we reveal to — clip to [0, topPx).
    const bannerTopMap = overlay.ui.banner.top;
    const topPx = bannerTopMap * SCALE;
    if (topPx <= 0) return;

    displayCtx.save();
    displayCtx.beginPath();
    displayCtx.rect(0, 0, displayW, topPx);
    displayCtx.clip();
    displayCtx.drawImage(next.canvas, 0, 0, displayW, displayH);
    displayCtx.restore();
  }

  function drawMap(
    map: GameMap,
    canvas: HTMLCanvasElement,
    overlay?: RenderOverlay,
    viewport?: Viewport | null,
    now: number = performance.now(),
  ): void {
    const canvasCtx = getMainCtx(canvas);
    const W = MAP_PX_W;
    const H = MAP_PX_H;

    // Top strip: reserved empty space ABOVE the game area. The 3D
    // renderer sets `reserveTopStrip` so tall wall meshes at row 0
    // have a tile of headroom under battle tilt. Grows the canvas at
    // the top; game-area drawing shifts down by TOP_STRIP_H via
    // `ctx.translate` below so all existing map-coord draw code keeps
    // working without per-call offsets. The status bar paints into this
    // same strip — same height by construction
    // (TOP_MARGIN_CANVAS_PX === STATUSBAR_HEIGHT).
    const TOP_STRIP_H = topStripH;
    const cw = CANVAS_W;
    const gameH = CANVAS_H;
    const ch = TOP_STRIP_H + gameH;
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      canvasCtx.imageSmoothingEnabled = false;
    }

    ensureOffscreenSize(W, H);
    const overlayCtx = getScene().ctx;
    overlayCtx.clearRect(0, 0, W, H);
    // Clear the main (display) canvas too. With `alpha: true` this resets
    // the framebuffer to transparent so the regions outside the 2D UI
    // overlays reveal the WebGL canvas below.
    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

    // 2D draw pipeline. World content (terrain, walls, towers, cannons,
    // grunts, houses, debris, cannonballs, balloons, pits, burns, impacts,
    // crosshairs, phantoms, fog, water waves, sinkhole tint, bonus pulse)
    // is rendered by the WebGL scene — see render/3d/scene.ts. What stays
    // in 2D, in paint order:
    //
    // Offscreen scene canvas (zoom-affected, blitted to display below):
    //   - phase timer ring, placement-preview cursor, score deltas,
    //     modifier-reveal flash
    //   - banner chrome, game-over panel, life-lost / upgrade-pick dialogs
    //   - full-screen modals: lobby, options, controls
    //
    // Display canvas (post-blit, screen-relative):
    //   - banner phase-transition snapshots (pre-captured world bitmaps
    //     replayed during the sweep — clips disjoint by banner top/bottom)
    //   - HUD text scaled by SCALE: combo floats, announcement
    //   - status bar in the reserved top strip
    drawPhaseTimer(overlayCtx, map, overlay, now);
    drawSelectionCursor(overlayCtx, map, overlay, now);
    drawScoreDeltas(overlayCtx, overlay);
    drawBanner(overlayCtx, W, H, overlay);
    drawGameOver(overlayCtx, W, H, overlay);
    drawLifeLostDialog(overlayCtx, W, H, overlay, now);
    drawUpgradePick(overlayCtx, W, H, overlay, now);

    // Full-screen modal screens (opaque — drawn last, on top of everything)
    drawLobby(overlayCtx, W, H, overlay, now);
    drawOptionsScreen(overlayCtx, W, H, overlay, now);
    drawControlsScreen(overlayCtx, W, H, overlay, now);

    // Scale up to display canvas (with optional zoom viewport). Every
    // display-space draw below operates under an optional top-strip
    // translate so map-coord drawing stays unchanged: (0, 0) in the
    // translated frame is the top-left of the GAME AREA, never the
    // canvas. The status-bar draw below the restore uses raw canvas
    // coords (top-anchored, painting into the reserved top strip).
    canvasCtx.imageSmoothingEnabled = false;
    canvasCtx.save();
    if (TOP_STRIP_H > 0) canvasCtx.translate(0, TOP_STRIP_H);
    const offscreenCanvas = getScene().canvas;
    if (viewport) {
      canvasCtx.drawImage(
        offscreenCanvas,
        viewport.x * OFFSCREEN_SCALE,
        viewport.y * OFFSCREEN_SCALE,
        viewport.w * OFFSCREEN_SCALE,
        viewport.h * OFFSCREEN_SCALE,
        0,
        0,
        cw,
        gameH,
      );
    } else {
      canvasCtx.drawImage(offscreenCanvas, 0, 0, cw, gameH);
    }

    // Banner scene snapshots, painted on the DISPLAY canvas at 1:1 after
    // the offscreen blit. Both are captured at display resolution so
    // tilted/viewport-cropped frames replay exactly as they were on screen.
    // Clips are disjoint — new scene above the banner top, old scene below
    // the banner bottom — so paint order doesn't matter. New-above-prev
    // mirrors the top-to-bottom reading order of the sweep.
    drawBannerNewScene(canvasCtx, cw, gameH, overlay);
    drawBannerPrevScene(canvasCtx, cw, gameH, overlay);

    // HUD text drawn at display resolution (screen-relative, not affected by zoom)
    canvasCtx.save();
    canvasCtx.scale(SCALE, SCALE);
    drawComboFloats(canvasCtx, W, H, overlay);
    drawAnnouncement(canvasCtx, W, H, overlay);
    canvasCtx.restore();
    canvasCtx.restore(); // unwind the TOP_STRIP_H translate

    // Status bar drawn at display resolution into the reserved top strip
    // (y=0..STATUSBAR_HEIGHT). Skipped when the strip isn't reserved (2D
    // mode) — without the headroom the bar would overlap row 0 of the map.
    if (TOP_STRIP_H > 0) {
      drawStatusBar(canvasCtx, cw, ch, overlay);
    }
  }

  function sceneCanvas(): HTMLCanvasElement {
    return getScene().canvas;
  }

  /** Copy the current DISPLAY-canvas GAME AREA (CANVAS_W × CANVAS_H — top
   *  strip + status bar excluded) into the banner-A bridge canvas and
   *  return it. The bridge canvas is banner-owned scratch: the banner
   *  system holds the reference for the duration of the sweep, and the
   *  next `showBanner` (which fully replaces the current banner) is the
   *  only thing that rewrites it. Returns undefined if `drawFrame`
   *  hasn't run yet or the display canvas is undersized. */
  function captureScene(): HTMLCanvasElement | undefined {
    if (!visibleCtxCache) return undefined;
    const { canvas } = visibleCtxCache;
    if (canvas.height < topStripH + CANVAS_H || canvas.width < CANVAS_W) {
      return undefined;
    }
    const { canvas: bridge, ctx: bridgeCtx } = getBannerACapture();
    bridgeCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    bridgeCtx.drawImage(
      canvas,
      0,
      topStripH,
      CANVAS_W,
      CANVAS_H,
      0,
      0,
      CANVAS_W,
      CANVAS_H,
    );
    return bridge;
  }

  function captureSceneOffscreen(
    map: GameMap,
    overlay: RenderOverlay | undefined,
    viewport: Viewport | null | undefined,
    now: number,
  ): HTMLCanvasElement | undefined {
    // Bail out if the visible canvas hasn't rendered yet — before the
    // first frame the scene/terrain caches aren't warm and the banner
    // system has nothing to composite against anyway. Matches the
    // `captureScene` contract (undefined = "no scene yet").
    if (!visibleCtxCache) return undefined;
    const { canvas: offCanvas } = getOffscreenDisplay();
    // Draw the full 2D frame into the hidden canvas. `drawMap` sizes its
    // target canvas on first use (cw × ch) so the hidden canvas picks up
    // the correct dimensions here — same as the visible canvas.
    drawMap(map, offCanvas, overlay, viewport, now);
    if (offCanvas.height < topStripH + CANVAS_H || offCanvas.width < CANVAS_W) {
      return undefined;
    }
    const { canvas: bridge, ctx: bridgeCtx } = getBannerBCapture();
    bridgeCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    bridgeCtx.drawImage(
      offCanvas,
      0,
      topStripH,
      CANVAS_W,
      CANVAS_H,
      0,
      0,
      CANVAS_W,
      CANVAS_H,
    );
    return bridge;
  }

  function getTerrainBitmap(
    map: GameMap,
    inBattle: boolean,
    frozenTiles?: ReadonlySet<number>,
  ): ImageData {
    precomputeTerrainCache(map, frozenTiles);
    const cache = getTerrainCache(map, MAP_PX_W, MAP_PX_H);
    return inBattle ? cache.battle! : cache.normal!;
  }

  return {
    drawMap,
    precomputeTerrainCache,
    getTerrainBitmap,
    getNearestWaterTilePerPixel,
    getBlurredSdf,
    sceneCanvas,
    captureScene,
    captureSceneOffscreen,
  };
}

// Bake per-pixel brightness offsets into the tile-sized texture lookup tables.
// Values are signed: negative = darker, positive = lighter (added to base RGB).
for (const [lx, ly] of BLADE_DARK) GRASS_TEX[ly * TILE_SIZE + lx] = -12;

for (const [lx, ly] of BLADE_LIGHT) GRASS_TEX[ly * TILE_SIZE + lx] = 10;

for (const w of WAVE_HI) {
  for (let i = 0; i < w.w; i++) WATER_TEX[w.y * TILE_SIZE + w.x + i] = 15;
}

for (const w of WAVE_LO) {
  for (let i = 0; i < w.w; i++) WATER_TEX[w.y * TILE_SIZE + w.x + i] = -10;
}

/** Forward + backward SDF passes for water/grass boundary distances.
 *
 *  When `nearestWaterOut` is supplied, also fills it with the packed tile
 *  coords (`(row << 8) | col`) of the nearest water-tile pixel for every
 *  pixel — the source of the chamfer propagation in the grass-side pass.
 *  Pixels that didn't receive any water propagation (water-free maps) keep
 *  the sentinel `NEAREST_WATER_NONE`. Used by the 3D shader to find the
 *  owner of bank pixels that span into grass-tile neighbors. */
function computeSignedDistanceField(
  W: number,
  H: number,
  map: GameMap,
  nearestWaterOut?: Uint16Array,
): Float32Array {
  const distFromWater = initDistanceField(W, H, map, 1);
  propagateDistances(distFromWater, W, H);

  const distFromGrass = initDistanceField(W, H, map, 0);
  if (nearestWaterOut) {
    initSourceField(nearestWaterOut, W, H, map);
  }
  propagateDistances(distFromGrass, W, H, nearestWaterOut);

  return combineSDF(distFromWater, distFromGrass, W * H);
}

/** Initialize a distance field: INF where tile matches `seedTile`, 0 elsewhere. */
function initDistanceField(
  W: number,
  H: number,
  map: GameMap,
  seedTile: number,
): Float32Array {
  const dist = new Float32Array(W * H);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      dist[py * W + px] =
        tileAt(map, pxToTile(py), pxToTile(px)) === seedTile ? 1e9 : 0;
    }
  }
  return dist;
}

/** Initialize a source-tracking field paired with `initDistanceField(map, 0)`
 *  — the grass-side propagation pass where water tiles are the seeds. Each
 *  water-tile pixel gets its own tile coords as source; grass-tile pixels
 *  start at the sentinel and inherit a source from their nearest seed during
 *  `propagateDistances`. */
function initSourceField(
  out: Uint16Array,
  W: number,
  H: number,
  map: GameMap,
): void {
  out.fill(NEAREST_WATER_NONE);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const tr = pxToTile(py);
      const tc = pxToTile(px);
      if (isWater(map.tiles, tr, tc)) {
        out[py * W + px] = (tr << 8) | tc;
      }
    }
  }
}

/** Two-pass (forward + backward) distance propagation with orthogonal and
 *  diagonal steps. When `source` is supplied, the source value of the winning
 *  neighbor is copied alongside the relaxed distance so the final array
 *  records which seed each pixel propagated from. */
function propagateDistances(
  dist: Float32Array,
  W: number,
  H: number,
  source?: Uint16Array,
): void {
  // Chamfer distance costs: ORTHO = 1 pixel step, DIAG ≈ √2 for diagonal steps.
  // This approximates Euclidean distance using a two-pass sequential scan.
  const ORTHO = 1.0;
  const DIAG = 1.414;
  // Forward pass
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const i = py * W + px;
      if (dist[i] === 0) continue;
      let distance = dist[i]!;
      let bestSource = source !== undefined ? source[i]! : 0;
      if (py > 0) {
        const neighborIdx = (py - 1) * W + px;
        const cand = dist[neighborIdx]! + ORTHO;
        if (cand < distance) {
          distance = cand;
          if (source !== undefined) bestSource = source[neighborIdx]!;
        }
      }
      if (px > 0) {
        const neighborIdx = py * W + (px - 1);
        const cand = dist[neighborIdx]! + ORTHO;
        if (cand < distance) {
          distance = cand;
          if (source !== undefined) bestSource = source[neighborIdx]!;
        }
      }
      if (py > 0 && px > 0) {
        const neighborIdx = (py - 1) * W + (px - 1);
        const cand = dist[neighborIdx]! + DIAG;
        if (cand < distance) {
          distance = cand;
          if (source !== undefined) bestSource = source[neighborIdx]!;
        }
      }
      if (py > 0 && px < W - 1) {
        const neighborIdx = (py - 1) * W + (px + 1);
        const cand = dist[neighborIdx]! + DIAG;
        if (cand < distance) {
          distance = cand;
          if (source !== undefined) bestSource = source[neighborIdx]!;
        }
      }
      dist[i] = distance;
      if (source !== undefined) source[i] = bestSource;
    }
  }
  // Backward pass
  for (let py = H - 1; py >= 0; py--) {
    for (let px = W - 1; px >= 0; px--) {
      const i = py * W + px;
      if (dist[i] === 0) continue;
      let distance = dist[i]!;
      let bestSource = source !== undefined ? source[i]! : 0;
      if (py < H - 1) {
        const neighborIdx = (py + 1) * W + px;
        const cand = dist[neighborIdx]! + ORTHO;
        if (cand < distance) {
          distance = cand;
          if (source !== undefined) bestSource = source[neighborIdx]!;
        }
      }
      if (px < W - 1) {
        const neighborIdx = py * W + (px + 1);
        const cand = dist[neighborIdx]! + ORTHO;
        if (cand < distance) {
          distance = cand;
          if (source !== undefined) bestSource = source[neighborIdx]!;
        }
      }
      if (py < H - 1 && px < W - 1) {
        const neighborIdx = (py + 1) * W + (px + 1);
        const cand = dist[neighborIdx]! + DIAG;
        if (cand < distance) {
          distance = cand;
          if (source !== undefined) bestSource = source[neighborIdx]!;
        }
      }
      if (py < H - 1 && px > 0) {
        const neighborIdx = (py + 1) * W + (px - 1);
        const cand = dist[neighborIdx]! + DIAG;
        if (cand < distance) {
          distance = cand;
          if (source !== undefined) bestSource = source[neighborIdx]!;
        }
      }
      dist[i] = distance;
      if (source !== undefined) source[i] = bestSource;
    }
  }
}

/** Combine water/grass distance fields into signed distance: positive in water, negative in grass. */
function combineSDF(
  distFromWater: Float32Array,
  distFromGrass: Float32Array,
  len: number,
): Float32Array {
  const sdf = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    sdf[i] = distFromWater[i]! > 0 ? distFromWater[i]! : -distFromGrass[i]!;
  }
  return sdf;
}

/** Gaussian blur on the SDF to round water/grass boundary corners. */
function blurSignedDistanceField(
  sdf: Float32Array,
  W: number,
  H: number,
): void {
  const tmp = new Float32Array(W * H);
  // Blur radius: tuned to smooth chamfer-distance aliasing on diagonal river
  // banks without flattening the distance peaks inside small water clusters
  // (sinkholes). A 4-tile T-shaped cluster has a max raw distance of ~9 px at
  // its deepest point; radius 2 (two passes) keeps that peak above the
  // BANK_TO_WATER_DIST threshold so small pools render as real water, while
  // still smoothing out the 1-pixel chamfer stair-steps on river edges.
  const BLUR_R = 2;
  const BLUR_D = 2 * BLUR_R + 1;

  function boxBlurH(src: Float32Array, dst: Float32Array): void {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0;
        for (let k = -BLUR_R; k <= BLUR_R; k++) {
          const sx = Math.max(0, Math.min(W - 1, x + k));
          sum += src[y * W + sx]!;
        }
        dst[y * W + x] = sum / BLUR_D;
      }
    }
  }

  function boxBlurV(src: Float32Array, dst: Float32Array): void {
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        let sum = 0;
        for (let k = -BLUR_R; k <= BLUR_R; k++) {
          const sy = Math.max(0, Math.min(H - 1, y + k));
          sum += src[sy * W + x]!;
        }
        dst[y * W + x] = sum / BLUR_D;
      }
    }
  }

  for (let pass = 0; pass < 2; pass++) {
    boxBlurH(sdf, tmp);
    boxBlurV(tmp, sdf);
  }
}

/**
 * Paint grass/bank/water pixels into an ImageData buffer using the SDF.
 *
 * For each pixel: resolve tile coordinates, apply per-tile texture offsets to
 * the grass/water base colors, then blend between grass → bank → water based
 * on the signed-distance value at that pixel.
 */
function renderTerrainPixels(
  imgData: ImageData,
  sdf: Float32Array,
  W: number,
  H: number,
  map: GameMap,
  inBattle: boolean,
  frozenTiles?: ReadonlySet<number>,
): void {
  const data = imgData.data;

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const distance = sdf[py * W + px]!;

      // Map pixel back to tile grid and local offset within that tile
      const tr = pxToTile(py);
      const tc = pxToTile(px);
      const lx = px - tc * TILE_SIZE;
      const ly = py - tr * TILE_SIZE;

      // Apply per-tile texture detail to base colors
      const grass = texturedColor(
        GRASS_TEX,
        grassBaseColor(tr, tc, inBattle),
        inBattle,
        lx,
        ly,
      );
      // Use ice color for frozen water tiles — bank transitions adapt automatically.
      // At ice/water tile boundaries, blend ICE_COLOR → WATER_COLOR over a few
      // pixels so thawed tiles don't produce hard squared edges.
      const tileKey = tr * GRID_COLS + tc;
      const tileIsFrozen = frozenTiles?.has(tileKey);
      let waterBase: RGB = WATER_COLOR;
      if (tileIsFrozen) {
        const iceBlend = iceEdgeBlend(frozenTiles!, tr, tc, lx, ly);
        waterBase =
          iceBlend < 1 ? lerp3(WATER_COLOR, ICE_COLOR, iceBlend) : ICE_COLOR;
      }
      // Frozen tiles render as smooth ice — skip the wave texture that
      // brightens/darkens battle-mode water along WAVE_HI / WAVE_LO.
      const water = tileIsFrozen
        ? waterBase
        : texturedColor(WATER_TEX, waterBase, inBattle, lx, ly);

      // Blend grass → bank → water based on SDF distance
      const color = selectTerrainColor(
        tileAt(map, tr, tc) === 1,
        distance,
        grass,
        water,
      );

      const idx = (py * W + px) * 4;
      data[idx] = color[0];
      data[idx + 1] = color[1];
      data[idx + 2] = color[2];
      data[idx + 3] = 255;
    }
  }
}

function grassBaseColor(tr: number, tc: number, inBattle: boolean): RGB {
  return inBattle
    ? GRASS_BATTLE
    : (tr + tc) % 2 === 0
      ? GRASS_DARK
      : GRASS_LIGHT;
}

/** Apply a per-pixel texture offset to a base color, only in battle mode. */
function texturedColor(
  tex: ArrayLike<number>,
  base: RGB,
  inBattle: boolean,
  lx: number,
  ly: number,
): RGB {
  const offset = inBattle ? tex[ly * TILE_SIZE + lx]! : 0;
  if (offset === 0) return base;
  return [
    Math.max(0, Math.min(255, base[0] + offset)),
    Math.max(0, Math.min(255, base[1] + offset)),
    Math.max(0, Math.min(255, base[2] + offset)),
  ];
}

/** Pick terrain color based on SDF distance from water/grass boundary. */
function selectTerrainColor(
  isWater: boolean,
  distance: number,
  grass: RGB,
  water: RGB,
): RGB {
  if (!isWater) return grass;
  if (distance < GRASS_TO_BANK_DIST) return grass;
  if (distance < GRASS_TO_BANK_DIST + TRANSITION_WIDTH)
    return lerp3(
      grass,
      BANK_COLOR,
      smoothClamp((distance - GRASS_TO_BANK_DIST) / TRANSITION_WIDTH),
    );
  if (distance < BANK_TO_WATER_DIST) return BANK_COLOR;
  if (distance < BANK_TO_WATER_DIST + TRANSITION_WIDTH)
    return lerp3(
      BANK_COLOR,
      water,
      smoothClamp((distance - BANK_TO_WATER_DIST) / TRANSITION_WIDTH),
    );
  return water;
}

function tileAt(map: GameMap, r: number, c: number): number {
  if (r < 0 || r >= GRID_ROWS || c < 0 || c >= GRID_COLS) return -1;
  return map.tiles[r]![c]!;
}

function lerp3(a: RGB, b: RGB, interpolationFactor: number): RGB {
  return [
    a[0] + (b[0] - a[0]) * interpolationFactor,
    a[1] + (b[1] - a[1]) * interpolationFactor,
    a[2] + (b[2] - a[2]) * interpolationFactor,
  ];
}

/** For a pixel inside a frozen tile, return 0–1 indicating how "icy" it is.
 *  1 = fully ice (interior), 0 = fully water (right at a non-frozen neighbor edge).
 *  Checks cardinal neighbors — if any is water but not frozen, the pixel
 *  fades toward water over ICE_BLEND_WIDTH pixels from that edge. */
function iceEdgeBlend(
  frozenTiles: ReadonlySet<number>,
  tr: number,
  tc: number,
  lx: number,
  ly: number,
): number {
  const top = !frozenTiles.has((tr - 1) * GRID_COLS + tc);
  const bot = !frozenTiles.has((tr + 1) * GRID_COLS + tc);
  const lft = !frozenTiles.has(tr * GRID_COLS + tc - 1);
  const rgt = !frozenTiles.has(tr * GRID_COLS + tc + 1);
  const ey = TILE_SIZE - 1 - ly; // distance to bottom edge
  const ex = TILE_SIZE - 1 - lx; // distance to right edge

  // Cardinal edge distances
  let minDist = ICE_BLEND_WIDTH;
  if (top) minDist = Math.min(minDist, ly);
  if (bot) minDist = Math.min(minDist, ey);
  if (lft) minDist = Math.min(minDist, lx);
  if (rgt) minDist = Math.min(minDist, ex);

  // Diagonal corner distances — use Euclidean distance to the corner point
  // so the blend rounds off instead of forming a small square.
  if (top && lft) minDist = Math.min(minDist, Math.sqrt(lx * lx + ly * ly));
  if (top && rgt) minDist = Math.min(minDist, Math.sqrt(ex * ex + ly * ly));
  if (bot && lft) minDist = Math.min(minDist, Math.sqrt(lx * lx + ey * ey));
  if (bot && rgt) minDist = Math.min(minDist, Math.sqrt(ex * ex + ey * ey));

  return smoothClamp(minDist / ICE_BLEND_WIDTH);
}

function smoothClamp(interpolationFactor: number): number {
  const c = Math.max(0, Math.min(1, interpolationFactor));
  return c * c * (3 - 2 * c);
}
