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
  SCALE,
  TILE_SIZE,
} from "../shared/core/grid.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import {
  DIRS_4,
  facingToDir8,
  isBalloonCannon,
  isCannonAlive,
  isRampartCannon,
  isSuperCannon,
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
import {
  BANNER_HEIGHT_RATIO,
  type RGB,
  rgb,
  STATUSBAR_HEIGHT,
} from "../shared/ui/theme.ts";
import {
  drawBattleEffects,
  drawBonusSquares,
  drawBurningPits,
  drawFrozenTiles,
  drawGrunts,
  drawHouses,
  drawPhantoms,
  drawWaterAnimation,
} from "./render-effects.ts";
import { drawSprite } from "./render-sprites.ts";
import { drawTowers } from "./render-towers.ts";
import {
  drawAnnouncement,
  drawBanner,
  drawComboFloats,
  drawGameOver,
  drawLifeLostDialog,
  drawModifierRevealHighlight,
  drawPlayerSelect,
  drawScoreDeltas,
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
  sceneCanvas: () => HTMLCanvasElement;
  /** Capture the current offscreen scene as ImageData (for banner prev-scene).
   *  Returns undefined if the scene canvas hasn't been initialized yet. */
  captureScene: () => ImageData | undefined;
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
// Neutral stone color used for all walls during battle phase
const NEUTRAL_WALL: RGB = [140, 130, 120];
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
const SPRITE_CANNON = "cannon";
// Transition width in pixels for ice→water blend at frozen tile boundaries.
const ICE_BLEND_WIDTH = 4;

export function createRenderMap(deps: RenderMapDeps = {}): RenderMap {
  const observer = deps.observer;
  const createOffscreenCanvas =
    deps.canvasFactory ?? (() => document.createElement("canvas"));

  let scene: OffscreenPair | undefined;
  let bannerScene: OffscreenPair | undefined;
  // Cached main-canvas context — avoids per-frame getContext overhead on Chrome mobile.
  let mainCtxCache:
    | {
        canvas: HTMLCanvasElement;
        canvasCtx: CanvasRenderingContext2D;
      }
    | undefined;
  /** Tracks which ImageData has been painted onto the banner temp canvas.
   *  When the reference changes (new banner / chained banner), the new
   *  ImageData is painted. */
  let bannerScenePainted: ImageData | undefined;

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
    if (mainCtxCache?.canvas === canvas) return mainCtxCache.canvasCtx;
    const canvasCtx = canvas.getContext("2d", { alpha: false })!;
    mainCtxCache = { canvas, canvasCtx };
    return canvasCtx;
  }

  function getScene(): OffscreenPair {
    if (!scene) {
      const canvas = createOffscreenCanvas();
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      scene = { canvas, ctx };
    }
    return scene;
  }

  function getBannerScene(): OffscreenPair {
    if (!bannerScene) {
      const canvas = createOffscreenCanvas();
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      bannerScene = { canvas, ctx };
    }
    return bannerScene;
  }

  function ensureOffscreenSize(width: number, height: number): void {
    const sceneCanvas = getScene().canvas;
    if (sceneCanvas.width !== width || sceneCanvas.height !== height) {
      sceneCanvas.width = width;
      sceneCanvas.height = height;
    }
    const bannerCanvas = getBannerScene().canvas;
    if (bannerCanvas.width !== width || bannerCanvas.height !== height) {
      bannerCanvas.width = width;
      bannerCanvas.height = height;
      bannerScenePainted = undefined;
    }
  }

  /** Composite the pre-transition scene below the banner sweep line.
   *
   *  Uses `prevSceneImageData` (captured via `captureScene()` before phase
   *  mutations) — no state cloning, no re-rendering, no cache.
   *  putImageData ignores clip regions, so we paint the ImageData onto the
   *  banner temp canvas once, then drawImage with a clip rect. */
  function drawBannerPrevScene(
    overlayCtx: CanvasRenderingContext2D,
    W: number,
    H: number,
    overlay: RenderOverlay | undefined,
  ): void {
    if (!overlay?.ui?.banner || !overlay.ui.bannerPrevScene) {
      bannerScenePainted = undefined;
      return;
    }

    const bannerH = Math.round(H * BANNER_HEIGHT_RATIO);
    const clipY = Math.round(overlay.ui.banner.y - bannerH / 2);
    if (clipY >= H) return;

    // Paint ImageData to temp canvas when it changes (new or chained banner).
    if (bannerScenePainted !== overlay.ui.bannerPrevScene) {
      const tmpCtx = getBannerScene().ctx;
      tmpCtx.putImageData(overlay.ui.bannerPrevScene, 0, 0);
      bannerScenePainted = overlay.ui.bannerPrevScene;
    }

    overlayCtx.save();
    overlayCtx.beginPath();
    overlayCtx.rect(0, clipY, W, H - clipY);
    overlayCtx.clip();
    overlayCtx.drawImage(getBannerScene().canvas, 0, 0);
    overlayCtx.restore();
    observer?.bannerComposited?.({
      clipY,
      H,
      W,
      bannerH,
    });
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
    const cw = CANVAS_W;
    const gameH = CANVAS_H;
    const ch = gameH + STATUS_BAR_H;
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      canvasCtx.imageSmoothingEnabled = false;
    }

    ensureOffscreenSize(W, H);
    const overlayCtx = getScene().ctx;
    overlayCtx.clearRect(0, 0, W, H);

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
    //  10. Banner prev-scene    — composited old scene below banner line (phase transitions)
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

    // Draw the new (target) scene — layers that change between phases
    const liveCache = getTerrainCache(map, W, H);
    drawTerrain(overlayCtx, W, H, map, liveCache, overlay);
    observer?.terrainDrawn?.("main", map);
    drawWaterAnimation(overlayCtx, map, overlay, now);
    drawFrozenTiles(overlayCtx, overlay, now);
    drawCastles(overlayCtx, overlay);
    drawSinkholeOverlays(overlayCtx, map, liveCache, overlay);
    drawBonusSquares(overlayCtx, overlay, now);
    drawHouses(overlayCtx, overlay);
    drawTowers(overlayCtx, map, overlay, now);
    drawBurningPits(overlayCtx, overlay, now);
    drawGrunts(overlayCtx, overlay);

    // If banner is active with old data, composite the old scene below the banner.
    drawBannerPrevScene(overlayCtx, W, H, overlay);

    // Layers that don't change between phases — draw once on top
    drawPhantoms(overlayCtx, overlay);
    drawBattleEffects(overlayCtx, map, overlay, now);
    drawScoreDeltas(overlayCtx, overlay);
    drawModifierRevealHighlight(overlayCtx, H, overlay, now);
    drawBanner(overlayCtx, W, H, overlay);
    drawGameOver(overlayCtx, W, H, overlay);
    drawLifeLostDialog(overlayCtx, W, H, overlay, now);
    drawUpgradePick(overlayCtx, W, H, overlay, now);

    // Full-screen modal screens (opaque — drawn last, on top of everything)
    drawPlayerSelect(overlayCtx, W, H, overlay, now);
    drawOptionsScreen(overlayCtx, W, H, overlay, now);
    drawControlsScreen(overlayCtx, W, H, overlay, now);

    // Scale up to display canvas (with optional zoom viewport)
    canvasCtx.imageSmoothingEnabled = false;
    const offscreenCanvas = getScene().canvas;
    if (viewport) {
      canvasCtx.drawImage(
        offscreenCanvas,
        viewport.x,
        viewport.y,
        viewport.w,
        viewport.h,
        0,
        0,
        cw,
        gameH,
      );
    } else {
      canvasCtx.drawImage(offscreenCanvas, 0, 0, cw, gameH);
    }

    // HUD text drawn at display resolution (screen-relative, not affected by zoom)
    canvasCtx.save();
    canvasCtx.scale(SCALE, SCALE);
    drawComboFloats(canvasCtx, W, H, overlay);
    drawAnnouncement(canvasCtx, W, H, overlay);
    canvasCtx.restore();

    // Status bar drawn at display resolution below the game scene
    if (STATUS_BAR_H > 0) {
      drawStatusBar(canvasCtx, cw, ch, overlay);
    }
  }

  function sceneCanvas(): HTMLCanvasElement {
    return getScene().canvas;
  }

  /** Grab the current offscreen scene pixels. Called once before a phase
   *  transition mutates state — the returned ImageData becomes the banner's
   *  "old scene" below the sweep line. */
  function captureScene(): ImageData | undefined {
    if (!scene) return undefined;
    const { canvas: offCanvas, ctx: offCtx } = scene;
    if (offCanvas.width === 0 || offCanvas.height === 0) return undefined;
    return offCtx.getImageData(0, 0, offCanvas.width, offCanvas.height);
  }

  return { drawMap, precomputeTerrainCache, sceneCanvas, captureScene };
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

/** Build SDF for water/grass boundaries, blur it, and paint terrain pixels.
 *
 *  `cache` is the per-renderer terrain cache for `map` — the caller fetches
 *  it from the closure-bound `getTerrainCache` and passes it in. drawTerrain
 *  reads `cache.normal` / `cache.battle` / `cache.sinkholeClusters` and
 *  writes the corresponding fields when it has to rebuild. */
function drawTerrain(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  H: number,
  map: GameMap,
  cache: TerrainImageCache,
  overlay?: RenderOverlay,
): void {
  const inBattle = !!overlay?.battle?.inBattle;
  const cachedImage = inBattle ? cache.battle : cache.normal;
  const sinkholeTiles = overlay?.entities?.sinkholeTiles;
  const frozenTiles = overlay?.entities?.frozenTiles;
  const needsSinkholeClusters =
    !!sinkholeTiles && sinkholeTiles.size > 0 && !cache.sinkholeClusters;
  if (cachedImage && !needsSinkholeClusters) {
    overlayCtx.putImageData(cachedImage, 0, 0);
    return;
  }

  const sdf = computeSignedDistanceField(W, H, map);
  blurSignedDistanceField(sdf, W, H);

  if (!cachedImage) {
    const imgData = overlayCtx.createImageData(W, H);
    renderTerrainPixels(imgData, sdf, W, H, map, inBattle, frozenTiles);
    overlayCtx.putImageData(imgData, 0, 0);
    if (inBattle) cache.battle = imgData;
    else cache.normal = imgData;
  } else {
    overlayCtx.putImageData(cachedImage, 0, 0);
  }

  if (needsSinkholeClusters && sinkholeTiles) {
    cache.sinkholeClusters = buildSinkholeClusters(sdf, W, map, sinkholeTiles);
  }
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
  overlayCtx: CanvasRenderingContext2D,
  map: GameMap,
  cache: TerrainImageCache,
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
    const owner = findSinkholeOwner(cluster, clusterKeys, owners, map);
    if (owner === undefined) continue;
    const key = variantId(inBattle, owner);
    for (const tile of cluster.tiles) {
      const patch = tile.patches.get(key);
      if (!patch) continue;
      overlayCtx.putImageData(
        patch,
        tile.col * TILE_SIZE,
        tile.row * TILE_SIZE,
      );
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

/** Decide which player encloses a sinkhole cluster, if any. A cluster is
 *  enclosed iff every cardinal neighbor of every cluster tile is one of:
 *    - water (river / another lake tile / cluster member)
 *    - a wall tile
 *    - interior of one specific player (no two-player ambiguity allowed)
 *  Any "open grass" cardinal neighbor (grass not in any interior) means the
 *  lake escapes to the outside, so we return null and the base terrain — with
 *  green/cobblestone bank — is left untouched. This matters because a lake
 *  can sit *next* to a player's territory (the water itself acts as the
 *  enclosure boundary on that side) without actually being inside it; the
 *  earlier "any neighbor in interior" check classified those as enclosed. */
function findSinkholeOwner(
  cluster: SinkholeCluster,
  clusterKeys: ReadonlySet<number>,
  owners: OwnerTables,
  map: GameMap,
): ValidPlayerSlot | undefined {
  let candidate: ValidPlayerSlot | undefined;
  for (const tile of cluster.tiles) {
    for (const [dr, dc] of DIRS_4) {
      const nr = tile.row + dr;
      const nc = tile.col + dc;
      const neighborKey = packTile(nr, nc);
      if (clusterKeys.has(neighborKey)) continue;
      const interiorOwner = owners.interiorOwners.get(neighborKey);
      if (interiorOwner !== undefined) {
        if (candidate === undefined) candidate = interiorOwner;
        else if (candidate !== interiorOwner) return undefined;
        continue;
      }
      if (owners.wallTiles.has(neighborKey)) continue;
      const tileType = tileAt(map, nr, nc);
      // Water (river / another lake tile) is a benign neighbor — the wall
      // could go around the larger water system. Anything else (grass not in
      // any interior, or off-map) means the lake is open on that side.
      if (tileType !== 1) return undefined;
    }
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

/** Draw castle walls, interiors, wall debris, and cannons for all players. */
function drawCastles(
  overlayCtx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.castles) return;
  for (const castle of overlay.castles) {
    const battleTerritory = overlay.battle?.battleTerritory?.[castle.playerId];
    const battleWalls = overlay.battle?.battleWalls?.[castle.playerId];
    drawCastleInterior(overlayCtx, castle, battleTerritory);
    drawCastleWalls(overlayCtx, castle, battleWalls);
    drawWallDebris(overlayCtx, castle, battleWalls);
    drawCastleCannons(overlayCtx, castle);
  }
}

function drawCastleInterior(
  overlayCtx: CanvasRenderingContext2D,
  castle: CastleData,
  battleTerritory: Set<number> | undefined,
): void {
  if (battleTerritory) {
    const cobbleName = `cobblestone_p${castle.playerId}`;
    for (const key of battleTerritory) {
      const { r, c } = unpackTile(key);
      drawSprite(overlayCtx, cobbleName, c * TILE_SIZE, r * TILE_SIZE);
    }
  } else {
    for (const key of castle.interior) {
      const { r, c } = unpackTile(key);
      const isLight = (r + c) % 2 === 0;
      drawSprite(
        overlayCtx,
        `interior_${isLight ? "light" : "dark"}_p${castle.playerId}`,
        c * TILE_SIZE,
        r * TILE_SIZE,
      );
    }
  }
}

/** Draw castle walls with a staggered 3-row brick pattern, mortar lines, and edge bevels. */
function drawCastleWalls(
  overlayCtx: CanvasRenderingContext2D,
  castle: CastleData,
  battleWalls: Set<number> | undefined,
): void {
  const colors = getPlayerColor(castle.playerId);
  const wall: RGB = battleWalls ? NEUTRAL_WALL : colors.wall;
  const [wallRed, wallGreen, wallBlue] = wall;
  const lightEdge = rgb([
    Math.min(255, wallRed + 35),
    Math.min(255, wallGreen + 35),
    Math.min(255, wallBlue + 35),
  ]);
  const shadowEdge = rgb([
    Math.max(0, wallRed - 40),
    Math.max(0, wallGreen - 40),
    Math.max(0, wallBlue - 40),
  ]);
  const mortarStyle = rgb([
    Math.max(0, wallRed - 25),
    Math.max(0, wallGreen - 25),
    Math.max(0, wallBlue - 25),
  ]);
  const wallStyle = rgb(wall);

  for (const key of castle.walls) {
    const { r, c } = unpackTile(key);
    const px = c * TILE_SIZE;
    const py = r * TILE_SIZE;
    // Base wall fill
    overlayCtx.fillStyle = wallStyle;
    overlayCtx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
    // Mortar lines — 3-row staggered brick pattern
    overlayCtx.fillStyle = mortarStyle;
    overlayCtx.fillRect(px, py + 5, TILE_SIZE, 1);
    overlayCtx.fillRect(px, py + 11, TILE_SIZE, 1);
    overlayCtx.fillRect(px + 4, py, 1, 5);
    overlayCtx.fillRect(px + 10, py, 1, 5);
    overlayCtx.fillRect(px + 7, py + 6, 1, 5);
    overlayCtx.fillRect(px + 13, py + 6, 1, 5);
    overlayCtx.fillRect(px + 3, py + 12, 1, 4);
    overlayCtx.fillRect(px + 9, py + 12, 1, 4);
    // Bevels on exposed edges only
    drawWallBevels(
      overlayCtx,
      castle.walls,
      r,
      c,
      px,
      py,
      lightEdge,
      shadowEdge,
    );
    // Crack overlay for walls that absorbed a hit (Reinforced Walls upgrade)
    if (castle.damagedWalls?.has(key)) {
      drawDamagedWallCracks(overlayCtx, px, py);
    }
  }
}

/** Draw diagonal cracks on a damaged wall tile. */
function drawDamagedWallCracks(
  overlayCtx: CanvasRenderingContext2D,
  px: number,
  py: number,
): void {
  overlayCtx.save();
  overlayCtx.strokeStyle = "rgba(0, 0, 0, 0.45)";
  overlayCtx.lineWidth = 1;
  // Main diagonal crack
  overlayCtx.beginPath();
  overlayCtx.moveTo(px + 3, py + 2);
  overlayCtx.lineTo(px + 8, py + 7);
  overlayCtx.lineTo(px + 6, py + 10);
  overlayCtx.lineTo(px + 12, py + 14);
  overlayCtx.stroke();
  // Branch crack
  overlayCtx.beginPath();
  overlayCtx.moveTo(px + 8, py + 7);
  overlayCtx.lineTo(px + 12, py + 5);
  overlayCtx.stroke();
  overlayCtx.restore();
}

/** Draw 2px bevels on wall edges that have no neighbor. */
function drawWallBevels(
  overlayCtx: CanvasRenderingContext2D,
  walls: ReadonlySet<number>,
  r: number,
  c: number,
  px: number,
  py: number,
  lightEdge: string,
  shadowEdge: string,
): void {
  if (!walls.has(packTile(r - 1, c))) {
    overlayCtx.fillStyle = lightEdge;
    overlayCtx.fillRect(px, py, TILE_SIZE, 2);
  }
  if (!walls.has(packTile(r + 1, c))) {
    overlayCtx.fillStyle = shadowEdge;
    overlayCtx.fillRect(px, py + TILE_SIZE - 2, TILE_SIZE, 2);
  }
  if (!walls.has(packTile(r, c - 1))) {
    overlayCtx.fillStyle = lightEdge;
    overlayCtx.fillRect(px, py, 2, TILE_SIZE);
  }
  if (!walls.has(packTile(r, c + 1))) {
    overlayCtx.fillStyle = shadowEdge;
    overlayCtx.fillRect(px + TILE_SIZE - 2, py, 2, TILE_SIZE);
  }
}

function drawWallDebris(
  overlayCtx: CanvasRenderingContext2D,
  castle: CastleData,
  origWalls: Set<number> | undefined,
): void {
  if (!origWalls) return;
  for (const key of origWalls) {
    if (castle.walls.has(key)) continue;
    const { r, c } = unpackTile(key);
    drawSprite(overlayCtx, "wall_debris", c * TILE_SIZE, r * TILE_SIZE);
  }
}

function drawCastleCannons(
  overlayCtx: CanvasRenderingContext2D,
  castle: CastleData,
): void {
  for (const cannon of castle.cannons) {
    const cx = cannon.col * TILE_SIZE;
    const cy = cannon.row * TILE_SIZE;
    if (!isCannonAlive(cannon)) {
      if (isRampartCannon(cannon)) {
        drawSprite(overlayCtx, "rampart_debris", cx, cy);
      } else {
        drawSprite(
          overlayCtx,
          isSuperCannon(cannon) ? "super_debris" : "cannon_debris",
          cx,
          cy,
        );
      }
      continue;
    }
    if (isRampartCannon(cannon)) {
      drawSprite(overlayCtx, "rampart", cx, cy);
      continue;
    }
    if (isBalloonCannon(cannon)) {
      drawSprite(overlayCtx, "balloon_base", cx, cy);
    } else {
      const prefix = isSuperCannon(cannon)
        ? "super"
        : cannon.mortar
          ? "mortar"
          : SPRITE_CANNON;
      const dir = facingToDir8(cannon.facing ?? 0);
      drawSprite(overlayCtx, `${prefix}_${dir}`, cx, cy);
      // Shield overlay: cyan circle outline so both owner and opponents can identify it
      if (cannon.shielded) {
        const size = isSuperCannon(cannon) ? TILE_SIZE * 3 : TILE_SIZE * 2;
        const mid = size / 2;
        overlayCtx.save();
        overlayCtx.strokeStyle = "#00ccff";
        overlayCtx.lineWidth = 2;
        overlayCtx.beginPath();
        overlayCtx.arc(cx + mid, cy + mid, mid - 2, 0, Math.PI * 2);
        overlayCtx.stroke();
        overlayCtx.restore();
      }
    }
  }
}
