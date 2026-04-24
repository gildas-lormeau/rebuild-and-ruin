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
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import {
  DIRS_4,
  packTile,
  pxToTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type {
  CastleData,
  RenderObserver,
  RenderOverlay,
} from "../shared/ui/overlay-types.ts";
import { getPlayerColor, MAX_PLAYERS } from "../shared/ui/player-config.ts";
import { type RGB, STATUSBAR_HEIGHT } from "../shared/ui/theme.ts";
import {
  drawAnnouncement,
  drawBanner,
  drawComboFloats,
  drawGameOver,
  drawLifeLostDialog,
  drawPhaseTimer,
  drawPlayerSelect,
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
  /** One entry per connected sinkhole cluster (built from sinkholeTiles set
   *  the first time the cache is rebuilt with sinkholes present). Each cluster
   *  carries per-tile patches: 16×16 ImageData rendered with each possible
   *  enclosing-player color, so the right variant can be blitted on top of the
   *  base terrain at render time once we know the current owner. */
  sinkholeClusters?: SinkholeCluster[];
}

/** A connected group of sinkhole tiles (4-cardinal connectivity). */
interface SinkholeCluster {
  tiles: SinkholeTilePatches[];
}

/** Per-tile precomputed bank/water bitmaps, one per (phase × owner) variant.
 *  Variant key is built by `variantId(inBattle, playerId)`. */
interface SinkholeTilePatches {
  row: number;
  col: number;
  patches: Map<string, ImageData>;
}

/** Tile-key → owning player tables built from the current overlay (one
 *  entry per non-cluster collidable tile). Used to classify cluster cardinal
 *  neighbors as "interior of player X", "wall", or "open grass". */
interface OwnerTables {
  interiorOwners: Map<number, ValidPlayerSlot>;
  wallTiles: Set<number>;
}

interface OffscreenPair {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

/** Cached sinkhole-overlay ImageData for the 3D renderer's upload path.
 *  The overlay input refs (`sinkholeTiles`, `castles`, `battleTerritory`,
 *  `battleWalls`) are all reused across frames when nothing mutates, so
 *  reference equality is enough to skip the rebuild on steady-state frames.
 *  `hasContent` distinguishes "empty overlay (no owned clusters)" from
 *  "not yet computed" — both return `undefined` to the 3D caller, but the
 *  cached empty slot still prevents a rebuild on the next frame. */
interface SinkholeOverlayCache {
  map: GameMap;
  mapVersion: number;
  inBattle: boolean;
  sinkholeTiles: ReadonlySet<number>;
  castles: ReadonlyArray<CastleData> | undefined;
  battleTerritory: ReadonlyArray<ReadonlySet<number>> | undefined;
  battleWalls: ReadonlyArray<ReadonlySet<number>> | undefined;
  image: ImageData;
  hasContent: boolean;
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
   *  otherwise aspect mismatches with the 3D worldCanvas's top strip
   *  would letterbox the two canvases differently. Set by the 3D
   *  renderer when it creates its 2D UI canvas; unset in pure 2D mode.
   *  May later host the status-bar HUD (removed from 3D). */
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
   *  warming a map for one renderer doesn't affect another. */
  precomputeTerrainCache: (map: GameMap) => void;
  /** Return the baked terrain bitmap (grass + water + bank + checkerboard
   *  noise) for `map` in either peacetime or battle palette. Populates the
   *  cache on first call via `precomputeTerrainCache`. The 3D renderer
   *  uploads this as a CanvasTexture so water/grass/bank visuals stay
   *  pixel-identical across 2D and 3D. */
  getTerrainBitmap: (map: GameMap, inBattle: boolean) => ImageData;
  /** Return a MAP_PX_W × MAP_PX_H ImageData containing only the owner-tinted
   *  sinkhole bank patches (transparent elsewhere), or `undefined` when no
   *  enclosed sinkhole cluster exists for the current overlay. The 3D
   *  renderer uploads this as a CanvasTexture on a plane that sits above
   *  the terrain mesh so the tile-grain mesh tint is overdrawn by the
   *  pixel-grain bank gradient. Cached on overlay-ref fingerprint so
   *  steady-state frames skip the rebuild. */
  getSinkholeOverlayBitmap: (
    map: GameMap,
    overlay: RenderOverlay | undefined,
  ) => ImageData | undefined;
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
// Cobblestone sprite stone-gray base — must mirror scripts/generate-sprites.html
// drawCobblestone(): final color = COBBLESTONE_BASE + interiorLight * tint factor.
const COBBLESTONE_BASE: RGB = [90, 85, 80];
const COBBLESTONE_TINT_FACTOR = 0.15;
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
   *  constructed with `deps.reserveTopStrip = true` (3D mode); 0
   *  otherwise. Constant across frames — derived once from the
   *  construction-time flag and referenced by `captureScene` so banner
   *  snapshots cover the game area only, not the reserved strip. */
  const topStripH = deps.reserveTopStrip ? TOP_MARGIN_CANVAS_PX : 0;
  /** Cached owner-tinted sinkhole overlay ImageData for the 3D upload path.
   *  Invalidated on any input ref change; held here so steady-state frames
   *  skip the per-pixel rebuild and the texture upload that follows. */
  let sinkholeOverlayCache: SinkholeOverlayCache | undefined;

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
   *  render of each doesn't stall the frame. Call during game init. */
  function precomputeTerrainCache(map: GameMap): void {
    const W = MAP_PX_W;
    const H = MAP_PX_H;
    const cache = getTerrainCache(map, W, H);
    if (cache.normal && cache.battle) return;

    const sdf = computeSignedDistanceField(W, H, map);
    blurSignedDistanceField(sdf, W, H);

    if (!cache.normal) {
      const imgData = new ImageData(W, H);
      renderTerrainPixels(imgData, sdf, W, H, map, false);
      cache.normal = imgData;
    }
    if (!cache.battle) {
      const imgData = new ImageData(W, H);
      renderTerrainPixels(imgData, sdf, W, H, map, true);
      cache.battle = imgData;
    }
  }

  function getMainCtx(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    // The offscreen-display canvas has its own cache slot so capture-path
    // draws don't evict the visible canvas's cached context (and vice-versa).
    if (offscreenCtxCache?.canvas === canvas)
      return offscreenCtxCache.canvasCtx;
    if (visibleCtxCache?.canvas === canvas) return visibleCtxCache.canvasCtx;
    // `alpha: true` (the default) so in 3D mode the regions where we skip
    // the terrain layer remain transparent, letting the WebGL canvas below
    // show through. 2D mode is unaffected because the terrain layer paints
    // every pixel each frame, so no background shows through.
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

  /** Copy `src` pixels into `dst` at (dx, dy). Used by the sinkhole-overlay
   *  bitmap builder to accumulate 16×16 tile patches into a MAP_PX_W ×
   *  MAP_PX_H transparent canvas without routing through a display context.
   *  `dst` is mutable ImageData; out-of-bounds pixels are skipped. */
  function blitImageDataIntoImageData(
    dst: ImageData,
    src: ImageData,
    dx: number,
    dy: number,
  ): void {
    const dstWidth = dst.width;
    const dstHeight = dst.height;
    const srcWidth = src.width;
    const srcHeight = src.height;
    const dstData = dst.data;
    const srcData = src.data;
    for (let sy = 0; sy < srcHeight; sy++) {
      const ty = dy + sy;
      if (ty < 0 || ty >= dstHeight) continue;
      for (let sx = 0; sx < srcWidth; sx++) {
        const tx = dx + sx;
        if (tx < 0 || tx >= dstWidth) continue;
        const srcIdx = (sy * srcWidth + sx) * 4;
        const dstIdx = (ty * dstWidth + tx) * 4;
        dstData[dstIdx] = srcData[srcIdx]!;
        dstData[dstIdx + 1] = srcData[srcIdx + 1]!;
        dstData[dstIdx + 2] = srcData[srcIdx + 2]!;
        dstData[dstIdx + 3] = srcData[srcIdx + 3]!;
      }
    }
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
    // viewport is always cleared to the full map (see
    // runtime-banner.ts `clearPhaseZoom`), so map→display is a uniform
    // SCALE multiply.
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

    const STATUS_BAR_H = overlay?.ui?.statusBar ? STATUSBAR_HEIGHT : 0;
    // Top strip: reserved empty space ABOVE the game area. In 3D mode
    // the runtime sets this flag unconditionally so tall wall meshes at
    // row 0 have a tile of headroom under battle tilt. In 2D mode the
    // flag is never set. Grows the canvas at the top; game-area
    // drawing shifts down by TOP_STRIP_H via `ctx.translate` below so
    // all existing map-coord draw code keeps working without per-call
    // offsets. The 2D status bar (when present) still paints at the
    // bottom — it's an independent strip; never both at once today.
    const TOP_STRIP_H = topStripH;
    const cw = CANVAS_W;
    const gameH = CANVAS_H;
    const ch = TOP_STRIP_H + gameH + STATUS_BAR_H;
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      canvasCtx.imageSmoothingEnabled = false;
    }

    ensureOffscreenSize(W, H);
    const overlayCtx = getScene().ctx;
    overlayCtx.clearRect(0, 0, W, H);
    // Clear the main (display) canvas too. With `alpha: true` this resets
    // the framebuffer to transparent, so in 3D mode the regions where we
    // skip the terrain layer reveal the WebGL canvas below. In 2D mode the
    // entire canvas is overdrawn with opaque terrain+UI pixels every frame,
    // so the clear is a no-op on the visible result.
    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

    // Render layers (order is load-bearing — later layers draw on top):
    //
    // Scene layers (drawn into offscreen canvas, affected by zoom viewport):
    //   1. Terrain base         — grass/water/bank pixels (cached ImageData)
    //   2. Water animation      — wave shimmer (battle only)
    //   3. Frozen tiles         — ice overlay on frozen river
    //   4. Castles              — wall tiles per player
    //   4b. Sinkhole overlays   — recolor enclosed lake banks to match owner
    //   5. Bonus squares        — flashing green diamonds
    //   6. Houses               — settler tents/huts
    //   7. Towers               — 2×2 tower sprites (alive/dead/pending)
    //   8. Burning pits         — ember glow + sprites
    //   9. Grunts               — directional tank sprites
    //  10. Banner scenes        — new scene above / old scene below the sweep line (phase transitions)
    //  11. Phantoms             — piece/cannon placement previews
    //  12. Battle effects       — impacts, cannonballs, balloons, crosshairs, timer
    //  13. Score deltas         — floating score change numbers
    //  14. Modifier highlight   — full-width flash for modifier reveal
    //  15. Banner               — phase transition banner overlay
    //  16. Game over / dialogs  — life-lost, upgrade-pick overlays
    //  17. Modal screens        — player select, options, controls (opaque, drawn last)
    //
    // HUD layers (drawn at display resolution, NOT affected by zoom):
    //  18. Combo floats + announcement text (scaled by SCALE)
    //  19. Status bar (below game scene)

    // Draw the new (target) scene — layers that change between phases.
    //
    // Terrain-group layers (grass/water pixels, water shimmer, frozen-ice
    // overlay, sinkhole recoloring, bonus pulse, burning-pit glyphs) are
    // grouped under the `terrain` flag. In 3D mode the WebGL canvas renders
    // these and this flag is flipped off so the 2D canvas leaves those
    // regions transparent; castles/entities/UI still render on 2D.
    drawPhaseTimer(overlayCtx, map, overlay, now);
    drawSelectionCursor(overlayCtx, map, overlay, now);
    drawScoreDeltas(overlayCtx, overlay);
    drawBanner(overlayCtx, W, H, overlay);
    drawGameOver(overlayCtx, W, H, overlay);
    drawLifeLostDialog(overlayCtx, W, H, overlay, now);
    drawUpgradePick(overlayCtx, W, H, overlay, now);

    // Full-screen modal screens (opaque — drawn last, on top of everything)
    drawPlayerSelect(overlayCtx, W, H, overlay, now);
    drawOptionsScreen(overlayCtx, W, H, overlay, now);
    drawControlsScreen(overlayCtx, W, H, overlay, now);

    // Scale up to display canvas (with optional zoom viewport). Every
    // display-space draw below operates under an optional top-strip
    // translate so map-coord drawing stays unchanged: (0, 0) in the
    // translated frame is the top-left of the GAME AREA, never the
    // canvas. The status-bar draw below the restore uses raw canvas
    // coords because its anchor is the bottom of the canvas.
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

    // Status bar drawn at display resolution below the game scene.
    // Anchored to the bottom of the FULL canvas (ch), so no translate
    // needed — the top strip and status bar are independent regions.
    if (STATUS_BAR_H > 0) {
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

  function getTerrainBitmap(map: GameMap, inBattle: boolean): ImageData {
    precomputeTerrainCache(map);
    const cache = getTerrainCache(map, MAP_PX_W, MAP_PX_H);
    return inBattle ? cache.battle! : cache.normal!;
  }

  function getSinkholeOverlayBitmap(
    map: GameMap,
    overlay: RenderOverlay | undefined,
  ): ImageData | undefined {
    const sinkholeTiles = overlay?.entities?.sinkholeTiles;
    if (!sinkholeTiles || sinkholeTiles.size === 0) {
      sinkholeOverlayCache = undefined;
      return undefined;
    }
    const inBattle = !!overlay.battle?.inBattle;
    const castles = inBattle ? undefined : overlay.castles;
    const battleTerritory = inBattle
      ? overlay.battle?.battleTerritory
      : undefined;
    const battleWalls = inBattle ? overlay.battle?.battleWalls : undefined;
    if (
      sinkholeOverlayCache &&
      sinkholeOverlayCache.map === map &&
      sinkholeOverlayCache.mapVersion === map.mapVersion &&
      sinkholeOverlayCache.inBattle === inBattle &&
      sinkholeOverlayCache.sinkholeTiles === sinkholeTiles &&
      sinkholeOverlayCache.castles === castles &&
      sinkholeOverlayCache.battleTerritory === battleTerritory &&
      sinkholeOverlayCache.battleWalls === battleWalls
    ) {
      return sinkholeOverlayCache.hasContent
        ? sinkholeOverlayCache.image
        : undefined;
    }
    ensureSinkholeClusters(map, sinkholeTiles);
    const cache = getTerrainCache(map, MAP_PX_W, MAP_PX_H);
    const image = new ImageData(MAP_PX_W, MAP_PX_H);
    let hasContent = false;
    const blit = (img: ImageData, dx: number, dy: number): void => {
      blitImageDataIntoImageData(image, img, dx, dy);
      hasContent = true;
    };
    drawSinkholeOverlays(cache, blit, overlay);
    sinkholeOverlayCache = {
      map,
      mapVersion: map.mapVersion,
      inBattle,
      sinkholeTiles,
      castles,
      battleTerritory,
      battleWalls,
      image,
      hasContent,
    };
    return hasContent ? image : undefined;
  }

  /** Populate `cache.sinkholeClusters` if not already built. `drawTerrain`
   *  builds them lazily on the first draw, but `getSinkholeOverlayBitmap`
   *  may be called from the 3D path before the 2D draw has run — so we
   *  replicate the SDF + cluster build here when the cache is empty. */
  function ensureSinkholeClusters(
    map: GameMap,
    sinkholeTiles: ReadonlySet<number>,
  ): void {
    const cache = getTerrainCache(map, MAP_PX_W, MAP_PX_H);
    if (cache.sinkholeClusters) return;
    const sdf = computeSignedDistanceField(MAP_PX_W, MAP_PX_H, map);
    blurSignedDistanceField(sdf, MAP_PX_W, MAP_PX_H);
    cache.sinkholeClusters = buildSinkholeClusters(
      sdf,
      MAP_PX_W,
      map,
      sinkholeTiles,
    );
  }

  return {
    drawMap,
    precomputeTerrainCache,
    getTerrainBitmap,
    getSinkholeOverlayBitmap,
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

/** Forward + backward SDF passes for water/grass boundary distances. */
function computeSignedDistanceField(
  W: number,
  H: number,
  map: GameMap,
): Float32Array {
  const distFromWater = initDistanceField(W, H, map, 1);
  propagateDistances(distFromWater, W, H);

  const distFromGrass = initDistanceField(W, H, map, 0);
  propagateDistances(distFromGrass, W, H);

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

/** Two-pass (forward + backward) distance propagation with orthogonal and diagonal steps. */
function propagateDistances(dist: Float32Array, W: number, H: number): void {
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
      if (py > 0)
        distance = Math.min(distance, dist[(py - 1) * W + px]! + ORTHO);
      if (px > 0)
        distance = Math.min(distance, dist[py * W + (px - 1)]! + ORTHO);
      if (py > 0 && px > 0)
        distance = Math.min(distance, dist[(py - 1) * W + (px - 1)]! + DIAG);
      if (py > 0 && px < W - 1)
        distance = Math.min(distance, dist[(py - 1) * W + (px + 1)]! + DIAG);
      dist[i] = distance;
    }
  }
  // Backward pass
  for (let py = H - 1; py >= 0; py--) {
    for (let px = W - 1; px >= 0; px--) {
      const i = py * W + px;
      if (dist[i] === 0) continue;
      let distance = dist[i]!;
      if (py < H - 1)
        distance = Math.min(distance, dist[(py + 1) * W + px]! + ORTHO);
      if (px < W - 1)
        distance = Math.min(distance, dist[py * W + (px + 1)]! + ORTHO);
      if (py < H - 1 && px < W - 1)
        distance = Math.min(distance, dist[(py + 1) * W + (px + 1)]! + DIAG);
      if (py < H - 1 && px > 0)
        distance = Math.min(distance, dist[(py + 1) * W + (px - 1)]! + DIAG);
      dist[i] = distance;
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
      const water = texturedColor(WATER_TEX, waterBase, inBattle, lx, ly);

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

/** Build the cluster + per-tile-variant table from the current sinkhole set.
 *  Called once per terrain-cache rebuild (mapVersion bump). For each cluster
 *  we precompute one 16×16 ImageData per (phase × player) combination so the
 *  draw pass can blit the right variant once it knows who currently encloses
 *  the lake (which may change as walls go up during WALL_BUILD). */
function buildSinkholeClusters(
  sdf: Float32Array,
  W: number,
  map: GameMap,
  sinkholeTiles: ReadonlySet<number>,
): SinkholeCluster[] {
  const clusters: SinkholeCluster[] = [];
  const visited = new Set<number>();
  for (const seedKey of sinkholeTiles) {
    if (visited.has(seedKey)) continue;
    // BFS by 4-cardinal connectivity to gather one connected cluster.
    const tileKeys: number[] = [];
    const queue = [seedKey];
    visited.add(seedKey);
    while (queue.length > 0) {
      const tileKey = queue.shift()!;
      tileKeys.push(tileKey);
      const { r, c } = unpackTile(tileKey);
      for (const [dr, dc] of DIRS_4) {
        const neighborKey = packTile(r + dr, c + dc);
        if (!sinkholeTiles.has(neighborKey)) continue;
        if (visited.has(neighborKey)) continue;
        visited.add(neighborKey);
        queue.push(neighborKey);
      }
    }
    const tiles: SinkholeTilePatches[] = tileKeys.map((tileKey) => {
      const { r, c } = unpackTile(tileKey);
      return {
        row: r,
        col: c,
        patches: buildSinkholeTilePatches(sdf, W, map, r, c),
      };
    });
    clusters.push({ tiles });
  }
  return clusters;
}

/** Render every (phase × player) variant for a single sinkhole tile.
 *  Each patch is a 16×16 ImageData that exactly replaces the base terrain on
 *  that tile, with the bank gradient blending into the player's interior or
 *  cobblestone color instead of grass green. */
function buildSinkholeTilePatches(
  sdf: Float32Array,
  W: number,
  map: GameMap,
  tileRow: number,
  tileCol: number,
): Map<string, ImageData> {
  const patches = new Map<string, ImageData>();
  const isWaterTile = tileAt(map, tileRow, tileCol) === 1;
  // Loop index bounded by MAX_PLAYERS — safe ValidPlayerSlot cast.
  for (let raw = 0; raw < MAX_PLAYERS; raw++) {
    const playerId = raw as unknown as ValidPlayerSlot;
    for (const inBattle of [false, true] as const) {
      const grassBase = ownerGrassBase(playerId, tileRow, tileCol, inBattle);
      patches.set(
        variantId(inBattle, playerId),
        renderSinkholeTilePatch(
          sdf,
          W,
          tileRow,
          tileCol,
          inBattle,
          isWaterTile,
          grassBase,
        ),
      );
    }
  }
  return patches;
}

/** Pick the "grass" base color the bank gradient should fade INTO when the
 *  sinkhole is enclosed by `playerId`. The sinkhole tile occupies (tileRow,
 *  tileCol) itself, so its patch must use the SAME interior shade that
 *  `drawCastleInterior` would render at that position — otherwise the
 *  checker square at that position is the wrong color and the pattern
 *  breaks across the sinkhole tile. In battle, cobblestone is uniform per
 *  player so parity is ignored. */
function ownerGrassBase(
  playerId: ValidPlayerSlot,
  tileRow: number,
  tileCol: number,
  inBattle: boolean,
): RGB {
  const colors = getPlayerColor(playerId);
  if (inBattle) return cobblestoneBaseColor(colors.interiorLight);
  // Match drawCastleInterior: interior_light is rendered at (r+c)%2 === 0.
  const isLight = (tileRow + tileCol) % 2 === 0;
  return isLight ? colors.interiorLight : colors.interiorDark;
}

/** Mirror of the cobblestone sprite's base fill — see scripts/generate-sprites.html
 *  drawCobblestone(). The sprite tints a stone-gray base with the player's
 *  interiorLight color; we reproduce that base so the lake bank fades into a
 *  matching gray instead of green during battle. */
function cobblestoneBaseColor(interiorLight: RGB): RGB {
  return [
    Math.floor(
      COBBLESTONE_BASE[0] + interiorLight[0] * COBBLESTONE_TINT_FACTOR,
    ),
    Math.floor(
      COBBLESTONE_BASE[1] + interiorLight[1] * COBBLESTONE_TINT_FACTOR,
    ),
    Math.floor(
      COBBLESTONE_BASE[2] + interiorLight[2] * COBBLESTONE_TINT_FACTOR,
    ),
  ];
}

/** Render a single 16×16 sinkhole-tile patch with a custom grass base color.
 *  Reuses the same SDF distance values as the base terrain — only the grass
 *  color the bank gradient blends INTO changes per variant. */
function renderSinkholeTilePatch(
  sdf: Float32Array,
  W: number,
  tileRow: number,
  tileCol: number,
  inBattle: boolean,
  isWaterTile: boolean,
  grassBase: RGB,
): ImageData {
  const patch = new ImageData(TILE_SIZE, TILE_SIZE);
  const data = patch.data;
  const tileX0 = tileCol * TILE_SIZE;
  const tileY0 = tileRow * TILE_SIZE;
  for (let ly = 0; ly < TILE_SIZE; ly++) {
    for (let lx = 0; lx < TILE_SIZE; lx++) {
      const px = tileX0 + lx;
      const py = tileY0 + ly;
      const distance = sdf[py * W + px]!;
      const grass = texturedColor(GRASS_TEX, grassBase, inBattle, lx, ly);
      const water = texturedColor(WATER_TEX, WATER_COLOR, inBattle, lx, ly);
      const color = selectTerrainColor(isWaterTile, distance, grass, water);
      const idx = (ly * TILE_SIZE + lx) * 4;
      data[idx] = color[0];
      data[idx + 1] = color[1];
      data[idx + 2] = color[2];
      data[idx + 3] = 255;
    }
  }
  return patch;
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

/** Recolor the bank pixels of every owned sinkhole tile so they blend into
 *  the surrounding interior/cobblestone color instead of the green that the
 *  base terrain bitmap painted. Unowned sinkholes are left untouched (the
 *  base bitmap already renders them correctly against grass).
 *
 *  The cluster cache is shared between the main scene and the banner prev
 *  scene (both key off map reference), but each scene has its own
 *  `sinkholeTiles` set — the prev scene can be a stale snapshot from before
 *  a new sinkhole was applied. Filter clusters by the scene's own set so we
 *  never blit an owner variant for a lake that the prev overlay doesn't know
 *  about (which would read ownership from stale castles and paint the wrong
 *  color on the first frame of a reveal banner). */
function drawSinkholeOverlays(
  cache: TerrainImageCache,
  blit: (img: ImageData, dx: number, dy: number) => void,
  overlay?: RenderOverlay,
): void {
  const sinkholeTiles = overlay?.entities?.sinkholeTiles;
  if (!sinkholeTiles || sinkholeTiles.size === 0) return;
  if (!cache.sinkholeClusters) return;
  const inBattle = !!overlay.battle?.inBattle;
  const owners = buildOwnerTables(overlay, inBattle);
  for (const cluster of cache.sinkholeClusters) {
    // Skip clusters whose tiles aren't in this scene's set — the prev scene
    // during a reveal banner only knows about pre-existing lakes.
    const clusterKeys = collectClusterKeys(cluster);
    if (!clusterBelongsToScene(clusterKeys, sinkholeTiles)) continue;
    const owner = findSinkholeOwner(cluster, owners);
    if (owner === undefined) continue;
    const key = variantId(inBattle, owner);
    for (const tile of cluster.tiles) {
      const patch = tile.patches.get(key);
      if (!patch) continue;
      blit(patch, tile.col * TILE_SIZE, tile.row * TILE_SIZE);
    }
  }
}

/** Variant cache key — `n0`/`b1`/etc. (phase × player). */
function variantId(inBattle: boolean, playerId: ValidPlayerSlot): string {
  return `${inBattle ? "b" : "n"}${playerId}`;
}

function buildOwnerTables(
  overlay: RenderOverlay,
  inBattle: boolean,
): OwnerTables {
  const interiorOwners = new Map<number, ValidPlayerSlot>();
  const wallTiles = new Set<number>();
  if (inBattle) {
    const territories = overlay.battle?.battleTerritory;
    const walls = overlay.battle?.battleWalls;
    if (territories) {
      for (let pid = 0; pid < territories.length; pid++) {
        const territory = territories[pid];
        if (!territory) continue;
        const playerSlot = pid as unknown as ValidPlayerSlot;
        for (const key of territory) interiorOwners.set(key, playerSlot);
      }
    }
    if (walls) {
      for (const set of walls) {
        for (const key of set) wallTiles.add(key);
      }
    }
  } else if (overlay.castles) {
    for (const castle of overlay.castles) {
      for (const key of castle.interior) {
        interiorOwners.set(key, castle.playerId);
      }
      for (const key of castle.walls) wallTiles.add(key);
    }
  }
  return { interiorOwners, wallTiles };
}

/** Decide which player encloses a sinkhole cluster, if any. Game-state
 *  `player.interior` is the authoritative enclosure signal (`computeOutside`
 *  flood from the edges — walls block, everything else propagates, including
 *  water). Any cluster tile that lands inside a player's enclosed region is
 *  in `interiorOwners`; if two players both claim tiles in the same cluster
 *  (not currently possible — zones are isolated by rivers), the cluster is
 *  contested and we bail. */
function findSinkholeOwner(
  cluster: SinkholeCluster,
  owners: OwnerTables,
): ValidPlayerSlot | undefined {
  let candidate: ValidPlayerSlot | undefined;
  for (const tile of cluster.tiles) {
    const owner = owners.interiorOwners.get(packTile(tile.row, tile.col));
    if (owner === undefined) continue;
    if (candidate === undefined) candidate = owner;
    else if (candidate !== owner) return undefined;
  }
  return candidate;
}

/** Pack the cluster's tile coordinates into a key set for fast neighbor
 *  membership tests inside the cluster. */
function collectClusterKeys(cluster: SinkholeCluster): Set<number> {
  const keys = new Set<number>();
  for (const tile of cluster.tiles) keys.add(packTile(tile.row, tile.col));
  return keys;
}

/** A cluster belongs to the scene iff every one of its tiles is present in
 *  that scene's `sinkholeTiles` set. */
function clusterBelongsToScene(
  clusterKeys: ReadonlySet<number>,
  sceneSinkholeTiles: ReadonlySet<number>,
): boolean {
  for (const key of clusterKeys) {
    if (!sceneSinkholeTiles.has(key)) return false;
  }
  return true;
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
