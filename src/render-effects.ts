/**
 * Visual effects rendering — impacts, cannonballs, balloons, burning pits,
 * crosshairs, phantoms, bonus squares, houses, grunts.
 *
 * Convention: exported functions use `overlayCtx` (overlay context) for the parameter name.
 * Private helper functions use `ctx` for brevity.
 *
 * ### Parameter convention (shared with render-composition.ts, render-map.ts)
 *
 * Exported functions with ≤3 closely-related args use positional parameters;
 * exported functions with >3 args or heterogeneous config use a `params` object.
 * Private helpers are exempt — they use positional args for brevity since
 * they're called from one place and readability is local.
 *
 * ### Time parameter convention (applies across all render-* files)
 *
 * Two timestamp sources are used in the render domain:
 *
 * 1. `now?: number` (Date.now() scale) — used for TESTABLE animations
 *    (bonus squares, score deltas). Caller can inject a fixed timestamp in tests.
 *    Falls back to `Date.now()` when omitted.
 *
 * 2. `performance.now()` — called inline for REAL-TIME visual effects that are
 *    never tested in isolation (water shimmer, burning pits, crosshair pulse).
 *    Higher resolution than Date.now() but not injectable.
 *
 * **Rule**: new render functions should accept `now?: number` (Date.now scale)
 * unless the animation is purely cosmetic and will never be snapshot-tested.
 * Never mix the two in a single function — pick one source and stick with it.
 *
 * ### Canvas save/restore convention (applies across all render-* files)
 *
 * Any function that mutates the canvas context (globalAlpha, transform, clip,
 * fillStyle, etc.) MUST wrap the mutation in `ctx.save()` / `ctx.restore()`.
 * This ensures callers don't inherit unexpected state. The pattern is:
 *   ctx.save();
 *   // ... mutations + drawing ...
 *   ctx.restore();
 */

import { IMPACT_FLASH_DURATION } from "./game-constants.ts";
import type { RGB } from "./geometry-types.ts";
import { TILE_SIZE, TILE_WATER } from "./grid.ts";
import { getPlayerColor } from "./player-config.ts";
import { drawSprite } from "./render-sprites.ts";
import {
  BONUS_FLASH_MS,
  CROSSHAIR_ARM_IDLE,
  CROSSHAIR_ARM_PULSE,
  CROSSHAIR_ARM_READY,
  CROSSHAIR_IDLE_FREQ,
  CROSSHAIR_READY_FREQ,
  drawShadowText,
  FONT_TIMER,
  rgb,
  SHADOW_COLOR,
  TEXT_ALIGN_CENTER,
  TEXT_BASELINE_MIDDLE,
  TEXT_WHITE,
} from "./render-theme.ts";
import type { MapData, RenderOverlay } from "./render-types.ts";
import { facingToCardinal } from "./spatial.ts";
import { type CannonMode, isBalloonMode, isSuperMode } from "./types.ts";

// Phantom rendering
const DARK_METAL = "#111";
const PHANTOM_INVALID_COLOR = "#aa2222";
/** Shared phantom opacity for all placement previews (primary, split-screen human, AI). */
const PHANTOM_ALPHA = 0.55;
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

/** Draw phantom piece/cannon previews (AI and human). */
export function drawPhantoms(
  overlayCtx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
): void {
  // AI cannon phantoms
  if (overlay?.phantoms?.aiCannonPhantoms) {
    for (const phantom of overlay.phantoms.aiCannonPhantoms) {
      drawPhantomCannon(overlayCtx, phantom);
    }
  }

  // Primary human phantom piece
  if (overlay?.phantoms?.phantomPiece) {
    const { offsets, row, col, valid } = overlay.phantoms.phantomPiece;
    drawPiecePhantom(
      overlayCtx,
      offsets,
      row,
      col,
      valid ? "#c8c0b8" : PHANTOM_INVALID_COLOR,
      PHANTOM_ALPHA,
      false,
    );
  }

  // All human phantom pieces (multi-human build phase)
  if (overlay?.phantoms?.humanPhantoms) {
    for (const phantom of overlay.phantoms.humanPhantoms) {
      const { offsets, row, col, valid, playerId } = phantom;
      const wall = getPlayerColor(playerId).wall;
      const fill = valid ? rgb(wall) : PHANTOM_INVALID_COLOR;
      drawPiecePhantom(
        overlayCtx,
        offsets,
        row,
        col,
        fill,
        PHANTOM_ALPHA,
        true,
      );
    }
  }

  // AI phantom piece previews
  if (overlay?.phantoms?.aiPhantoms) {
    for (const phantom of overlay.phantoms.aiPhantoms) {
      const { offsets, row, col, playerId } = phantom;
      const wall = getPlayerColor(playerId).wall;
      drawPiecePhantom(
        overlayCtx,
        offsets,
        row,
        col,
        rgb(wall),
        PHANTOM_ALPHA,
        true,
      );
    }
  }
}

/** Draw bonus squares (flashing green diamonds). */
export function drawBonusSquares(
  overlayCtx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
  now?: number,
): void {
  if (!overlay?.entities?.bonusSquares || overlay.battle?.battleTerritory)
    return;
  const alphaScale =
    Math.sin((now ?? Date.now()) / BONUS_FLASH_MS) * 0.15 + 0.85;
  overlayCtx.save();
  overlayCtx.globalAlpha = alphaScale;
  for (const bs of overlay.entities.bonusSquares) {
    const bx = bs.col * TILE_SIZE;
    const by = bs.row * TILE_SIZE;
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

/** Draw animated wave shimmer over water tiles during battle. */
export function drawWaterAnimation(
  overlayCtx: CanvasRenderingContext2D,
  map: MapData,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.battle?.battleTerritory) return; // only during battle
  const time = performance.now() / 1000;
  const rows = map.tiles.length;
  const cols = map.tiles[0]!.length;

  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      if (map.tiles[r]![c] !== TILE_WATER) continue;
      // Skip water tiles adjacent to grass (bank transition zone)
      if (
        map.tiles[r - 1]![c] !== TILE_WATER ||
        map.tiles[r + 1]![c] !== TILE_WATER ||
        map.tiles[r]![c - 1] !== TILE_WATER ||
        map.tiles[r]![c + 1] !== TILE_WATER
      )
        continue;
      const px = c * TILE_SIZE;
      const py = r * TILE_SIZE;

      // Three wave highlights drifting at different speeds across the tile.
      // Tuning constants below control wave animation feel:
      //   time * (baseSpeed + i*speedVar) — time-based drift (0.8 base, +0.3 per layer)
      //   r/c * (rowFreq + i*var) — spatial frequency for row/col variation
      //   i * 2.1 — phase offset between layers (coprime-ish avoids sync)
      for (let i = 0; i < 3; i++) {
        const phase =
          time * (0.8 + i * 0.3) +
          r * (0.5 + i * 0.2) +
          c * (0.3 + i * 0.15) +
          i * 2.1;
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
}

/** Draw impact flashes, cannonballs, balloons, burning pits, crosshairs, and timer. */
export function drawBattleEffects(
  overlayCtx: CanvasRenderingContext2D,
  map: MapData,
  overlay?: RenderOverlay,
): void {
  drawImpacts(overlayCtx, overlay);
  drawCannonballs(overlayCtx, overlay);
  drawBalloons(overlayCtx, overlay);
  drawBurningPits(overlayCtx, overlay);
  drawCrosshairs(overlayCtx, overlay);
  drawPhaseTimer(overlayCtx, map, overlay);
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

    // Core flash — brief bright spot, shrinks quickly
    if (time < IMPACT_CORE_END) {
      const coreAlpha = (1 - time / IMPACT_CORE_END) * 0.6;
      const coreSize = TILE_SIZE * (0.6 - time * 1.2);
      overlayCtx.globalAlpha = coreAlpha;
      overlayCtx.fillStyle = "#ffe0a0";
      overlayCtx.beginPath();
      overlayCtx.arc(cx, cy, Math.max(1, coreSize), 0, Math.PI * 2);
      overlayCtx.fill();
    }

    // Shockwave ring — expands outward
    if (time < IMPACT_RING_END) {
      const ringR = TILE_SIZE * 0.5 + time * TILE_SIZE;
      overlayCtx.globalAlpha = (1 - time / IMPACT_RING_END) * 0.7;
      overlayCtx.strokeStyle = "#ffcc44";
      overlayCtx.lineWidth = 2;
      overlayCtx.beginPath();
      overlayCtx.arc(cx, cy, ringR, 0, Math.PI * 2);
      overlayCtx.stroke();
    }

    // Debris sparks — 5 particles flying outward
    if (time < IMPACT_DEBRIS_END) {
      const sparkAlpha = 1 - time / IMPACT_DEBRIS_END;
      for (let i = 0; i < 5; i++) {
        const angle = (seed + i * 1.3) % (Math.PI * 2);
        const dist = time * (TILE_SIZE * 0.8 + i * 3);
        const sx = cx + Math.cos(angle) * dist;
        const sy = cy + Math.sin(angle) * dist - time * 3;
        overlayCtx.globalAlpha = sparkAlpha * 0.9;
        overlayCtx.fillStyle = i % 2 === 0 ? "#ffaa30" : "#ff6600";
        overlayCtx.fillRect(sx - 1, sy - 1, 2, 2);
      }
    }

    // Smoke — dark puff rising, lingers in second half
    if (time > IMPACT_SMOKE_START) {
      const smokeT = (time - IMPACT_SMOKE_START) / (1 - IMPACT_SMOKE_START);
      const smokeR = TILE_SIZE * 0.4 + smokeT * TILE_SIZE * 0.3;
      overlayCtx.globalAlpha = (1 - smokeT) * 0.35;
      overlayCtx.fillStyle = "#3a3028";
      overlayCtx.beginPath();
      overlayCtx.arc(cx, cy - smokeT * 4, smokeR, 0, Math.PI * 2);
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
    const height = Math.sin(ball.progress * Math.PI);
    const radius = 3 + height * 2; // 3px base + up to 2px from arc
    overlayCtx.fillStyle = ball.incendiary ? "#c22" : DARK_METAL;
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
    const progress = b.progress;
    const radius = 8;
    const basketOffset = radius + 9; // envelope center to basket center
    // Interpolate so the basket (not envelope) arrives at the target center
    const cx = b.x + (b.targetX - b.x) * progress;
    const cy =
      b.y +
      (b.targetY - basketOffset - b.y) * progress -
      Math.sin(progress * Math.PI) * 40;
    // Balloon envelope (main body — red)
    overlayCtx.fillStyle = "#b03030";
    overlayCtx.beginPath();
    overlayCtx.ellipse(cx, cy - 1, radius, radius + 2, 0, 0, Math.PI * 2);
    overlayCtx.fill();
    // Highlight (specular)
    overlayCtx.fillStyle = "rgba(220, 120, 120, 0.5)";
    overlayCtx.beginPath();
    overlayCtx.ellipse(cx - 2, cy - 4, 3, 4, -0.3, 0, Math.PI * 2);
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
    overlayCtx.moveTo(cx - 3, cy + radius + 1);
    overlayCtx.lineTo(cx - 2, cy + radius + 7);
    overlayCtx.stroke();
    overlayCtx.beginPath();
    overlayCtx.moveTo(cx + 3, cy + radius + 1);
    overlayCtx.lineTo(cx + 2, cy + radius + 7);
    overlayCtx.stroke();
    // Basket (wicker)
    overlayCtx.fillStyle = "#8b6914";
    overlayCtx.fillRect(cx - 3, cy + radius + 7, 6, 4);
    overlayCtx.fillStyle = "#a07a1a";
    overlayCtx.fillRect(cx - 2, cy + radius + 8, 4, 2);
    // Basket rim
    overlayCtx.fillStyle = "#6a4a0a";
    overlayCtx.fillRect(cx - 3, cy + radius + 7, 6, 1);
  }
  overlayCtx.restore();
}

function drawBurningPits(
  overlayCtx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.entities?.burningPits) return;
  const time = performance.now() / 1000;
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
}

function drawCrosshairs(
  overlayCtx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.battle?.crosshairs) return;
  const time = performance.now() / 1000;
  for (const ch of overlay.battle.crosshairs) {
    const cx = Math.round(ch.x) + 0.5;
    const cy = Math.round(ch.y) + 0.5;
    const [cr, cg, cb] =
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

    const pColor = `rgba(${cr},${cg},${cb},${alpha})`;
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
}

function drawPhaseTimer(
  overlayCtx: CanvasRenderingContext2D,
  map: MapData,
  overlay?: RenderOverlay,
): void {
  if (overlay?.ui?.timer == null || overlay.ui.timer < 0) return;
  const secs = Math.max(0, Math.ceil(overlay.ui.timer) - 1);
  const text = `${secs}`;
  const jx = map.junction.x * TILE_SIZE + TILE_SIZE / 2;
  const jy = map.junction.y * TILE_SIZE + TILE_SIZE / 2;
  overlayCtx.save();
  overlayCtx.font = FONT_TIMER;
  overlayCtx.textAlign = TEXT_ALIGN_CENTER;
  overlayCtx.textBaseline = TEXT_BASELINE_MIDDLE;
  drawShadowText(overlayCtx, text, jx, jy, SHADOW_COLOR, TEXT_WHITE);
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
    ? 0.7 + 0.3 * Math.sin(time * CROSSHAIR_READY_FREQ)
    : 0.35 + 0.15 * Math.sin(time * CROSSHAIR_IDLE_FREQ);
  const arm = ready
    ? CROSSHAIR_ARM_READY +
      Math.sin(time * CROSSHAIR_READY_FREQ) * CROSSHAIR_ARM_PULSE
    : CROSSHAIR_ARM_IDLE;
  const diag = Math.round(arm * 0.7);
  const gap = ready ? 5 : 3;
  return { alpha, arm, diag, gap };
}

/** Draw a semi-transparent cannon sprite as a placement phantom.
 *  Unlike piece phantoms (which use a single valid/invalid fill color),
 *  cannon phantoms use per-rect color pairs because they're procedurally drawn
 *  with multiple shapes. Each shape has a normal color and a red-tinted invalid variant. */
function drawPhantomCannon(
  canvasCtx: CanvasRenderingContext2D,
  phantom: {
    readonly row: number;
    readonly col: number;
    readonly valid: boolean;
    readonly mode: CannonMode;
    readonly facing?: number;
  },
): void {
  const { row, col, valid, mode, facing = 0 } = phantom;
  const cx = col * TILE_SIZE;
  const cy = row * TILE_SIZE;
  const sz = isSuperMode(mode) ? 3 : 2;
  const size = TILE_SIZE * sz;
  const mid = size / 2;

  canvasCtx.save();
  canvasCtx.globalAlpha = valid ? 0.7 : 0.5;

  if (isBalloonMode(mode)) {
    // Balloon base preview — sprite with red tint overlay if invalid
    drawSprite(canvasCtx, "balloon_base", cx, cy);
    if (!valid) {
      canvasCtx.fillStyle = "rgba(170, 34, 34, 0.4)";
      canvasCtx.fillRect(cx, cy, size, size);
    }
    canvasCtx.restore();
    return;
  }

  // Draw actual cannon sprite at alpha, tinted red if invalid
  canvasCtx.translate(cx + mid, cy + mid);
  canvasCtx.rotate(facing);
  if (isSuperMode(mode)) {
    // Super gun phantom — symmetric around (0,0)
    canvasCtx.fillStyle = valid ? "#1a1a1a" : "#3a1111";
    canvasCtx.fillRect(-14, -8, 28, 24);
    canvasCtx.fillStyle = valid ? "#333" : "#553333";
    canvasCtx.fillRect(-18, -6, 5, 11);
    canvasCtx.fillRect(13, -6, 5, 11);
    canvasCtx.fillStyle = valid ? "#2a2a2a" : "#4a2222";
    canvasCtx.fillRect(-16, -2, 32, 2);
    canvasCtx.fillStyle = valid ? "#444" : "#884444";
    canvasCtx.fillRect(-4, -18, 8, 27);
    canvasCtx.fillStyle = valid ? DARK_METAL : "#331111";
    canvasCtx.fillRect(-1, -18, 2, 3);
    canvasCtx.fillStyle = valid ? "#a33" : "#cc4444";
    canvasCtx.fillRect(-5, -11, 10, 2);
    canvasCtx.fillRect(-5, -5, 10, 2);
  } else {
    // Normal cannon phantom — symmetric around (0,0)
    canvasCtx.fillStyle = valid ? "#1a1a1a" : "#3a1111";
    canvasCtx.fillRect(-10, -5, 20, 16);
    canvasCtx.fillStyle = valid ? "#333" : "#553333";
    canvasCtx.fillRect(-12, -3, 4, 8);
    canvasCtx.fillRect(8, -3, 4, 8);
    canvasCtx.fillStyle = valid ? "#2a2a2a" : "#4a2222";
    canvasCtx.fillRect(-10, 0, 20, 2);
    canvasCtx.fillStyle = valid ? "#555" : "#884444";
    canvasCtx.fillRect(-2, -11, 4, 17);
    canvasCtx.fillStyle = valid ? DARK_METAL : "#331111";
    canvasCtx.fillRect(-1, -11, 2, 2);
    canvasCtx.fillStyle = valid ? "#777" : "#aa4444";
    canvasCtx.fillRect(-3, -6, 6, 2);
  }
  canvasCtx.restore();
}

/** Draw a single phantom piece (fill + optional outline). */
function drawPiecePhantom(
  overlayCtx: CanvasRenderingContext2D,
  offsets: readonly [number, number][],
  row: number,
  col: number,
  fillColor: string,
  alpha: number,
  outline: boolean,
): void {
  overlayCtx.save();
  overlayCtx.globalAlpha = alpha;
  overlayCtx.fillStyle = fillColor;
  for (const [dr, dc] of offsets) {
    overlayCtx.fillRect(
      (col + dc) * TILE_SIZE,
      (row + dr) * TILE_SIZE,
      TILE_SIZE,
      TILE_SIZE,
    );
  }
  if (outline) {
    overlayCtx.strokeStyle = TEXT_WHITE;
    overlayCtx.lineWidth = 1;
    for (const [dr, dc] of offsets) {
      overlayCtx.strokeRect(
        (col + dc) * TILE_SIZE,
        (row + dr) * TILE_SIZE,
        TILE_SIZE,
        TILE_SIZE,
      );
    }
  }
  overlayCtx.restore();
}
