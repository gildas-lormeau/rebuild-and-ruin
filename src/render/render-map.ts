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

import type { GameMap, Viewport } from "../shared/geometry-types.ts";
import {
  CANVAS_H,
  CANVAS_W,
  GRID_COLS,
  GRID_ROWS,
  MAP_PX_H,
  MAP_PX_W,
  SCALE,
  TILE_SIZE,
} from "../shared/grid.ts";
import type { CastleData, RenderOverlay } from "../shared/overlay-types.ts";
import { getPlayerColor } from "../shared/player-config.ts";
import {
  facingToDir8,
  isBalloonCannon,
  isCannonAlive,
  isRampartCannon,
  isSuperCannon,
  packTile,
  pxToTile,
  unpackTile,
} from "../shared/spatial.ts";
import {
  BANNER_HEIGHT_RATIO,
  type RGB,
  rgb,
  STATUSBAR_HEIGHT,
} from "../shared/theme.ts";
import {
  drawBattleEffects,
  drawBonusSquares,
  drawBurningPits,
  drawFrozenTiles,
  drawGrunts,
  drawHouses,
  drawPhantoms,
  drawSinkholeTiles,
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
}

type BannerCacheEntry = {
  map: GameMap;
  castles: readonly CastleData[];
  territory: Set<number>[] | undefined;
  walls: Set<number>[] | undefined;
};

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
/** WeakMap so terrain caches auto-cleanup when a GameMap is GC'd (e.g., lobby map change).
 *  Banner cache below uses module-level variables + manual clearBannerCache() instead,
 *  because the banner scene combines data from multiple sources (castles, territory, walls)
 *  that aren't keyed by a single object. */
const terrainImageCache = new WeakMap<GameMap, TerrainImageCache>();
const SPRITE_CANNON = "cannon";

/** Cached main-canvas context — avoids per-frame getContext overhead on Chrome mobile. */
let mainCtxCache:
  | {
      canvas: HTMLCanvasElement;
      canvasCtx: CanvasRenderingContext2D;
    }
  | undefined;
let bannerCache: BannerCacheEntry | undefined;

/** Expose the offscreen scene canvas for post-processing (loupe, etc.). */
export function sceneCanvas(): HTMLCanvasElement {
  return offscreenScene;
}

export function drawMap(
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
  const overlayCtx = sceneCtx;
  overlayCtx.clearRect(0, 0, W, H);

  // Render layers (order is load-bearing — later layers draw on top):
  //
  // Scene layers (drawn into offscreen canvas, affected by zoom viewport):
  //   1. Terrain base         — grass/water/bank pixels (cached ImageData)
  //   2. Water animation      — wave shimmer (battle only)
  //   3. Frozen tiles         — ice overlay on frozen river
  //   4. Castles              — wall tiles per player
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
  drawTerrain(overlayCtx, W, H, map, overlay);
  drawWaterAnimation(overlayCtx, map, overlay, now);
  drawSinkholeTiles(overlayCtx, overlay, now);
  drawFrozenTiles(overlayCtx, overlay, now);
  drawCastles(overlayCtx, overlay);
  drawBonusSquares(overlayCtx, overlay, now);
  drawHouses(overlayCtx, overlay);
  drawTowers(overlayCtx, map, overlay, now);
  drawBurningPits(overlayCtx, overlay, now);
  drawGrunts(overlayCtx, overlay);

  // If banner is active with old data, composite the old scene below the banner.
  drawBannerPrevScene(overlayCtx, W, H, map, overlay, now);

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

/** Pre-compute both terrain variants (normal + battle) so the first
 *  render of each doesn't stall the frame. Call during game init. */
export function precomputeTerrainCache(map: GameMap): void {
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
 *  When a banner has preservePrevScene=true, showBannerTransition captures pre-transition
 *  state (castles, territory, walls, houses, bonus squares). This function reconstructs
 *  a full RenderOverlay from that snapshot, suppressing phase-specific elements (phantoms,
 *  battle effects, crosshairs) so the old scene looks clean beneath the banner.
 *
 *  The result is cached (keyed on map + old-scene references) and composited below the
 *  banner via a clip rect. Cache is invalidated when any of the four cached references change.
 *  All four cached values must be updated atomically on a cache miss. */
function drawBannerPrevScene(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  H: number,
  map: GameMap,
  overlay: RenderOverlay | undefined,
  now: number,
): void {
  if (!overlay?.ui?.banner || !overlay.ui.bannerPrevCastles) {
    clearBannerCache();
    return;
  }

  const bannerH = Math.round(H * BANNER_HEIGHT_RATIO);
  const clipY = Math.round(overlay.ui.banner.y - bannerH / 2);
  if (clipY >= H) return;

  const prevCastles = overlay.ui.bannerPrevCastles;
  const prevTerritory = overlay.ui.bannerPrevBattleTerritory;
  const prevWalls = overlay.ui.bannerPrevBattleWalls;
  const needsBannerRender = !isBannerCacheValid(
    map,
    prevCastles,
    prevTerritory,
    prevWalls,
  );

  if (needsBannerRender) {
    const prevOverlay: RenderOverlay = {
      ...overlay,
      // Suppress selection highlights — they belong to the new phase
      selection: { highlighted: null, selected: null },
      castles: prevCastles,
      entities: overlay.ui.bannerPrevEntities
        ? {
            ...overlay.ui.bannerPrevEntities,
            homeTowers: overlay.entities?.homeTowers,
          }
        : overlay.entities,
      battle: {
        ...overlay.battle,
        inBattle: !!prevTerritory,
        battleTerritory: prevTerritory,
        battleWalls: prevWalls,
        cannonballs: undefined,
        crosshairs: undefined,
        impacts: undefined,
      },
      ui: {
        ...overlay.ui,
        banner: undefined,
        announcement: undefined,
        bannerPrevCastles: undefined,
      },
      // Suppress phase-specific phantoms in old scene
      phantoms: {
        piecePhantoms: undefined,
        cannonPhantoms: undefined,
      },
    };
    const tmpCtx = bannerSceneCtx;
    tmpCtx.clearRect(0, 0, W, H);
    drawTerrain(tmpCtx, W, H, map, prevOverlay);
    drawWaterAnimation(tmpCtx, map, prevOverlay, now);
    drawFrozenTiles(tmpCtx, prevOverlay, now);
    drawSinkholeTiles(tmpCtx, prevOverlay, now);
    drawCastles(tmpCtx, prevOverlay);
    drawBonusSquares(tmpCtx, prevOverlay, now);
    drawHouses(tmpCtx, prevOverlay);
    drawTowers(tmpCtx, map, prevOverlay, now);
    drawBurningPits(tmpCtx, prevOverlay, now);
    drawGrunts(tmpCtx, prevOverlay);
    bannerCache = {
      map,
      castles: prevCastles,
      territory: prevTerritory,
      walls: prevWalls,
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
  bannerCache = undefined;
}

/** Check if the banner scene cache is still valid (reference-equality on all fields).
 *  Type-safe: BannerCacheEntry keys drive the comparison — adding a field to the type
 *  without updating this function causes a compile error via the `key in` iteration. */
function isBannerCacheValid(
  map: GameMap,
  castles: readonly CastleData[],
  territory: Set<number>[] | undefined,
  walls: Set<number>[] | undefined,
): boolean {
  if (!bannerCache) return false;
  const candidate: BannerCacheEntry = { map, castles, territory, walls };
  for (const key of Object.keys(candidate) as (keyof BannerCacheEntry)[]) {
    if (bannerCache[key] !== candidate[key]) return false;
  }
  return true;
}

/** Build SDF for water/grass boundaries, blur it, and paint terrain pixels. */
function drawTerrain(
  overlayCtx: CanvasRenderingContext2D,
  W: number,
  H: number,
  map: GameMap,
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
  map: GameMap,
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

function tileAt(map: GameMap, r: number, c: number): number {
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
        // Dead rampart: dark cracked block spanning 2×2
        overlayCtx.fillStyle = "#3a3a3a";
        overlayCtx.fillRect(
          cx + 2,
          cy + 2,
          TILE_SIZE * 2 - 4,
          TILE_SIZE * 2 - 4,
        );
        overlayCtx.strokeStyle = "#222";
        overlayCtx.lineWidth = 1;
        overlayCtx.strokeRect(
          cx + 2,
          cy + 2,
          TILE_SIZE * 2 - 4,
          TILE_SIZE * 2 - 4,
        );
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
      // Rampart base: solid stone block, no barrel
      overlayCtx.fillStyle = "#556677";
      overlayCtx.fillRect(cx + 2, cy + 2, TILE_SIZE * 2 - 4, TILE_SIZE * 2 - 4);
      overlayCtx.strokeStyle = "#334455";
      overlayCtx.lineWidth = 2;
      overlayCtx.strokeRect(
        cx + 2,
        cy + 2,
        TILE_SIZE * 2 - 4,
        TILE_SIZE * 2 - 4,
      );
      // Shield HP overlay: green circle when shieldHp > 0
      if ((cannon.shieldHp ?? 0) > 0) {
        const size = TILE_SIZE * 2;
        const mid = size / 2;
        overlayCtx.strokeStyle = "#33cc33";
        overlayCtx.lineWidth = 2;
        overlayCtx.beginPath();
        overlayCtx.arc(cx + mid, cy + mid, mid - 2, 0, Math.PI * 2);
        overlayCtx.stroke();
      }
      continue;
    }
    if (isBalloonCannon(cannon)) {
      drawSprite(overlayCtx, "balloon_base", cx, cy);
    } else {
      const prefix = isSuperCannon(cannon) ? "super" : SPRITE_CANNON;
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
      // Mortar overlay: orange diamond outline so both owner and opponents can identify it
      if (cannon.mortar) {
        const size = isSuperCannon(cannon) ? TILE_SIZE * 3 : TILE_SIZE * 2;
        const mid = size / 2;
        overlayCtx.save();
        overlayCtx.strokeStyle = "#ff6600";
        overlayCtx.lineWidth = 2;
        overlayCtx.beginPath();
        overlayCtx.moveTo(cx + mid, cy + 1);
        overlayCtx.lineTo(cx + size - 1, cy + mid);
        overlayCtx.lineTo(cx + mid, cy + size - 1);
        overlayCtx.lineTo(cx + 1, cy + mid);
        overlayCtx.closePath();
        overlayCtx.stroke();
        overlayCtx.restore();
      }
    }
  }
}
