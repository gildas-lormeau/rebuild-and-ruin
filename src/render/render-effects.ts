import {
  type CannonMode,
  isBalloonMode,
  isRampartMode,
  isSuperMode,
  THAW_DURATION,
} from "../shared/core/battle-types.ts";
import { IMPACT_FLASH_DURATION } from "../shared/core/game-constants.ts";
import type { GameMap } from "../shared/core/geometry-types.ts";
import { TILE_SIZE } from "../shared/core/grid.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import {
  facingToCardinal,
  isWater,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { RenderOverlay } from "../shared/ui/overlay-types.ts";
import { getPlayerColor } from "../shared/ui/player-config.ts";
import {
  BONUS_FLASH_MS,
  drawShadowText,
  FONT_TIMER,
  type RGB,
  rgb,
  SHADOW_COLOR,
  TEXT_ALIGN_CENTER,
  TEXT_BASELINE_MIDDLE,
  TEXT_WHITE,
} from "../shared/ui/theme.ts";
import { drawSprite } from "./render-sprites.ts";

// Crosshair animation constants
const CROSSHAIR_READY_CYCLE_MS = 16;
const CROSSHAIR_IDLE_CYCLE_MS = 4;
const CROSSHAIR_ARM_READY = 14;
const CROSSHAIR_ARM_IDLE = 10;
const CROSSHAIR_ARM_PULSE = 3;
// Water wave animation parameters — tuned for natural-looking tile-scale ripples
const WAVE_TIME_BASE = 0.8;
// Base drift speed
const WAVE_TIME_LAYER_STEP = 0.3;
// Speed increment per layer
const WAVE_ROW_FREQ = 0.5;
// Spatial frequency along rows
const WAVE_ROW_LAYER_VAR = 0.2;
// Row frequency variation per layer
const WAVE_COL_FREQ = 0.3;
// Spatial frequency along columns
const WAVE_COL_LAYER_VAR = 0.15;
// Column frequency variation per layer
const WAVE_PHASE_OFFSET = 2.1;
// Phantom rendering
const DARK_METAL = "#111";
/** Piece phantom opacity for valid placement (saturated color + 3D bevel). */
const PHANTOM_PIECE_ALPHA = 0.85;
/** Piece phantom opacity for invalid placement. */
const PHANTOM_PIECE_INVALID_ALPHA = 0.55;
/** Cannon phantom opacity for valid placement (sprite-based, monochrome). */
const PHANTOM_CANNON_ALPHA = 0.7;
/** Cannon phantom opacity for invalid placement. */
const PHANTOM_CANNON_INVALID_ALPHA = 0.5;
/** Saturation boost for valid phantom wall colors. */
const PHANTOM_SATURATION = 2.5;
/** 3D bevel inset width in pixels. */
const BEVEL_W = 2;
/** How much brighter the top/left bevel highlight is (0–255 additive). */
const BEVEL_HIGHLIGHT_ADD = 80;
/** How much darker the bottom/right bevel shadow is (0–1 multiplicative). */
const BEVEL_SHADOW_MULT = 0.45;
// Spatial hash multipliers for per-tile visual noise
const SEED_ROW = 41;
const SEED_COL = 17;
/**
 * Impact animation phases (normalized 0–1 within IMPACT_FLASH_DURATION):
 *   0.0–0.25:  Core flash (bright spot, quick fade)
 *   0.2–0.6:   Smoke puff (starts during core, continues through ring)
 *   0.0–0.6:   Shockwave ring (expanding circle)
 *   0.0–0.8:   Debris sparks (flying outward)
 *   0.8–1.0:   Smoke lingers (no new effects)
 * Overlaps are intentional — multiple effects layer simultaneously.
 */
const IMPACT_CORE_END = 0.25;
const IMPACT_RING_END = 0.6;
const IMPACT_DEBRIS_END = 0.8;
const IMPACT_SMOKE_START = 0.2;
/**
 * Burning pit ember glow — pulsing orange/red gradient.
 * Color = rgba(RED_BASE ± RED_RANGE, GREEN_BASE ± GREEN_RANGE, 0, ALPHA_BASE ± ALPHA_RANGE)
 * driven by sin(time) for a slow breathing effect.
 */
const EMBER_RED_BASE = 180;
const EMBER_RED_RANGE = 75;
const EMBER_GREEN_BASE = 60;
const EMBER_GREEN_RANGE = 40;
const EMBER_ALPHA_BASE = 0.15;
const EMBER_ALPHA_RANGE = 0.3;
const EMBER_RADIUS_FRESH = 4;
const EMBER_RADIUS_FADING = 3;
// Crosshair colors per player
const CROSSHAIR_COLORS: RGB[] = [
  [255, 50, 50], // P1 red
  [60, 130, 255], // P2 blue
  [255, 200, 30], // P3 gold
];
/** Amber color for the Master Builder lockout pulse. */
const LOCKOUT_AMBER = "rgba(255,180,50,1)";
// Lockout pulse timing (ms per half-cycle of the sin wave)
const LOCKOUT_PULSE_MS = 300;
// Impact core flash: initial size ratio and shrink speed
const IMPACT_CORE_SIZE_RATIO = 0.6;
const IMPACT_CORE_SHRINK_RATE = 1.2;
// Impact shockwave ring initial radius ratio (fraction of TILE_SIZE)
const IMPACT_RING_INITIAL_RATIO = 0.5;
// Impact smoke parameters
const SMOKE_BASE_RADIUS_RATIO = 0.4;
const SMOKE_EXPAND_RATIO = 0.3;
const SMOKE_RISE_PX = 4;
// Debris spark parameters
const SPARK_COUNT = 5;
const SPARK_ANGLE_STEP = 1.3;
const SPARK_BASE_SPEED_RATIO = 0.8;
const SPARK_SPEED_PER_PARTICLE = 3;
const SPARK_DROP_SPEED = 3;
const SPARK_ALPHA_SCALE = 0.9;
// Cannonball radii (px) — mortar balls are larger (incendiary splash)
const BALL_RADIUS_NORMAL = 3;
const BALL_RADIUS_MORTAR = 4.5;
const BALL_ARC_BONUS_NORMAL = 2;
const BALL_ARC_BONUS_MORTAR = 3;
// Balloon geometry (px)
const BALLOON_RADIUS = 8;
const BALLOON_BASKET_OFFSET = 9;
const BALLOON_ARC_HEIGHT = 40;
const BALLOON_HIGHLIGHT_DX = -2;
const BALLOON_HIGHLIGHT_DY = -4;
const BALLOON_HIGHLIGHT_RX = 3;
const BALLOON_HIGHLIGHT_RY = 4;
const BALLOON_HIGHLIGHT_TILT = -0.3;
const BALLOON_ROPE_INSET = 3;
const BALLOON_ROPE_BOTTOM_INSET = 2;
const BALLOON_ROPE_LENGTH = 7;
const BALLOON_BASKET_HALF_W = 3;
const BALLOON_BASKET_H = 4;
// Crosshair geometry helpers
const CROSSHAIR_DIAG_RATIO = 0.7;
const CROSSHAIR_ALPHA_READY_BASE = 0.7;
const CROSSHAIR_ALPHA_READY_AMP = 0.3;
const CROSSHAIR_ALPHA_IDLE_BASE = 0.35;
const CROSSHAIR_ALPHA_IDLE_AMP = 0.15;
const CROSSHAIR_GAP_READY = 5;
const CROSSHAIR_GAP_IDLE = 3;
// ── Frozen river constants ──
// Crack rendering (detail drawn on top of terrain-cached ice fill)
const CRACK_ALPHA = 0.4;
const CRACK_WIDTH = 0.6;
// Thaw animation: radial crack burst
const THAW_CRACK_COUNT = 6;
const THAW_CRACK_LEN = 10;

/** Draw phantom piece/cannon previews.
 *  Draw order: cannon phantoms (behind), then piece phantoms (on top).
 *  Callers control within-category ordering via array position. */
export function drawPhantoms(
  overlayCtx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
): void {
  overlayCtx.save();
  if (overlay?.phantoms?.cannonPhantoms) {
    const facings = overlay.phantoms.defaultFacings;
    for (const phantom of overlay.phantoms.cannonPhantoms) {
      drawPhantomCannon(
        overlayCtx,
        phantom,
        facings as ReadonlyMap<ValidPlayerSlot, number> | undefined,
      );
    }
  }

  if (overlay?.phantoms?.piecePhantoms) {
    for (const phantom of overlay.phantoms.piecePhantoms) {
      const { offsets, row, col, valid, playerId } = phantom;
      const wall = getPlayerColor(playerId).wall;
      drawPiecePhantom(overlayCtx, offsets, row, col, wall, valid);
    }
  }
  overlayCtx.restore();
}

/** Draw bonus squares (flashing green diamonds). */
export function drawBonusSquares(
  overlayCtx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
  now: number = performance.now(),
): void {
  if (!overlay?.entities?.bonusSquares || overlay.battle?.inBattle) return;
  const alphaScale = Math.sin(now / BONUS_FLASH_MS) * 0.15 + 0.85;
  overlayCtx.save();
  overlayCtx.globalAlpha = alphaScale;
  for (const bonus of overlay.entities.bonusSquares) {
    const bx = bonus.col * TILE_SIZE;
    const by = bonus.row * TILE_SIZE;
    drawSprite(overlayCtx, "bonus_square", bx, by);
  }
  overlayCtx.restore();
}

/** Draw houses (settler tents/huts). */
export function drawHouses(
  overlayCtx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.entities?.houses) return;
  for (const house of overlay.entities.houses) {
    if (!house.alive) continue;
    const hx = house.col * TILE_SIZE;
    const hy = house.row * TILE_SIZE;
    drawSprite(overlayCtx, "house", hx, hy);
  }
}

/** Draw grunts (little tanks, top-down, rotated to facing). */
export function drawGrunts(
  overlayCtx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.entities?.grunts) return;
  for (const grunt of overlay.entities.grunts) {
    const gx = grunt.col * TILE_SIZE;
    const gy = grunt.row * TILE_SIZE;
    const angle = grunt.facing ?? 0;
    const dir = facingToCardinal(angle);
    drawSprite(overlayCtx, `grunt_${dir}`, gx, gy);
  }
}

/** Draw animated wave shimmer over water tiles during battle.
 *  @param now — frame timestamp in ms (from drawMap entry point). */
export function drawWaterAnimation(
  overlayCtx: CanvasRenderingContext2D,
  map: GameMap,
  overlay?: RenderOverlay,
  now: number = performance.now(),
): void {
  if (!overlay?.battle?.inBattle) return; // only during battle
  overlayCtx.save();
  const time = now / 1000;
  const rows = map.tiles.length;
  const cols = map.tiles[0]!.length;

  const frozen = overlay?.entities?.frozenTiles;
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      if (!isWater(map.tiles, r, c)) continue;
      // Skip frozen tiles (ice, no waves)
      if (frozen?.has(r * cols + c)) continue;
      // Skip water tiles adjacent to grass (bank transition zone)
      if (
        !isWater(map.tiles, r - 1, c) ||
        !isWater(map.tiles, r + 1, c) ||
        !isWater(map.tiles, r, c - 1) ||
        !isWater(map.tiles, r, c + 1)
      )
        continue;
      const px = c * TILE_SIZE;
      const py = r * TILE_SIZE;

      // Three wave highlights drifting at different speeds across the tile.
      for (let i = 0; i < 3; i++) {
        const phase =
          time * (WAVE_TIME_BASE + i * WAVE_TIME_LAYER_STEP) +
          r * (WAVE_ROW_FREQ + i * WAVE_ROW_LAYER_VAR) +
          c * (WAVE_COL_FREQ + i * WAVE_COL_LAYER_VAR) +
          i * WAVE_PHASE_OFFSET;
        const wave = Math.sin(phase) * 0.5 + 0.5;
        const alpha = 0.06 + wave * 0.09;
        const wy = py + 1 + Math.floor(wave * (TILE_SIZE - 3));
        const wx = px + 1 + ((i * 3) % (TILE_SIZE - 4));
        const wLen = 3 + Math.floor(wave * 4);
        overlayCtx.fillStyle = `rgba(140, 200, 255, ${alpha})`;
        overlayCtx.fillRect(wx, wy, wLen, 1);
        // Shadow line below
        overlayCtx.fillStyle = `rgba(20, 60, 120, ${alpha * 0.5})`;
        overlayCtx.fillRect(wx, wy + 1, wLen, 1);
      }
    }
  }
  overlayCtx.restore();
}

/** Draw impact flashes, cannonballs, balloons, crosshairs, and timer. */
export function drawBattleEffects(
  overlayCtx: CanvasRenderingContext2D,
  map: GameMap,
  overlay: RenderOverlay | undefined,
  now: number,
): void {
  drawImpacts(overlayCtx, overlay);
  drawCannonballs(overlayCtx, overlay);
  drawBalloons(overlayCtx, overlay);
  drawCrosshairs(overlayCtx, overlay, now);
  drawPhaseTimer(overlayCtx, map, overlay, now);
}

/** Draw burning pit ember glows.
 *  @param now — frame timestamp in ms (from drawMap entry point). */
export function drawBurningPits(
  overlayCtx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
  now: number = performance.now(),
): void {
  if (!overlay?.entities?.burningPits) return;
  overlayCtx.save();
  const time = now / 1000;
  for (const pit of overlay.entities.burningPits) {
    const px = pit.col * TILE_SIZE;
    const py = pit.row * TILE_SIZE;
    const mid = TILE_SIZE / 2;
    const flicker =
      (Math.sin(time * 8 + pit.row * SEED_ROW + pit.col * SEED_COL) + 1) * 0.15;
    const stage = Math.max(1, Math.min(3, pit.roundsLeft));
    drawSprite(overlayCtx, `burning_pit_${stage}`, px, py);
    // Animated lava flicker (round glow, stronger for fresh pits)
    if (stage >= 2) {
      const intensity = stage === 3 ? 1.0 : 0.5;
      const emberR = EMBER_RED_BASE + Math.floor(flicker * EMBER_RED_RANGE);
      const emberG = EMBER_GREEN_BASE + Math.floor(flicker * EMBER_GREEN_RANGE);
      const radius = stage === 3 ? EMBER_RADIUS_FRESH : EMBER_RADIUS_FADING;
      overlayCtx.fillStyle = `rgba(${emberR}, ${emberG}, 0, ${(EMBER_ALPHA_BASE + flicker * EMBER_ALPHA_RANGE) * intensity})`;
      overlayCtx.beginPath();
      overlayCtx.arc(px + mid, py + mid, radius, 0, Math.PI * 2);
      overlayCtx.fill();
    }
  }
  overlayCtx.restore();
}

/** Draw ice detail on frozen river tiles (cracks, shimmer, frost edge glow)
 *  and thaw break animations.  The base ice color is baked into the terrain
 *  cache (renderTerrainPixels swaps WATER_COLOR → ICE_COLOR for frozen tiles),
 *  so this function only adds surface detail on top.
 *  @param now — frame timestamp in ms (from drawMap entry point). */
export function drawFrozenTiles(
  overlayCtx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
  now: number = performance.now(),
): void {
  const frozen = overlay?.entities?.frozenTiles;
  const thawing = overlay?.entities?.thawingTiles;
  const hasFrozen = frozen && frozen.size > 0;
  const hasThawing = thawing && thawing.length > 0;
  if (!hasFrozen && !hasThawing) return;

  overlayCtx.save();
  const time = now / 1000;

  // ── Frozen tile detail: cracks + shimmer ──
  // (Base ice color is baked into terrain cache; bank transitions shape the edges.)
  if (hasFrozen) {
    for (const key of frozen) {
      const { r, c } = unpackTile(key);
      const px = c * TILE_SIZE;
      const py = r * TILE_SIZE;
      const seed = r * SEED_ROW + c * SEED_COL;

      // Branching crack pattern
      drawCracks(overlayCtx, px, py, seed);

      // Subtle shimmer — slow-moving specular highlight
      const shimmer = Math.sin(time * 1.5 + r * 0.3 + c * 0.5) * 0.5 + 0.5;
      overlayCtx.fillStyle = `rgba(230, 245, 255, ${(0.04 + shimmer * 0.1).toFixed(3)})`;
      overlayCtx.fillRect(px + 2, py + 2, TILE_SIZE - 4, TILE_SIZE - 4);
    }
  }

  // ── Thawing tiles — crack burst + fade ──
  if (hasThawing) {
    for (const tile of thawing) {
      const progress = tile.age / THAW_DURATION; // 0→1
      const px = tile.col * TILE_SIZE;
      const py = tile.row * TILE_SIZE;
      const cx = px + TILE_SIZE / 2;
      const cy = py + TILE_SIZE / 2;
      const seed = tile.row * SEED_ROW + tile.col * SEED_COL;

      // Fading ice tint — radial gradient so edges dissolve softly
      const fadeAlpha = (1 - progress) * 0.6;
      const fadeRadius = TILE_SIZE * (0.7 - progress * 0.4);
      if (fadeAlpha > 0.01 && fadeRadius > 0) {
        const grad = overlayCtx.createRadialGradient(
          cx,
          cy,
          0,
          cx,
          cy,
          fadeRadius,
        );
        grad.addColorStop(0, `rgba(165, 210, 230, ${fadeAlpha.toFixed(3)})`);
        grad.addColorStop(1, "rgba(165, 210, 230, 0)");
        overlayCtx.fillStyle = grad;
        overlayCtx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      }

      // Radial crack burst — white lines radiating outward from center
      const burstAlpha = Math.max(0, 1 - progress * 1.5);
      if (burstAlpha > 0) {
        overlayCtx.strokeStyle = `rgba(255, 255, 255, ${burstAlpha.toFixed(3)})`;
        overlayCtx.lineWidth = 1;
        const burstLen = THAW_CRACK_LEN * Math.min(1, progress * 2.5);
        for (let ray = 0; ray < THAW_CRACK_COUNT; ray++) {
          const angle =
            ((Math.PI * 2) / THAW_CRACK_COUNT) * ray +
            ((seed >> (ray % 8)) % 10) * 0.1;
          overlayCtx.beginPath();
          overlayCtx.moveTo(cx, cy);
          overlayCtx.lineTo(
            cx + Math.cos(angle) * burstLen,
            cy + Math.sin(angle) * burstLen,
          );
          overlayCtx.stroke();
        }
      }

      // Brief white flash at the start — radial so it doesn't square off
      if (progress < 0.15) {
        const flashAlpha = (1 - progress / 0.15) * 0.4;
        const flashGrad = overlayCtx.createRadialGradient(
          cx,
          cy,
          0,
          cx,
          cy,
          TILE_SIZE * 0.6,
        );
        flashGrad.addColorStop(
          0,
          `rgba(255, 255, 255, ${flashAlpha.toFixed(3)})`,
        );
        flashGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
        overlayCtx.fillStyle = flashGrad;
        overlayCtx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      }
    }
  }

  overlayCtx.restore();
}

/** Draw a deterministic branching crack pattern seeded by tile position. */
function drawCracks(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  seed: number,
): void {
  ctx.strokeStyle = `rgba(255, 255, 255, ${CRACK_ALPHA})`;
  ctx.lineWidth = CRACK_WIDTH;

  // Primary crack: diagonal across the tile
  const x0 = px + (seed % 7) + 1;
  const y0 = py + ((seed >> 2) % 5) + 1;
  const x1 = px + TILE_SIZE - ((seed >> 3) % 5) - 1;
  const y1 = py + TILE_SIZE - ((seed >> 5) % 4) - 1;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  // Secondary crack: branches off midpoint of primary
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const bx = px + ((seed >> 7) % TILE_SIZE);
  const by = py + ((seed >> 4) % (TILE_SIZE - 2)) + 1;
  ctx.beginPath();
  ctx.moveTo(mx, my);
  ctx.lineTo(bx, by);
  ctx.stroke();

  // Tertiary short crack (only on ~half of tiles for variety)
  if (seed % 3 !== 0) {
    const t0x = px + ((seed >> 9) % (TILE_SIZE - 4)) + 2;
    const t0y = py + ((seed >> 6) % (TILE_SIZE - 4)) + 2;
    const t1x = t0x + ((seed >> 11) % 5) - 2;
    const t1y = t0y + ((seed >> 8) % 5) - 2;
    ctx.beginPath();
    ctx.moveTo(t0x, t0y);
    ctx.lineTo(t1x, t1y);
    ctx.stroke();
  }
}

function drawImpacts(
  overlayCtx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.battle?.impacts) return;
  for (const impact of overlay.battle.impacts) {
    const time = impact.age / IMPACT_FLASH_DURATION;
    if (time >= 1) continue;
    overlayCtx.save();
    const cx = impact.col * TILE_SIZE + TILE_SIZE / 2;
    const cy = impact.row * TILE_SIZE + TILE_SIZE / 2;
    const seed = impact.row * SEED_ROW + impact.col * SEED_COL;

    // ── Phase 1 (0.0–0.25): Core flash — brief bright spot, shrinks quickly ──
    if (time < IMPACT_CORE_END) {
      const coreAlpha = (1 - time / IMPACT_CORE_END) * 0.6;
      const coreSize =
        TILE_SIZE * (IMPACT_CORE_SIZE_RATIO - time * IMPACT_CORE_SHRINK_RATE);
      overlayCtx.globalAlpha = coreAlpha;
      overlayCtx.fillStyle = "#ffe0a0";
      overlayCtx.beginPath();
      overlayCtx.arc(cx, cy, Math.max(1, coreSize), 0, Math.PI * 2);
      overlayCtx.fill();
    }

    // ── Phase 2 (0.0–0.6): Shockwave ring — expands outward ──
    if (time < IMPACT_RING_END) {
      const ringR = TILE_SIZE * IMPACT_RING_INITIAL_RATIO + time * TILE_SIZE;
      overlayCtx.globalAlpha = (1 - time / IMPACT_RING_END) * 0.7;
      overlayCtx.strokeStyle = "#ffcc44";
      overlayCtx.lineWidth = 2;
      overlayCtx.beginPath();
      overlayCtx.arc(cx, cy, ringR, 0, Math.PI * 2);
      overlayCtx.stroke();
    }

    // ── Phase 3 (0.0–0.8): Debris sparks — 5 particles flying outward ──
    if (time < IMPACT_DEBRIS_END) {
      const sparkAlpha = 1 - time / IMPACT_DEBRIS_END;
      for (let spark = 0; spark < SPARK_COUNT; spark++) {
        const angle = (seed + spark * SPARK_ANGLE_STEP) % (Math.PI * 2);
        const dist =
          time *
          (TILE_SIZE * SPARK_BASE_SPEED_RATIO +
            spark * SPARK_SPEED_PER_PARTICLE);
        const sx = cx + Math.cos(angle) * dist;
        const sy = cy + Math.sin(angle) * dist - time * SPARK_DROP_SPEED;
        overlayCtx.globalAlpha = sparkAlpha * SPARK_ALPHA_SCALE;
        overlayCtx.fillStyle = spark % 2 === 0 ? "#ffaa30" : "#ff6600";
        overlayCtx.fillRect(sx - 1, sy - 1, 2, 2);
      }
    }

    // ── Phase 4 (0.2–1.0): Smoke — dark puff rising, lingers in second half ──
    if (time > IMPACT_SMOKE_START) {
      const smokeT = (time - IMPACT_SMOKE_START) / (1 - IMPACT_SMOKE_START);
      const smokeR =
        TILE_SIZE * SMOKE_BASE_RADIUS_RATIO +
        smokeT * TILE_SIZE * SMOKE_EXPAND_RATIO;
      overlayCtx.globalAlpha = (1 - smokeT) * 0.35;
      overlayCtx.fillStyle = "#3a3028";
      overlayCtx.beginPath();
      overlayCtx.arc(cx, cy - smokeT * SMOKE_RISE_PX, smokeR, 0, Math.PI * 2);
      overlayCtx.fill();
    }

    overlayCtx.restore();
  }
}

function drawCannonballs(
  overlayCtx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.battle?.cannonballs) return;
  overlayCtx.save();
  for (const ball of overlay.battle.cannonballs) {
    // progress: normalized 0→1 linear interpolation from launch position to target
    const height = Math.sin(ball.progress * Math.PI);
    // Mortar balls are larger and reddish (incendiary splash creates burning pits)
    const baseRadius = ball.mortar ? BALL_RADIUS_MORTAR : BALL_RADIUS_NORMAL;
    const arcBonus = ball.mortar
      ? BALL_ARC_BONUS_MORTAR
      : BALL_ARC_BONUS_NORMAL;
    const radius = baseRadius + height * arcBonus;
    const color = ball.mortar ? "#b33" : ball.incendiary ? "#c22" : DARK_METAL;
    overlayCtx.fillStyle = color;
    overlayCtx.beginPath();
    overlayCtx.arc(ball.x, ball.y, radius, 0, Math.PI * 2);
    overlayCtx.fill();
  }
  overlayCtx.restore();
}

function drawBalloons(
  overlayCtx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.battle?.balloons) return;
  overlayCtx.save();
  for (const b of overlay.battle.balloons) {
    // progress: normalized 0→1 arc trajectory (basket follows parabolic path to target)
    const progress = b.progress;
    const radius = BALLOON_RADIUS;
    const basketOffset = radius + BALLOON_BASKET_OFFSET; // envelope center to basket center
    // Interpolate so the basket (not envelope) arrives at the target center
    const cx = b.x + (b.targetX - b.x) * progress;
    const cy =
      b.y +
      (b.targetY - basketOffset - b.y) * progress -
      Math.sin(progress * Math.PI) * BALLOON_ARC_HEIGHT;
    // Balloon envelope (main body — red)
    overlayCtx.fillStyle = "#b03030";
    overlayCtx.beginPath();
    overlayCtx.ellipse(cx, cy - 1, radius, radius + 2, 0, 0, Math.PI * 2);
    overlayCtx.fill();
    // Highlight (specular)
    overlayCtx.fillStyle = "rgba(220, 120, 120, 0.5)";
    overlayCtx.beginPath();
    overlayCtx.ellipse(
      cx + BALLOON_HIGHLIGHT_DX,
      cy + BALLOON_HIGHLIGHT_DY,
      BALLOON_HIGHLIGHT_RX,
      BALLOON_HIGHLIGHT_RY,
      BALLOON_HIGHLIGHT_TILT,
      0,
      Math.PI * 2,
    );
    overlayCtx.fill();
    // Panel seams
    overlayCtx.strokeStyle = "#802020";
    overlayCtx.lineWidth = 0.5;
    overlayCtx.beginPath();
    overlayCtx.moveTo(cx, cy - radius - 1);
    overlayCtx.lineTo(cx, cy + radius + 1);
    overlayCtx.stroke();
    overlayCtx.beginPath();
    overlayCtx.moveTo(cx - radius, cy);
    overlayCtx.lineTo(cx + radius, cy);
    overlayCtx.stroke();
    // Envelope outline
    overlayCtx.strokeStyle = "#601818";
    overlayCtx.lineWidth = 1;
    overlayCtx.beginPath();
    overlayCtx.ellipse(cx, cy - 1, radius, radius + 2, 0, 0, Math.PI * 2);
    overlayCtx.stroke();
    // Ropes (two angled lines from envelope base to basket)
    overlayCtx.strokeStyle = "#6a5a3a";
    overlayCtx.lineWidth = 0.7;
    overlayCtx.beginPath();
    overlayCtx.moveTo(cx - BALLOON_ROPE_INSET, cy + radius + 1);
    overlayCtx.lineTo(
      cx - BALLOON_ROPE_BOTTOM_INSET,
      cy + radius + BALLOON_ROPE_LENGTH,
    );
    overlayCtx.stroke();
    overlayCtx.beginPath();
    overlayCtx.moveTo(cx + BALLOON_ROPE_INSET, cy + radius + 1);
    overlayCtx.lineTo(
      cx + BALLOON_ROPE_BOTTOM_INSET,
      cy + radius + BALLOON_ROPE_LENGTH,
    );
    overlayCtx.stroke();
    // Basket (wicker)
    overlayCtx.fillStyle = "#8b6914";
    overlayCtx.fillRect(
      cx - BALLOON_BASKET_HALF_W,
      cy + radius + BALLOON_ROPE_LENGTH,
      BALLOON_BASKET_HALF_W * 2,
      BALLOON_BASKET_H,
    );
    overlayCtx.fillStyle = "#a07a1a";
    overlayCtx.fillRect(
      cx - BALLOON_ROPE_BOTTOM_INSET,
      cy + radius + BALLOON_ROPE_LENGTH + 1,
      BALLOON_ROPE_BOTTOM_INSET * 2,
      2,
    );
    // Basket rim
    overlayCtx.fillStyle = "#6a4a0a";
    overlayCtx.fillRect(
      cx - BALLOON_BASKET_HALF_W,
      cy + radius + BALLOON_ROPE_LENGTH,
      BALLOON_BASKET_HALF_W * 2,
      1,
    );
  }
  overlayCtx.restore();
}

function drawCrosshairs(
  overlayCtx: CanvasRenderingContext2D,
  overlay: RenderOverlay | undefined,
  now: number,
): void {
  if (!overlay?.battle?.crosshairs) return;
  overlayCtx.save();
  const time = now / 1000;
  for (const ch of overlay.battle.crosshairs) {
    const cx = Math.round(ch.x) + 0.5;
    const cy = Math.round(ch.y) + 0.5;
    const [cr, green, blue] =
      CROSSHAIR_COLORS[ch.playerId % CROSSHAIR_COLORS.length]!;
    const { alpha, arm, diag, gap } = crosshairGeometry(
      ch.cannonReady === true,
      time,
    );

    const drawArm = (
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      color: string,
    ) => {
      overlayCtx.strokeStyle = `rgba(0,0,0,${alpha * 0.8})`;
      overlayCtx.lineWidth = 5;
      overlayCtx.beginPath();
      overlayCtx.moveTo(x1, y1);
      overlayCtx.lineTo(x2, y2);
      overlayCtx.stroke();
      overlayCtx.strokeStyle = color;
      overlayCtx.lineWidth = 2;
      overlayCtx.beginPath();
      overlayCtx.moveTo(x1, y1);
      overlayCtx.lineTo(x2, y2);
      overlayCtx.stroke();
    };

    const pColor = `rgba(${cr},${green},${blue},${alpha})`;
    const wColor = `rgba(255,255,255,${alpha})`;

    drawArm(cx - gap, cy - gap, cx - diag, cy - diag, pColor);
    drawArm(cx + gap, cy - gap, cx + diag, cy - diag, pColor);
    drawArm(cx - gap, cy + gap, cx - diag, cy + diag, pColor);
    drawArm(cx + gap, cy + gap, cx + diag, cy + diag, pColor);

    drawArm(cx, cy - gap, cx, cy - arm, wColor);
    drawArm(cx, cy + gap, cx, cy + arm, wColor);
    drawArm(cx - gap, cy, cx - arm, cy, wColor);
    drawArm(cx + gap, cy, cx + arm, cy, wColor);
  }
  overlayCtx.restore();
}

function drawPhaseTimer(
  overlayCtx: CanvasRenderingContext2D,
  map: GameMap,
  overlay: RenderOverlay | undefined,
  now: number,
): void {
  if (overlay?.ui?.timer == null || overlay.ui.timer < 0) return;
  const secs = Math.max(0, Math.ceil(overlay.ui.timer) - 1);
  const text = `${secs}`;
  const jx = map.junction.x * TILE_SIZE + TILE_SIZE / 2;
  const jy = map.junction.y * TILE_SIZE + TILE_SIZE / 2;
  const lockout = overlay.ui.masterBuilderLockout ?? 0;
  overlayCtx.save();
  overlayCtx.font = FONT_TIMER;
  overlayCtx.textAlign = TEXT_ALIGN_CENTER;
  overlayCtx.textBaseline = TEXT_BASELINE_MIDDLE;
  if (lockout > 0) {
    // Pulse: time-based scale oscillation matching other render effects
    const pulse = 1.0 + 0.15 * Math.abs(Math.sin(now / LOCKOUT_PULSE_MS));
    overlayCtx.translate(jx, jy);
    overlayCtx.scale(pulse, pulse);
    drawShadowText(overlayCtx, text, 0, 0, SHADOW_COLOR, LOCKOUT_AMBER);
  } else {
    drawShadowText(overlayCtx, text, jx, jy, SHADOW_COLOR, TEXT_WHITE);
  }
  overlayCtx.restore();
}

/** Compute animated crosshair dimensions from ready state and time.
 *  Returns: alpha (opacity), arm (crosshair line length),
 *  diag (diagonal tick length, ~70% of arm), gap (px between center and lines). */
function crosshairGeometry(
  ready: boolean,
  time: number,
): { alpha: number; arm: number; diag: number; gap: number } {
  const alpha = ready
    ? CROSSHAIR_ALPHA_READY_BASE +
      CROSSHAIR_ALPHA_READY_AMP * Math.sin(time * CROSSHAIR_READY_CYCLE_MS)
    : CROSSHAIR_ALPHA_IDLE_BASE +
      CROSSHAIR_ALPHA_IDLE_AMP * Math.sin(time * CROSSHAIR_IDLE_CYCLE_MS);
  const arm = ready
    ? CROSSHAIR_ARM_READY +
      Math.sin(time * CROSSHAIR_READY_CYCLE_MS) * CROSSHAIR_ARM_PULSE
    : CROSSHAIR_ARM_IDLE;
  const diag = Math.round(arm * CROSSHAIR_DIAG_RATIO);
  const gap = ready ? CROSSHAIR_GAP_READY : CROSSHAIR_GAP_IDLE;
  return { alpha, arm, diag, gap };
}

/** Draw a semi-transparent cannon sprite as a placement phantom.
 *  Unlike piece phantoms (which use a single valid/invalid fill color),
 *  cannon phantoms use per-rect color pairs because they're procedurally drawn
 *  with multiple shapes. Each shape has a normal color and a red-tinted invalid variant. */
function drawPhantomCannon(
  overlayCtx: CanvasRenderingContext2D,
  phantom: {
    readonly row: number;
    readonly col: number;
    readonly valid: boolean;
    readonly mode: CannonMode;
    readonly playerId: ValidPlayerSlot;
  },
  defaultFacings?: ReadonlyMap<ValidPlayerSlot, number>,
): void {
  const { row, col, valid, mode, playerId } = phantom;
  const facing = defaultFacings?.get(playerId) ?? 0;
  const cx = col * TILE_SIZE;
  const cy = row * TILE_SIZE;
  const sz = isSuperMode(mode) ? 3 : 2;
  const size = TILE_SIZE * sz;
  const mid = size / 2;

  overlayCtx.save();
  overlayCtx.globalAlpha = valid
    ? PHANTOM_CANNON_ALPHA
    : PHANTOM_CANNON_INVALID_ALPHA;

  if (isBalloonMode(mode)) {
    drawBalloonPhantom(overlayCtx, cx, cy, size, valid);
    overlayCtx.restore();
    return;
  }

  if (isRampartMode(mode)) {
    // Rampart phantom: stone block with shield circle
    overlayCtx.fillStyle = valid ? "#556677" : "#774444";
    overlayCtx.fillRect(cx + 2, cy + 2, size - 4, size - 4);
    overlayCtx.strokeStyle = valid ? "#33cc33" : "#cc4444";
    overlayCtx.lineWidth = 2;
    overlayCtx.beginPath();
    overlayCtx.arc(cx + mid, cy + mid, mid - 4, 0, Math.PI * 2);
    overlayCtx.stroke();
    overlayCtx.restore();
    return;
  }

  // Draw actual cannon sprite at alpha, tinted red if invalid
  overlayCtx.translate(cx + mid, cy + mid);
  overlayCtx.rotate(facing);
  if (isSuperMode(mode)) {
    drawSuperPhantom(overlayCtx, valid);
  } else {
    // Normal cannon phantom — symmetric around (0,0)
    overlayCtx.fillStyle = valid ? "#1a1a1a" : "#3a1111";
    overlayCtx.fillRect(-10, -5, 20, 16);
    overlayCtx.fillStyle = valid ? "#333" : "#553333";
    overlayCtx.fillRect(-12, -3, 4, 8);
    overlayCtx.fillRect(8, -3, 4, 8);
    overlayCtx.fillStyle = valid ? "#2a2a2a" : "#4a2222";
    overlayCtx.fillRect(-10, 0, 20, 2);
    overlayCtx.fillStyle = valid ? "#555" : "#884444";
    overlayCtx.fillRect(-2, -11, 4, 17);
    overlayCtx.fillStyle = valid ? DARK_METAL : "#331111";
    overlayCtx.fillRect(-1, -11, 2, 2);
    overlayCtx.fillStyle = valid ? "#777" : "#aa4444";
    overlayCtx.fillRect(-3, -6, 6, 2);
  }
  overlayCtx.restore();
}

/** Draw a single phantom piece — 3D bevel when valid, red tint + red outline when invalid. */
function drawPiecePhantom(
  overlayCtx: CanvasRenderingContext2D,
  offsets: readonly [number, number][],
  row: number,
  col: number,
  wall: RGB,
  valid: boolean,
): void {
  const face = saturateRgb(wall, PHANTOM_SATURATION);
  overlayCtx.save();
  overlayCtx.globalAlpha = valid
    ? PHANTOM_PIECE_ALPHA
    : PHANTOM_PIECE_INVALID_ALPHA;

  const base: RGB = valid
    ? face
    : [
        Math.min(255, Math.round(face[0] * 0.3 + 170)),
        Math.round(face[1] * 0.15),
        Math.round(face[2] * 0.15),
      ];
  const hi: RGB = [
    Math.min(255, base[0] + BEVEL_HIGHLIGHT_ADD),
    Math.min(255, base[1] + BEVEL_HIGHLIGHT_ADD),
    Math.min(255, base[2] + BEVEL_HIGHLIGHT_ADD),
  ];
  const sh: RGB = [
    Math.round(base[0] * BEVEL_SHADOW_MULT),
    Math.round(base[1] * BEVEL_SHADOW_MULT),
    Math.round(base[2] * BEVEL_SHADOW_MULT),
  ];
  for (const [dr, dc] of offsets) {
    const x = (col + dc) * TILE_SIZE;
    const y = (row + dr) * TILE_SIZE;
    const sz = TILE_SIZE;
    const bv = BEVEL_W;
    // Face fill
    overlayCtx.fillStyle = rgb(base);
    overlayCtx.fillRect(x, y, sz, sz);
    // Top highlight
    overlayCtx.fillStyle = rgb(hi);
    overlayCtx.fillRect(x, y, sz, bv);
    // Left highlight
    overlayCtx.fillRect(x, y, bv, sz);
    // Bottom shadow
    overlayCtx.fillStyle = rgb(sh);
    overlayCtx.fillRect(x, y + sz - bv, sz, bv);
    // Right shadow
    overlayCtx.fillRect(x + sz - bv, y, bv, sz);
  }

  overlayCtx.restore();
}

/** Boost saturation of an RGB color. factor 0 = original, 1 = fully saturated. */
function saturateRgb(c: RGB, factor: number): RGB {
  const avg = (c[0] + c[1] + c[2]) / 3;
  return [
    Math.round(Math.min(255, c[0] + (c[0] - avg) * factor)),
    Math.round(Math.min(255, c[1] + (c[1] - avg) * factor)),
    Math.round(Math.min(255, c[2] + (c[2] - avg) * factor)),
  ];
}

/** Draw balloon base phantom — sprite with red tint overlay if invalid. */
function drawBalloonPhantom(
  overlayCtx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  valid: boolean,
): void {
  drawSprite(overlayCtx, "balloon_base", x, y);
  if (!valid) {
    overlayCtx.fillStyle = "rgba(170, 34, 34, 0.4)";
    overlayCtx.fillRect(x, y, size, size);
  }
}

/** Draw super gun phantom footprint — symmetric around current transform origin. */
function drawSuperPhantom(
  overlayCtx: CanvasRenderingContext2D,
  valid: boolean,
): void {
  overlayCtx.fillStyle = valid ? "#1a1a1a" : "#3a1111";
  overlayCtx.fillRect(-14, -8, 28, 24);
  overlayCtx.fillStyle = valid ? "#333" : "#553333";
  overlayCtx.fillRect(-18, -6, 5, 11);
  overlayCtx.fillRect(13, -6, 5, 11);
  overlayCtx.fillStyle = valid ? "#2a2a2a" : "#4a2222";
  overlayCtx.fillRect(-16, -2, 32, 2);
  overlayCtx.fillStyle = valid ? "#444" : "#884444";
  overlayCtx.fillRect(-4, -18, 8, 27);
  overlayCtx.fillStyle = valid ? DARK_METAL : "#331111";
  overlayCtx.fillRect(-1, -18, 2, 3);
  overlayCtx.fillStyle = valid ? "#a33" : "#cc4444";
  overlayCtx.fillRect(-5, -11, 10, 2);
  overlayCtx.fillRect(-5, -5, 10, 2);
}
