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
  MAP_PX_H,
  MAP_PX_W,
  OFFSCREEN_SCALE,
  SCALE,
  TOP_MARGIN_CANVAS_PX,
} from "../shared/core/grid.ts";
import { isGrass, isWater, pxToTile } from "../shared/core/spatial.ts";
import type {
  RenderObserver,
  RenderOverlay,
} from "../shared/ui/overlay-types.ts";
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
  /** Packed `(row << 8) | col` tile coords of the nearest water-tile pixel for
   *  every pixel — populated lazily on first `getNearestWaterTilePerPixel`
   *  call. `NEAREST_WATER_NONE` sentinel marks cells that didn't receive any
   *  water propagation (water-free map). Shape: `width * height`. */
  nearestWaterTile?: Uint16Array;
  /** Blurred signed distance field (positive in water, negative in grass,
   *  smoothed by the box-blur passes). Uploaded by the 3D terrain shader as
   *  an R32F DataTexture so the per-pixel grass→bank→water gradient can be
   *  computed in GLSL. Shape: `width * height`. */
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
  /** Pre-compute the SDF + nearest-water tracking for `map` so the first
   *  frame doesn't stall. Per-renderer-instance: each `createRenderMap`
   *  owns its own cache, so warming a map for one renderer doesn't affect
   *  another. `mapVersion` bumps (e.g. freeze/thaw, sinkhole modifier
   *  mutation) invalidate the cache. */
  precomputeTerrainCache: (map: GameMap) => void;
  /** Per-pixel packed `(row << 8) | col` tile coords of the nearest water-tile
   *  pixel, derived from the SDF source-tracking. Available for shader
   *  effects that need to spread an effect from water tiles into
   *  surrounding grass. `mapVersion`-keyed; populated lazily on first call.
   *  Each cell holds `NEAREST_WATER_NONE` when no water tile is reachable
   *  from that pixel (water-free map). */
  getNearestWaterTilePerPixel: (map: GameMap) => Uint16Array | undefined;
  /** Blurred signed-distance field for `map` — positive in water, negative in
   *  grass, magnitude = pixel distance from the water/grass boundary. Used by
   *  the 3D terrain shader to compute the grass→bank→water gradient
   *  per-fragment. `mapVersion`-keyed; populated lazily on first call. */
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

// Chamfer distance costs: ORTHO = 1 pixel step, DIAG ≈ √2 for diagonal steps.
// This approximates Euclidean distance using a sequential scan.
const CHAMFER_ORTHO = 1.0;
const CHAMFER_DIAG = 1.414;
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

  // Per-instance terrain SDF cache. The WeakMap is keyed by GameMap so
  // each game gets a fresh entry, and lives in this closure so multiple
  // test scenarios in the same file remain isolated.
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

  /** Compute + cache the blurred SDF and the nearest-water-tile array.
   *  The SDF shape depends only on the map's tile geometry, so it's keyed
   *  purely by `mapVersion` — freeze/thaw bumps mapVersion and invalidates
   *  the cache. */
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

  return {
    drawMap,
    precomputeTerrainCache: ensureTerrainSdfCache,
    getNearestWaterTilePerPixel,
    getBlurredSdf,
    sceneCanvas,
    captureScene,
    captureSceneOffscreen,
  };
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
  const distFromWater = initDistanceField(W, H, map, isWater);
  propagateDistances(distFromWater, W, H);

  const distFromGrass = initDistanceField(W, H, map, isGrass);
  if (nearestWaterOut) {
    initSourceField(nearestWaterOut, W, H, map);
  }
  propagateDistances(distFromGrass, W, H, nearestWaterOut);

  return combineSDF(distFromWater, distFromGrass, W * H);
}

/** Initialize a distance field: INF where the seed predicate matches the
 *  tile under each pixel, 0 elsewhere. */
function initDistanceField(
  W: number,
  H: number,
  map: GameMap,
  seedTilePredicate: (
    tiles: GameMap["tiles"],
    row: number,
    col: number,
  ) => boolean,
): Float32Array {
  const dist = new Float32Array(W * H);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      dist[py * W + px] = seedTilePredicate(
        map.tiles,
        pxToTile(py),
        pxToTile(px),
      )
        ? 1e9
        : 0;
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
  // Forward pass: top + left + both diagonals from the previous row are
  // already-visited. Backward pass: bottom + right + both diagonals from
  // the next row. (rowOffset, colOffset) flips between (-1, -1) and (+1, +1).
  pixelPass(dist, W, H, source, 0, H, 1, 0, W, 1, -1, -1);
  pixelPass(dist, W, H, source, H - 1, -1, -1, W - 1, -1, -1, 1, 1);
}

/** Single forward-or-backward chamfer pass over `dist`. Hoisted to module
 *  scope so the inner relax doesn't allocate any closures per pixel. The
 *  four already-visited neighbors are the previous-row's same-column
 *  cardinal and both diagonals (left + right) plus the same-row's
 *  previous-column cardinal — a fixed pattern derived from
 *  `(rowOffset, colOffset)`. */
function pixelPass(
  dist: Float32Array,
  W: number,
  H: number,
  source: Uint16Array | undefined,
  pyStart: number,
  pyEnd: number,
  pyStep: number,
  pxStart: number,
  pxEnd: number,
  pxStep: number,
  rowOffset: number,
  colOffset: number,
): void {
  for (let py = pyStart; py !== pyEnd; py += pyStep) {
    for (let px = pxStart; px !== pxEnd; px += pxStep) {
      const i = py * W + px;
      if (dist[i] === 0) continue;
      let distance = dist[i]!;
      let bestSource = source !== undefined ? source[i]! : 0;
      const prevRow = py + rowOffset;
      const prevCol = px + colOffset;
      const oppCol = px - colOffset;
      const prevRowInBounds = prevRow >= 0 && prevRow < H;
      const prevColInBounds = prevCol >= 0 && prevCol < W;
      const oppColInBounds = oppCol >= 0 && oppCol < W;

      // Relax against the four already-visited neighbors. Inlined (rather
      // than extracted into a closure) so the inner loop allocates nothing.
      if (prevRowInBounds) {
        const neighborIdx = prevRow * W + px;
        const cand = dist[neighborIdx]! + CHAMFER_ORTHO;
        if (cand < distance) {
          distance = cand;
          if (source !== undefined) bestSource = source[neighborIdx]!;
        }
      }
      if (prevColInBounds) {
        const neighborIdx = py * W + prevCol;
        const cand = dist[neighborIdx]! + CHAMFER_ORTHO;
        if (cand < distance) {
          distance = cand;
          if (source !== undefined) bestSource = source[neighborIdx]!;
        }
      }
      if (prevRowInBounds && prevColInBounds) {
        const neighborIdx = prevRow * W + prevCol;
        const cand = dist[neighborIdx]! + CHAMFER_DIAG;
        if (cand < distance) {
          distance = cand;
          if (source !== undefined) bestSource = source[neighborIdx]!;
        }
      }
      if (prevRowInBounds && oppColInBounds) {
        const neighborIdx = prevRow * W + oppCol;
        const cand = dist[neighborIdx]! + CHAMFER_DIAG;
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
