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
import { facingToDir8, isCannonAlive, pxToTile, unpackTile } from "./spatial.ts";
import { CannonMode, type CastleData } from "./types.ts";

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
const sceneCanvas = document.createElement("canvas");
const sceneCtx = sceneCanvas.getContext("2d", { willReadFrequently: true })!;
const bannerSceneCanvas = document.createElement("canvas");
const bannerSceneCtx = bannerSceneCanvas.getContext("2d", { willReadFrequently: true })!;
const terrainImageCache = new WeakMap<MapData, TerrainImageCache>();

/** Cached main-canvas context — avoids per-frame getContext overhead on Chrome mobile. */
let mainCtxCache: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
let cachedBannerMap: MapData | null = null;
let cachedBannerCastles: CastleData[] | undefined;
let cachedBannerTerritory: Set<number>[] | undefined;
let cachedBannerWalls: Set<number>[] | undefined;

/** Expose the offscreen scene canvas for post-processing (loupe, etc.). */
export function getSceneCanvas(): HTMLCanvasElement { return sceneCanvas; }

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
    ctx.drawImage(sceneCanvas, viewport.x, viewport.y, viewport.w, viewport.h, 0, 0, cw, gameH);
  } else {
    ctx.drawImage(sceneCanvas, 0, 0, cw, gameH);
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
  if (sceneCanvas.width !== width || sceneCanvas.height !== height) {
    sceneCanvas.width = width;
    sceneCanvas.height = height;
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

  const INF = 1e9;
  const ORTHO_DIST = 1.0;
  const DIAG_DIST = 1.414;

  // Compute distance of water pixels to nearest grass (positive side)
  const distFromWater = new Float32Array(W * H);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const tr = pxToTile(py);
      const tc = pxToTile(px);
      distFromWater[py * W + px] = tileAt(map, tr, tc) === 1 ? INF : 0;
    }
  }
  // Forward
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const i = py * W + px;
      if (distFromWater[i] === 0) continue;
      let d = distFromWater[i]!;
      if (py > 0)
        d = Math.min(d, distFromWater[(py - 1) * W + px]! + ORTHO_DIST);
      if (px > 0)
        d = Math.min(d, distFromWater[py * W + (px - 1)]! + ORTHO_DIST);
      if (py > 0 && px > 0)
        d = Math.min(d, distFromWater[(py - 1) * W + (px - 1)]! + DIAG_DIST);
      if (py > 0 && px < W - 1)
        d = Math.min(d, distFromWater[(py - 1) * W + (px + 1)]! + DIAG_DIST);
      distFromWater[i] = d;
    }
  }
  // Backward
  for (let py = H - 1; py >= 0; py--) {
    for (let px = W - 1; px >= 0; px--) {
      const i = py * W + px;
      if (distFromWater[i] === 0) continue;
      let d = distFromWater[i]!;
      if (py < H - 1)
        d = Math.min(d, distFromWater[(py + 1) * W + px]! + ORTHO_DIST);
      if (px < W - 1)
        d = Math.min(d, distFromWater[py * W + (px + 1)]! + ORTHO_DIST);
      if (py < H - 1 && px < W - 1)
        d = Math.min(d, distFromWater[(py + 1) * W + (px + 1)]! + DIAG_DIST);
      if (py < H - 1 && px > 0)
        d = Math.min(d, distFromWater[(py + 1) * W + (px - 1)]! + DIAG_DIST);
      distFromWater[i] = d;
    }
  }

  // Compute distance of grass pixels to nearest water (negative side)
  const distFromGrass = new Float32Array(W * H);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const tr = pxToTile(py);
      const tc = pxToTile(px);
      distFromGrass[py * W + px] = tileAt(map, tr, tc) === 0 ? INF : 0;
    }
  }
  // Forward
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const i = py * W + px;
      if (distFromGrass[i] === 0) continue;
      let d = distFromGrass[i]!;
      if (py > 0)
        d = Math.min(d, distFromGrass[(py - 1) * W + px]! + ORTHO_DIST);
      if (px > 0)
        d = Math.min(d, distFromGrass[py * W + (px - 1)]! + ORTHO_DIST);
      if (py > 0 && px > 0)
        d = Math.min(d, distFromGrass[(py - 1) * W + (px - 1)]! + DIAG_DIST);
      if (py > 0 && px < W - 1)
        d = Math.min(d, distFromGrass[(py - 1) * W + (px + 1)]! + DIAG_DIST);
      distFromGrass[i] = d;
    }
  }
  // Backward
  for (let py = H - 1; py >= 0; py--) {
    for (let px = W - 1; px >= 0; px--) {
      const i = py * W + px;
      if (distFromGrass[i] === 0) continue;
      let d = distFromGrass[i]!;
      if (py < H - 1)
        d = Math.min(d, distFromGrass[(py + 1) * W + px]! + ORTHO_DIST);
      if (px < W - 1)
        d = Math.min(d, distFromGrass[py * W + (px + 1)]! + ORTHO_DIST);
      if (py < H - 1 && px < W - 1)
        d = Math.min(d, distFromGrass[(py + 1) * W + (px + 1)]! + DIAG_DIST);
      if (py < H - 1 && px > 0)
        d = Math.min(d, distFromGrass[(py + 1) * W + (px - 1)]! + DIAG_DIST);
      distFromGrass[i] = d;
    }
  }

  // Combine into signed distance field: positive in water, negative in grass
  const sdf = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    sdf[i] = distFromWater[i]! > 0 ? distFromWater[i]! : -distFromGrass[i]!;
  }

  // Blur the SDF to round corners
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

  const dist = sdf;

  // Render pixels with smooth color blending
  const imgData = octx.createImageData(W, H);
  const data = imgData.data;

  const LAND_DIST = 3;
  const BANK_DIST = 6;
  const TRANS = 1.5;

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const d = dist[py * W + px]!;
      const tr = pxToTile(py);
      const tc = pxToTile(px);
      const idx = (py * W + px) * 4;
      const isWater = tileAt(map, tr, tc) === 1;

      // Local pixel coords within the tile
      const lx = px - tc * TILE_SIZE;
      const ly = py - tr * TILE_SIZE;

      // Base grass color with blade texture baked in
      const grassBase: RGB = inBattle
        ? GRASS_BATTLE
        : (tr + tc) % 2 === 0
          ? GRASS_DARK
          : GRASS_LIGHT;
      // Textures only in battle mode; flat colors otherwise
      const grassTexOffset = inBattle ? GRASS_TEX[ly * TILE_SIZE + lx]! : 0;
      const grass: RGB =
        grassTexOffset === 0
          ? grassBase
          : [
              Math.max(0, Math.min(255, grassBase[0] + grassTexOffset)),
              Math.max(0, Math.min(255, grassBase[1] + grassTexOffset)),
              Math.max(0, Math.min(255, grassBase[2] + grassTexOffset)),
            ];

      const waterTexOffset = inBattle ? WATER_TEX[ly * TILE_SIZE + lx]! : 0;
      const water: RGB =
        waterTexOffset === 0
          ? WATER_COLOR
          : [
              Math.max(0, Math.min(255, WATER_COLOR[0] + waterTexOffset)),
              Math.max(0, Math.min(255, WATER_COLOR[1] + waterTexOffset)),
              Math.max(0, Math.min(255, WATER_COLOR[2] + waterTexOffset)),
            ];

      let color: RGB;
      if (!isWater) {
        color = grass;
      } else {
        if (d < LAND_DIST) {
          color = grass;
        } else if (d < LAND_DIST + TRANS) {
          const t = smoothClamp((d - LAND_DIST) / TRANS);
          color = lerp3(grass, BANK_COLOR, t);
        } else if (d < BANK_DIST) {
          color = BANK_COLOR;
        } else if (d < BANK_DIST + TRANS) {
          const t = smoothClamp((d - BANK_DIST) / TRANS);
          color = lerp3(BANK_COLOR, water, t);
        } else {
          color = water;
        }
      }

      data[idx] = color[0];
      data[idx + 1] = color[1];
      data[idx + 2] = color[2];
      data[idx + 3] = 255;
    }
  }

  octx.putImageData(imgData, 0, 0);
  if (inBattle) cache.battle = imgData;
  else cache.normal = imgData;
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
    const colors = getPlayerColor(castle.playerId);

    // Draw interior: checkerboard normally, cobblestone during battle
    const territory = overlay.battle?.battleTerritory?.[castle.playerId];
    if (territory) {
      const cobbleName = `cobblestone_p${castle.playerId}`;
      for (const key of territory) {
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

    // Draw walls
    const isBattle = !!overlay.battle?.battleWalls?.[castle.playerId];
    const wall: RGB = isBattle ? NEUTRAL_WALL : colors.wall;
    // Precompute bevel colors from wall RGB
    const wR = wall[0],
      wG = wall[1],
      wB = wall[2];
    const lightEdge = `rgb(${Math.min(255, wR + 35)},${Math.min(255, wG + 35)},${Math.min(255, wB + 35)})`;
    const shadowEdge = `rgb(${Math.max(0, wR - 40)},${Math.max(0, wG - 40)},${Math.max(0, wB - 40)})`;
    for (const key of castle.walls) {
      const { r, c } = unpackTile(key);
      const px = c * TILE_SIZE;
      const py = r * TILE_SIZE;
      // Base wall tile: brick texture (procedural — no baked bevels)
      octx.fillStyle = `rgb(${wR},${wG},${wB})`;
      octx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      // Mortar lines
      const mR = Math.max(0, wR - 25),
        mG = Math.max(0, wG - 25),
        mB = Math.max(0, wB - 25);
      octx.fillStyle = `rgb(${mR},${mG},${mB})`;
      octx.fillRect(px, py + 5, TILE_SIZE, 1);
      octx.fillRect(px, py + 11, TILE_SIZE, 1);
      octx.fillRect(px + 4, py, 1, 5);
      octx.fillRect(px + 10, py, 1, 5);
      octx.fillRect(px + 7, py + 6, 1, 5);
      octx.fillRect(px + 13, py + 6, 1, 5);
      octx.fillRect(px + 3, py + 12, 1, 4);
      octx.fillRect(px + 9, py + 12, 1, 4);
      // Procedural bevels only on exposed edges (no wall neighbor)
      const hasUp = castle.walls.has((r - 1) * GRID_COLS + c);
      const hasDown = castle.walls.has((r + 1) * GRID_COLS + c);
      const hasLeft = castle.walls.has(r * GRID_COLS + (c - 1));
      const hasRight = castle.walls.has(r * GRID_COLS + (c + 1));
      if (!hasUp) {
        octx.fillStyle = lightEdge;
        octx.fillRect(px, py, TILE_SIZE, 2);
      }
      if (!hasDown) {
        octx.fillStyle = shadowEdge;
        octx.fillRect(px, py + TILE_SIZE - 2, TILE_SIZE, 2);
      }
      if (!hasLeft) {
        octx.fillStyle = lightEdge;
        octx.fillRect(px, py, 2, TILE_SIZE);
      }
      if (!hasRight) {
        octx.fillStyle = shadowEdge;
        octx.fillRect(px + TILE_SIZE - 2, py, 2, TILE_SIZE);
      }
    }

    // Draw wall debris
    const origWalls = overlay.battle?.battleWalls?.[castle.playerId];
    if (origWalls) {
      for (const key of origWalls) {
        if (castle.walls.has(key)) continue;
        const { r, c } = unpackTile(key);
        drawSprite(octx, "wall_debris", c * TILE_SIZE, r * TILE_SIZE);
      }
    }

    // Draw cannons
    for (const cannon of castle.cannons) {
      const cx = cannon.col * TILE_SIZE;
      const cy = cannon.row * TILE_SIZE;
      if (!isCannonAlive(cannon)) {
        drawSprite(
          octx,
          cannon.kind === CannonMode.SUPER ? "super_debris" : "cannon_debris",
          cx,
          cy,
        );
        continue;
      }
      if (cannon.kind === CannonMode.BALLOON) {
        drawSprite(octx, "balloon_base", cx, cy);
      } else {
        const prefix = cannon.kind === CannonMode.SUPER ? "super" : "cannon";
        const dir = facingToDir8(cannon.facing ?? 0);
        drawSprite(octx, `${prefix}_${dir}`, cx, cy);
      }
    }
  }
}
