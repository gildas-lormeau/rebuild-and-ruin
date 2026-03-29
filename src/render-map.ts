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
import { BANNER_HEIGHT_RATIO, STATUSBAR_HEIGHT } from "./render-theme.ts";
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

const GRASS_DARK: RGB = [45, 140, 45];
const GRASS_LIGHT: RGB = [51, 153, 51];
const GRASS_BATTLE: RGB = [
  Math.floor(51 * 0.85),
  Math.floor(153 * 0.85),
  Math.floor(51 * 0.85),
];
const WATER_COLOR: RGB = [40, 104, 176];
const BANK_COLOR: RGB = [139, 58, 26];
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
  ctx: CanvasRenderingContext2D;
} | null = null;
let cachedBannerMap: MapData | null = null;
let cachedBannerCastles: CastleData[] | undefined;
let cachedBannerTerritory: Set<number>[] | undefined;
let cachedBannerWalls: Set<number>[] | undefined;

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
  const ctx = getMainCtx(canvas);
  const W = GRID_COLS * TILE_SIZE;
  const H = GRID_ROWS * TILE_SIZE;

  const STATUS_BAR_H = overlay?.ui?.statusBar ? STATUSBAR_HEIGHT : 0;
  const cw = CANVAS_W;
  const gameH = CANVAS_H;
  const ch = gameH + STATUS_BAR_H;
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
    ctx.imageSmoothingEnabled = false;
  }

  ensureOffscreenSize(W, H);
  const octx = sceneCtx;
  octx.clearRect(0, 0, W, H);

  // Draw the new (target) scene — layers that change between phases
  drawTerrain(octx, W, H, map, overlay);
  drawWaterAnimation(octx, map, overlay);
  drawCastles(octx, overlay);
  drawBonusSquares(octx, overlay, now);
  drawHouses(octx, overlay);
  drawTowers(octx, map, overlay, now);

  // If banner is active with old data, re-draw old scene below the banner.
  // Uses a temp canvas because putImageData in drawTerrain ignores clip regions.
  if (overlay?.ui?.banner && overlay.ui.bannerOldCastles) {
    const bannerH = Math.round(H * BANNER_HEIGHT_RATIO);
    const clipY = Math.round(overlay.ui.banner.y - bannerH / 2);
    if (clipY < H) {
      const oldCastles = overlay.ui.bannerOldCastles;
      const oldTerritory = overlay.ui.bannerOldBattleTerritory;
      const oldWalls = overlay.ui.bannerOldBattleWalls;
      const bannerCacheMiss =
        cachedBannerMap !== map ||
        cachedBannerCastles !== oldCastles ||
        cachedBannerTerritory !== oldTerritory ||
        cachedBannerWalls !== oldWalls;

      if (bannerCacheMiss) {
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
        cachedBannerMap = map;
        cachedBannerCastles = oldCastles;
        cachedBannerTerritory = oldTerritory;
        cachedBannerWalls = oldWalls;
      }

      octx.save();
      octx.beginPath();
      octx.rect(0, clipY, W, H - clipY);
      octx.clip();
      octx.drawImage(bannerSceneCanvas, 0, 0);
      octx.restore();
    }
  } else {
    clearBannerCache();
  }

  // Layers that don't change between phases — draw once on top
  drawPhantoms(octx, overlay);
  drawGrunts(octx, overlay);
  drawBattleEffects(octx, map, overlay);
  drawScoreDeltas(octx, overlay);
  drawAnnouncement(octx, W, H, overlay);
  drawBanner(octx, W, H, overlay);
  drawGameOver(octx, W, H, overlay);
  drawLifeLostDialog(octx, W, H, overlay, now);

  // Full-screen modal screens (opaque — drawn last, on top of everything)
  drawPlayerSelect(octx, W, H, overlay, now);
  drawOptionsScreen(octx, W, H, overlay, now);
  drawControlsScreen(octx, W, H, overlay, now);

  // Scale up to display canvas (with optional zoom viewport)
  ctx.imageSmoothingEnabled = false;
  if (viewport) {
    ctx.drawImage(
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
    ctx.drawImage(offscreenScene, 0, 0, cw, gameH);
  }

  // Status bar drawn at display resolution below the game scene
  if (STATUS_BAR_H > 0) {
    drawStatusBar(ctx, cw, ch, overlay);
  }
}

for (const [lx, ly] of BLADE_DARK) GRASS_TEX[ly * TILE_SIZE + lx] = -12;

for (const [lx, ly] of BLADE_LIGHT) GRASS_TEX[ly * TILE_SIZE + lx] = 10;

for (const w of WAVE_HI) {
  for (let i = 0; i < w.w; i++) WATER_TEX[w.y * TILE_SIZE + w.x + i] = 15;
}

for (const w of WAVE_LO) {
  for (let i = 0; i < w.w; i++) WATER_TEX[w.y * TILE_SIZE + w.x + i] = -10;
}

function getMainCtx(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  if (mainCtxCache?.canvas === canvas) return mainCtxCache.ctx;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  mainCtxCache = { canvas, ctx };
  return ctx;
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

function clearBannerCache(): void {
  cachedBannerMap = null;
  cachedBannerCastles = undefined;
  cachedBannerTerritory = undefined;
  cachedBannerWalls = undefined;
}

/** Build SDF for water/grass boundaries, blur it, and paint terrain pixels. */
function drawTerrain(
  octx: CanvasRenderingContext2D,
  W: number,
  H: number,
  map: MapData,
  overlay?: RenderOverlay,
): void {
  const inBattle = overlay?.battle?.battleTerritory !== undefined;
  const cache = getTerrainCache(map, W, H);
  const cachedImage = inBattle ? cache.battle : cache.normal;
  if (cachedImage) {
    octx.putImageData(cachedImage, 0, 0);
    return;
  }

  const sdf = computeSignedDistanceField(W, H, map);
  blurSignedDistanceField(sdf, W, H);

  const imgData = octx.createImageData(W, H);
  renderTerrainPixels(imgData, sdf, W, H, map, inBattle);

  octx.putImageData(imgData, 0, 0);
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
  const ORTHO = 1.0;
  const DIAG = 1.414;
  // Forward pass
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const i = py * W + px;
      if (dist[i] === 0) continue;
      let d = dist[i]!;
      if (py > 0) d = Math.min(d, dist[(py - 1) * W + px]! + ORTHO);
      if (px > 0) d = Math.min(d, dist[py * W + (px - 1)]! + ORTHO);
      if (py > 0 && px > 0)
        d = Math.min(d, dist[(py - 1) * W + (px - 1)]! + DIAG);
      if (py > 0 && px < W - 1)
        d = Math.min(d, dist[(py - 1) * W + (px + 1)]! + DIAG);
      dist[i] = d;
    }
  }
  // Backward pass
  for (let py = H - 1; py >= 0; py--) {
    for (let px = W - 1; px >= 0; px--) {
      const i = py * W + px;
      if (dist[i] === 0) continue;
      let d = dist[i]!;
      if (py < H - 1) d = Math.min(d, dist[(py + 1) * W + px]! + ORTHO);
      if (px < W - 1) d = Math.min(d, dist[py * W + (px + 1)]! + ORTHO);
      if (py < H - 1 && px < W - 1)
        d = Math.min(d, dist[(py + 1) * W + (px + 1)]! + DIAG);
      if (py < H - 1 && px > 0)
        d = Math.min(d, dist[(py + 1) * W + (px - 1)]! + DIAG);
      dist[i] = d;
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

/** Use SDF to paint grass/bank/water pixels into an ImageData buffer. */
function renderTerrainPixels(
  imgData: ImageData,
  sdf: Float32Array,
  W: number,
  H: number,
  map: MapData,
  inBattle: boolean,
): void {
  const data = imgData.data;
  const LAND_DIST = 3;
  const BANK_DIST = 6;
  const TRANS = 1.5;

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const d = sdf[py * W + px]!;
      const tr = pxToTile(py);
      const tc = pxToTile(px);
      const lx = px - tc * TILE_SIZE;
      const ly = py - tr * TILE_SIZE;

      const grass = texturedColor(
        GRASS_TEX,
        grassBaseColor(tr, tc, inBattle),
        inBattle,
        lx,
        ly,
      );
      const water = texturedColor(WATER_TEX, WATER_COLOR, inBattle, lx, ly);
      const color = selectTerrainColor(
        tileAt(map, tr, tc) === 1,
        d,
        grass,
        water,
        LAND_DIST,
        BANK_DIST,
        TRANS,
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
  d: number,
  grass: RGB,
  water: RGB,
  landDist: number,
  bankDist: number,
  trans: number,
): RGB {
  if (!isWater) return grass;
  if (d < landDist) return grass;
  if (d < landDist + trans)
    return lerp3(grass, BANK_COLOR, smoothClamp((d - landDist) / trans));
  if (d < bankDist) return BANK_COLOR;
  if (d < bankDist + trans)
    return lerp3(BANK_COLOR, water, smoothClamp((d - bankDist) / trans));
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

function smoothClamp(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

function lerp3(a: RGB, b: RGB, t: number): RGB {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/** Draw castle walls, interiors, wall debris, and cannons for all players. */
function drawCastles(
  octx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.castles) return;
  for (const castle of overlay.castles) {
    const battleTerritory = overlay.battle?.battleTerritory?.[castle.playerId];
    const battleWalls = overlay.battle?.battleWalls?.[castle.playerId];
    drawCastleInterior(octx, castle, battleTerritory);
    drawCastleWalls(octx, castle, battleWalls);
    drawWallDebris(octx, castle, battleWalls);
    drawCastleCannons(octx, castle);
  }
}

function drawCastleInterior(
  octx: CanvasRenderingContext2D,
  castle: CastleData,
  battleTerritory: Set<number> | undefined,
): void {
  if (battleTerritory) {
    const cobbleName = `cobblestone_p${castle.playerId}`;
    for (const key of battleTerritory) {
      const { r, c } = unpackTile(key);
      drawSprite(octx, cobbleName, c * TILE_SIZE, r * TILE_SIZE);
    }
  } else {
    for (const key of castle.interior) {
      const { r, c } = unpackTile(key);
      const isLight = (r + c) % 2 === 0;
      drawSprite(
        octx,
        `interior_${isLight ? "light" : "dark"}_p${castle.playerId}`,
        c * TILE_SIZE,
        r * TILE_SIZE,
      );
    }
  }
}

function drawCastleWalls(
  octx: CanvasRenderingContext2D,
  castle: CastleData,
  battleWalls: Set<number> | undefined,
): void {
  const colors = getPlayerColor(castle.playerId);
  const wall: RGB = battleWalls ? NEUTRAL_WALL : colors.wall;
  const [wR, wG, wB] = wall;
  const lightEdge = `rgb(${Math.min(255, wR + 35)},${Math.min(255, wG + 35)},${Math.min(255, wB + 35)})`;
  const shadowEdge = `rgb(${Math.max(0, wR - 40)},${Math.max(0, wG - 40)},${Math.max(0, wB - 40)})`;
  const mortarStyle = `rgb(${Math.max(0, wR - 25)},${Math.max(0, wG - 25)},${Math.max(0, wB - 25)})`;
  const wallStyle = `rgb(${wR},${wG},${wB})`;

  for (const key of castle.walls) {
    const { r, c } = unpackTile(key);
    const px = c * TILE_SIZE;
    const py = r * TILE_SIZE;
    // Base wall fill
    octx.fillStyle = wallStyle;
    octx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
    // Mortar lines — 3-row staggered brick pattern
    octx.fillStyle = mortarStyle;
    octx.fillRect(px, py + 5, TILE_SIZE, 1);
    octx.fillRect(px, py + 11, TILE_SIZE, 1);
    octx.fillRect(px + 4, py, 1, 5);
    octx.fillRect(px + 10, py, 1, 5);
    octx.fillRect(px + 7, py + 6, 1, 5);
    octx.fillRect(px + 13, py + 6, 1, 5);
    octx.fillRect(px + 3, py + 12, 1, 4);
    octx.fillRect(px + 9, py + 12, 1, 4);
    // Bevels on exposed edges only
    drawWallBevels(octx, castle.walls, r, c, px, py, lightEdge, shadowEdge);
  }
}

/** Draw 2px bevels on wall edges that have no neighbor. */
function drawWallBevels(
  octx: CanvasRenderingContext2D,
  walls: Set<number>,
  r: number,
  c: number,
  px: number,
  py: number,
  lightEdge: string,
  shadowEdge: string,
): void {
  if (!walls.has((r - 1) * GRID_COLS + c)) {
    octx.fillStyle = lightEdge;
    octx.fillRect(px, py, TILE_SIZE, 2);
  }
  if (!walls.has((r + 1) * GRID_COLS + c)) {
    octx.fillStyle = shadowEdge;
    octx.fillRect(px, py + TILE_SIZE - 2, TILE_SIZE, 2);
  }
  if (!walls.has(r * GRID_COLS + (c - 1))) {
    octx.fillStyle = lightEdge;
    octx.fillRect(px, py, 2, TILE_SIZE);
  }
  if (!walls.has(r * GRID_COLS + (c + 1))) {
    octx.fillStyle = shadowEdge;
    octx.fillRect(px + TILE_SIZE - 2, py, 2, TILE_SIZE);
  }
}

function drawWallDebris(
  octx: CanvasRenderingContext2D,
  castle: CastleData,
  origWalls: Set<number> | undefined,
): void {
  if (!origWalls) return;
  for (const key of origWalls) {
    if (castle.walls.has(key)) continue;
    const { r, c } = unpackTile(key);
    drawSprite(octx, "wall_debris", c * TILE_SIZE, r * TILE_SIZE);
  }
}

function drawCastleCannons(
  octx: CanvasRenderingContext2D,
  castle: CastleData,
): void {
  for (const cannon of castle.cannons) {
    const cx = cannon.col * TILE_SIZE;
    const cy = cannon.row * TILE_SIZE;
    if (!isCannonAlive(cannon)) {
      drawSprite(
        octx,
        isSuperCannon(cannon) ? "super_debris" : "cannon_debris",
        cx,
        cy,
      );
      continue;
    }
    if (isBalloonCannon(cannon)) {
      drawSprite(octx, "balloon_base", cx, cy);
    } else {
      const prefix = isSuperCannon(cannon) ? "super" : "cannon";
      const dir = facingToDir8(cannon.facing ?? 0);
      drawSprite(octx, `${prefix}_${dir}`, cx, cy);
    }
  }
}
