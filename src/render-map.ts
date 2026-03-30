/**
 * Map Renderer — browser-side ES module for rendering game maps on a canvas.
 */

import type { RGB } from "./geometry-types.ts";
import { CANVAS_H, CANVAS_W, GRID_COLS, GRID_ROWS, TILE_SIZE } from "./grid.ts";
import { getPlayerColor } from "./player-config.ts";
import {
  drawBattleEffects,
  drawBonusSquares,
  drawGrunts,
  drawHouses,
  drawPhantoms,
  drawWaterAnimation,
} from "./render-effects.ts";
import { drawSprite } from "./render-sprites.ts";
import { BANNER_HEIGHT_RATIO, rgb, STATUSBAR_HEIGHT } from "./render-theme.ts";
import { drawTowers } from "./render-towers.ts";
import type { MapData, RenderOverlay, Viewport } from "./render-types.ts";
import {
  drawAnnouncement,
  drawBanner,
  drawControlsScreen,
  drawGameOver,
  drawLifeLostDialog,
  drawOptionsScreen,
  drawPlayerSelect,
  drawScoreDeltas,
  drawStatusBar,
} from "./render-ui.ts";
import {
  facingToDir8,
  isBalloonCannon,
  isCannonAlive,
  isSuperCannon,
  pxToTile,
  unpackTile,
} from "./spatial.ts";
import type { CastleData } from "./types.ts";

interface TerrainImageCache {
  width: number;
  height: number;
  normal?: ImageData;
  battle?: ImageData;
}

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
const BANK_COLOR: RGB = [139, 58, 26];
// river bank / shoreline
// Neutral stone color used for all walls during battle phase
const NEUTRAL_WALL: RGB = [140, 130, 120];
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
const offscreenScene = document.createElement("canvas");
const sceneCtx = offscreenScene.getContext("2d", { willReadFrequently: true })!;
const bannerSceneCanvas = document.createElement("canvas");
const bannerSceneCtx = bannerSceneCanvas.getContext("2d", {
  willReadFrequently: true,
})!;
/** WeakMap so terrain caches auto-cleanup when a MapData is GC'd (e.g., lobby map change).
 *  Banner cache below uses module-level variables + manual clearBannerCache() instead,
 *  because the banner scene combines data from multiple sources (castles, territory, walls)
 *  that aren't keyed by a single object. */
const terrainImageCache = new WeakMap<MapData, TerrainImageCache>();

/** Cached main-canvas context — avoids per-frame getContext overhead on Chrome mobile. */
let mainCtxCache: {
  canvas: HTMLCanvasElement;
  canvasCtx: CanvasRenderingContext2D;
} | null = null;
let bannerCache: {
  map: MapData;
  castles: CastleData[];
  territory: Set<number>[] | undefined;
  walls: Set<number>[] | undefined;
} | null = null;

/** Expose the offscreen scene canvas for post-processing (loupe, etc.). */
export function sceneCanvas(): HTMLCanvasElement {
  return offscreenScene;
}

export function drawMap(
  map: MapData,
  canvas: HTMLCanvasElement,
  overlay?: RenderOverlay,
  viewport?: Viewport | null,
): void {
  const now = Date.now();
  const canvasCtx = getMainCtx(canvas);
  const W = GRID_COLS * TILE_SIZE;
  const H = GRID_ROWS * TILE_SIZE;

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
  const overlayCtx = sceneCtx;
  overlayCtx.clearRect(0, 0, W, H);

  // Draw the new (target) scene — layers that change between phases
  drawTerrain(overlayCtx, W, H, map, overlay);
  drawWaterAnimation(overlayCtx, map, overlay);
  drawCastles(overlayCtx, overlay);
  drawBonusSquares(overlayCtx, overlay, now);
  drawHouses(overlayCtx, overlay);
  drawTowers(overlayCtx, map, overlay, now);

  // If banner is active with old data, composite the old scene below the banner.
  drawBannerOldScene(overlayCtx, W, H, map, overlay, now);

  // Layers that don't change between phases — draw once on top
  drawPhantoms(overlayCtx, overlay);
  drawGrunts(overlayCtx, overlay);
  drawBattleEffects(overlayCtx, map, overlay);
  drawScoreDeltas(overlayCtx, overlay);
  drawAnnouncement(overlayCtx, W, H, overlay);
  drawBanner(overlayCtx, W, H, overlay);
  drawGameOver(overlayCtx, W, H, overlay);
  drawLifeLostDialog(overlayCtx, W, H, overlay, now);

  // Full-screen modal screens (opaque — drawn last, on top of everything)
  drawPlayerSelect(overlayCtx, W, H, overlay, now);
  drawOptionsScreen(overlayCtx, W, H, overlay, now);
  drawControlsScreen(overlayCtx, W, H, overlay, now);

  // Scale up to display canvas (with optional zoom viewport)
  canvasCtx.imageSmoothingEnabled = false;
  if (viewport) {
    canvasCtx.drawImage(
      offscreenScene,
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
    canvasCtx.drawImage(offscreenScene, 0, 0, cw, gameH);
  }

  // Status bar drawn at display resolution below the game scene
  if (STATUS_BAR_H > 0) {
    drawStatusBar(canvasCtx, cw, ch, overlay);
  }
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

function getMainCtx(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  if (mainCtxCache?.canvas === canvas) return mainCtxCache.canvasCtx;
  const canvasCtx = canvas.getContext("2d", { alpha: false })!;
  mainCtxCache = { canvas, canvasCtx };
  return canvasCtx;
}

function ensureOffscreenSize(width: number, height: number): void {
  if (offscreenScene.width !== width || offscreenScene.height !== height) {
    offscreenScene.width = width;
    offscreenScene.height = height;
  }
  if (
    bannerSceneCanvas.width !== width ||
    bannerSceneCanvas.height !== height
  ) {
    bannerSceneCanvas.width = width;
    bannerSceneCanvas.height = height;
    clearBannerCache();
  }
}

/** Re-draw the pre-transition scene below the banner divider line.
 *  Uses a temp canvas because putImageData in drawTerrain ignores clip regions.
 *  The old scene is cached (by reference identity) to avoid re-rendering each frame. */
/** Render the "old scene" behind the phase-transition banner.
 *
 *  When a banner has preserveOldScene=true, showBannerTransition captures pre-transition
 *  state (castles, territory, walls, houses, bonus squares). This function reconstructs
 *  a full RenderOverlay from that snapshot, suppressing phase-specific elements (phantoms,
 *  battle effects, crosshairs) so the old scene looks clean beneath the banner.
 *
 *  The result is cached (keyed on map + old-scene references) and composited below the
 *  banner via a clip rect. Cache is invalidated when any of the four cached references change.
 *  All four cached values must be updated atomically on a cache miss. */
function drawBannerOldScene(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  H: number,
  map: MapData,
  overlay: RenderOverlay | undefined,
  now: number,
): void {
  if (!overlay?.ui?.banner || !overlay.ui.bannerOldCastles) {
    clearBannerCache();
    return;
  }

  const bannerH = Math.round(H * BANNER_HEIGHT_RATIO);
  const clipY = Math.round(overlay.ui.banner.y - bannerH / 2);
  if (clipY >= H) return;

  const oldCastles = overlay.ui.bannerOldCastles;
  const oldTerritory = overlay.ui.bannerOldBattleTerritory;
  const oldWalls = overlay.ui.bannerOldBattleWalls;
  const needsBannerRender = !isBannerCacheValid(
    map,
    oldCastles,
    oldTerritory,
    oldWalls,
  );

  if (needsBannerRender) {
    const oldHouses = overlay.ui.bannerOldHouses;
    const oldBonusSquares = overlay.ui.bannerOldBonusSquares;
    const oldOverlay: RenderOverlay = {
      ...overlay,
      castles: oldCastles,
      entities: {
        ...overlay.entities,
        houses: oldHouses ?? overlay.entities?.houses,
        bonusSquares: oldBonusSquares ?? overlay.entities?.bonusSquares,
      },
      battle: {
        ...overlay.battle,
        inBattle: !!oldTerritory,
        battleTerritory: oldTerritory,
        battleWalls: oldWalls,
        cannonballs: undefined,
        crosshairs: undefined,
        impacts: undefined,
      },
      ui: {
        ...overlay.ui,
        banner: undefined,
        announcement: undefined,
        bannerOldCastles: undefined,
      },
      // Suppress phase-specific phantoms in old scene
      phantoms: {
        phantomPiece: null,
        humanPhantoms: undefined,
        aiPhantoms: undefined,
        aiCannonPhantoms: undefined,
      },
    };
    const tmpCtx = bannerSceneCtx;
    tmpCtx.clearRect(0, 0, W, H);
    drawTerrain(tmpCtx, W, H, map, oldOverlay);
    drawCastles(tmpCtx, oldOverlay);
    drawBonusSquares(tmpCtx, oldOverlay, now);
    drawHouses(tmpCtx, oldOverlay);
    drawTowers(tmpCtx, map, oldOverlay, now);
    bannerCache = {
      map,
      castles: oldCastles,
      territory: oldTerritory,
      walls: oldWalls,
    };
  }

  overlayCtx.save();
  overlayCtx.beginPath();
  overlayCtx.rect(0, clipY, W, H - clipY);
  overlayCtx.clip();
  overlayCtx.drawImage(bannerSceneCanvas, 0, 0);
  overlayCtx.restore();
}

function clearBannerCache(): void {
  bannerCache = null;
}

/** Check if the banner scene cache is still valid (all 4 reference-equality checks).
 *  When adding a new cached field, update both this function and the bannerCache assignment. */
function isBannerCacheValid(
  map: MapData,
  castles: readonly CastleData[],
  territory: Set<number>[] | undefined,
  walls: Set<number>[] | undefined,
): boolean {
  return (
    bannerCache !== null &&
    bannerCache.map === map &&
    bannerCache.castles === castles &&
    bannerCache.territory === territory &&
    bannerCache.walls === walls
  );
}

/** Build SDF for water/grass boundaries, blur it, and paint terrain pixels. */
function drawTerrain(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  H: number,
  map: MapData,
  overlay?: RenderOverlay,
): void {
  const inBattle = !!overlay?.battle?.inBattle;
  const cache = getTerrainCache(map, W, H);
  const cachedImage = inBattle ? cache.battle : cache.normal;
  if (cachedImage) {
    overlayCtx.putImageData(cachedImage, 0, 0);
    return;
  }

  const sdf = computeSignedDistanceField(W, H, map);
  blurSignedDistanceField(sdf, W, H);

  const imgData = overlayCtx.createImageData(W, H);
  renderTerrainPixels(imgData, sdf, W, H, map, inBattle);

  overlayCtx.putImageData(imgData, 0, 0);
  if (inBattle) cache.battle = imgData;
  else cache.normal = imgData;
}

/** Forward + backward SDF passes for water/grass boundary distances. */
function computeSignedDistanceField(
  W: number,
  H: number,
  map: MapData,
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
  map: MapData,
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
  const BLUR_R = 5;
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
  map: MapData,
  inBattle: boolean,
): void {
  const data = imgData.data;
  // Water/grass terrain transition thresholds (in blurred SDF units, ~1 unit ≈ 1 pixel distance).
  // GRASS_TO_BANK_DIST: start bank texture blend at this distance from water edge
  // BANK_TO_WATER_DIST: complete transition to water texture at this distance
  // TRANSITION_WIDTH: smoothstep blend width (larger = softer edge)
  const GRASS_TO_BANK_DIST = 3;
  const BANK_TO_WATER_DIST = 6;
  const TRANSITION_WIDTH = 1.5;

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
      const water = texturedColor(WATER_TEX, WATER_COLOR, inBattle, lx, ly);

      // Blend grass → bank → water based on SDF distance
      const color = selectTerrainColor(
        tileAt(map, tr, tc) === 1,
        distance,
        grass,
        water,
        GRASS_TO_BANK_DIST,
        BANK_TO_WATER_DIST,
        TRANSITION_WIDTH,
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
  grassToBankDist: number,
  bankToWaterDist: number,
  transitionWidth: number,
): RGB {
  if (!isWater) return grass;
  if (distance < grassToBankDist) return grass;
  if (distance < grassToBankDist + transitionWidth)
    return lerp3(
      grass,
      BANK_COLOR,
      smoothClamp((distance - grassToBankDist) / transitionWidth),
    );
  if (distance < bankToWaterDist) return BANK_COLOR;
  if (distance < bankToWaterDist + transitionWidth)
    return lerp3(
      BANK_COLOR,
      water,
      smoothClamp((distance - bankToWaterDist) / transitionWidth),
    );
  return water;
}

function getTerrainCache(
  map: MapData,
  width: number,
  height: number,
): TerrainImageCache {
  const existing = terrainImageCache.get(map);
  if (existing && existing.width === width && existing.height === height) {
    return existing;
  }
  const next: TerrainImageCache = { width, height };
  terrainImageCache.set(map, next);
  return next;
}

function tileAt(map: MapData, r: number, c: number): number {
  if (r < 0 || r >= GRID_ROWS || c < 0 || c >= GRID_COLS) return -1;
  return map.tiles[r]![c]!;
}

function smoothClamp(interpolationFactor: number): number {
  const c = Math.max(0, Math.min(1, interpolationFactor));
  return c * c * (3 - 2 * c);
}

function lerp3(a: RGB, b: RGB, interpolationFactor: number): RGB {
  return [
    a[0] + (b[0] - a[0]) * interpolationFactor,
    a[1] + (b[1] - a[1]) * interpolationFactor,
    a[2] + (b[2] - a[2]) * interpolationFactor,
  ];
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
  const [wR, wG, wB] = wall;
  const lightEdge = rgb([
    Math.min(255, wR + 35),
    Math.min(255, wG + 35),
    Math.min(255, wB + 35),
  ]);
  const shadowEdge = rgb([
    Math.max(0, wR - 40),
    Math.max(0, wG - 40),
    Math.max(0, wB - 40),
  ]);
  const mortarStyle = rgb([
    Math.max(0, wR - 25),
    Math.max(0, wG - 25),
    Math.max(0, wB - 25),
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
  }
}

/** Draw 2px bevels on wall edges that have no neighbor. */
function drawWallBevels(
  overlayCtx: CanvasRenderingContext2D,
  walls: Set<number>,
  r: number,
  c: number,
  px: number,
  py: number,
  lightEdge: string,
  shadowEdge: string,
): void {
  if (!walls.has((r - 1) * GRID_COLS + c)) {
    overlayCtx.fillStyle = lightEdge;
    overlayCtx.fillRect(px, py, TILE_SIZE, 2);
  }
  if (!walls.has((r + 1) * GRID_COLS + c)) {
    overlayCtx.fillStyle = shadowEdge;
    overlayCtx.fillRect(px, py + TILE_SIZE - 2, TILE_SIZE, 2);
  }
  if (!walls.has(r * GRID_COLS + (c - 1))) {
    overlayCtx.fillStyle = lightEdge;
    overlayCtx.fillRect(px, py, 2, TILE_SIZE);
  }
  if (!walls.has(r * GRID_COLS + (c + 1))) {
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
      drawSprite(
        overlayCtx,
        isSuperCannon(cannon) ? "super_debris" : "cannon_debris",
        cx,
        cy,
      );
      continue;
    }
    if (isBalloonCannon(cannon)) {
      drawSprite(overlayCtx, "balloon_base", cx, cy);
    } else {
      const prefix = isSuperCannon(cannon) ? "super" : "cannon";
      const dir = facingToDir8(cannon.facing ?? 0);
      drawSprite(overlayCtx, `${prefix}_${dir}`, cx, cy);
    }
  }
}
