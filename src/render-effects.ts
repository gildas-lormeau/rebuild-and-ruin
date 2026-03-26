/**
 * Visual effects rendering — impacts, cannonballs, balloons, burning pits,
 * crosshairs, phantoms, bonus squares, houses, grunts.
 */

import { TILE_SIZE } from "./grid.ts";
import { getPlayerColor } from "./player-config.ts";
import { drawSprite } from "./render-sprites.ts";
import type { RGB } from "./render-theme.ts";
import {
  BONUS_FLASH_MS, CROSSHAIR_ARM_IDLE, CROSSHAIR_ARM_PULSE,
  CROSSHAIR_ARM_READY, CROSSHAIR_IDLE_FREQ,CROSSHAIR_READY_FREQ, FONT_TIMER,
  rgb, SHADOW_COLOR,
} from "./render-theme.ts";
import type { MapData, RenderOverlay } from "./render-types.ts";
import { facingToCardinal } from "./spatial.ts";
import { CannonMode, IMPACT_FLASH_DURATION } from "./types.ts";

// Spatial hash multipliers for per-tile visual noise
const SEED_ROW = 41;
const SEED_COL = 17;
// Impact animation phases (normalized 0–1 within IMPACT_FLASH_DURATION)
const IMPACT_CORE_END = 0.25;
const IMPACT_RING_END = 0.6;
const IMPACT_DEBRIS_END = 0.8;
const IMPACT_SMOKE_START = 0.2;
// Crosshair colors per player
const CROSSHAIR_COLORS: RGB[] = [
  [255, 50, 50], // P1 red
  [60, 130, 255], // P2 blue
  [255, 200, 30], // P3 gold
];

/** Draw phantom piece/cannon previews (AI and human). */
export function drawPhantoms(
  octx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
): void {
  // AI cannon phantoms
  if (overlay?.phantoms?.aiCannonPhantoms) {
    for (const phantom of overlay.phantoms.aiCannonPhantoms) {
      drawPhantomCannon(
        octx,
        phantom.row,
        phantom.col,
        phantom.valid,
        phantom.kind,
        phantom.facing ?? 0,
      );
    }
  }

  // Primary human phantom piece
  if (overlay?.phantoms?.phantomPiece) {
    const { offsets, row, col, valid } = overlay.phantoms.phantomPiece;
    drawPiecePhantom(
      octx,
      offsets,
      row,
      col,
      valid ? "#c8c0b8" : "#aa2222",
      0.5,
      false,
    );
  }

  // All human phantom pieces (multi-human build phase)
  if (overlay?.phantoms?.humanPhantoms) {
    for (const phantom of overlay.phantoms.humanPhantoms) {
      const { offsets, row, col, valid, playerId } = phantom;
      const wall = getPlayerColor(playerId).wall;
      const fill = valid ? rgb(wall) : "#aa2222";
      drawPiecePhantom(octx, offsets, row, col, fill, 0.55, true);
    }
  }

  // AI phantom piece previews
  if (overlay?.phantoms?.aiPhantoms) {
    for (const phantom of overlay.phantoms.aiPhantoms) {
      const { offsets, row, col, playerId } = phantom;
      const wall = getPlayerColor(playerId).wall;
      drawPiecePhantom(
        octx,
        offsets,
        row,
        col,
        rgb(wall),
        0.6,
        true,
      );
    }
  }
}

/** Draw bonus squares (flashing green diamonds). */
export function drawBonusSquares(
  octx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
  now?: number,
): void {
  if (!overlay?.entities?.bonusSquares || overlay.battle?.battleTerritory)
    return;
  const flash = Math.sin((now ?? Date.now()) / BONUS_FLASH_MS) * 0.15 + 0.85;
  for (const bs of overlay.entities.bonusSquares) {
    const bx = bs.col * TILE_SIZE;
    const by = bs.row * TILE_SIZE;
    octx.globalAlpha = flash;
    drawSprite(octx, "bonus_square", bx, by);
    octx.globalAlpha = 1.0;
  }
}

/** Draw houses (settler tents/huts). */
export function drawHouses(
  octx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.entities?.houses) return;
  for (const house of overlay.entities.houses) {
    if (!house.alive) continue;
    const hx = house.col * TILE_SIZE;
    const hy = house.row * TILE_SIZE;
    drawSprite(octx, "house", hx, hy);
  }
}

/** Draw grunts (little tanks, top-down, rotated to facing). */
export function drawGrunts(
  octx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.entities?.grunts) return;
  for (const grunt of overlay.entities.grunts) {
    const gx = grunt.col * TILE_SIZE;
    const gy = grunt.row * TILE_SIZE;
    const angle = grunt.facing ?? 0;
    const dir = facingToCardinal(angle);
    drawSprite(octx, `grunt_${dir}`, gx, gy);
  }
}

/** Draw animated wave shimmer over water tiles during battle. */
export function drawWaterAnimation(
  octx: CanvasRenderingContext2D,
  map: MapData,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.battle?.battleTerritory) return; // only during battle
  const t = performance.now() / 1000;
  const rows = map.tiles.length;
  const cols = map.tiles[0]!.length;

  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      if (map.tiles[r]![c] !== 1) continue; // 1 = water
      // Skip water tiles adjacent to grass (bank transition zone)
      if (
        map.tiles[r - 1]![c] !== 1 ||
        map.tiles[r + 1]![c] !== 1 ||
        map.tiles[r]![c - 1] !== 1 ||
        map.tiles[r]![c + 1] !== 1
      )
        continue;
      const px = c * TILE_SIZE;
      const py = r * TILE_SIZE;

      // Three wave highlights drifting at different speeds across the tile
      for (let i = 0; i < 3; i++) {
        const phase =
          t * (0.8 + i * 0.3) +
          r * (0.5 + i * 0.2) +
          c * (0.3 + i * 0.15) +
          i * 2.1;
        const wave = Math.sin(phase) * 0.5 + 0.5;
        const alpha = 0.06 + wave * 0.09;
        const wy = py + 1 + Math.floor(wave * (TILE_SIZE - 3));
        const wx = px + 1 + ((i * 3) % (TILE_SIZE - 4));
        const wLen = 3 + Math.floor(wave * 4);
        octx.fillStyle = `rgba(140, 200, 255, ${alpha})`;
        octx.fillRect(wx, wy, wLen, 1);
        // Shadow line below
        octx.fillStyle = `rgba(20, 60, 120, ${alpha * 0.5})`;
        octx.fillRect(wx, wy + 1, wLen, 1);
      }
    }
  }
}

/** Draw impact flashes, cannonballs, balloons, burning pits, crosshairs, and timer. */
export function drawBattleEffects(
  octx: CanvasRenderingContext2D,
  map: MapData,
  overlay?: RenderOverlay,
): void {
  // Impact flashes
  if (overlay?.battle?.impacts) {
    for (const impact of overlay.battle.impacts) {
      const t = impact.age / IMPACT_FLASH_DURATION;
      if (t >= 1) continue;
      const cx = impact.col * TILE_SIZE + TILE_SIZE / 2;
      const cy = impact.row * TILE_SIZE + TILE_SIZE / 2;
      const seed = impact.row * SEED_ROW + impact.col * SEED_COL;

      // Core flash — brief bright spot, shrinks quickly
      if (t < IMPACT_CORE_END) {
        const coreAlpha = (1 - t / IMPACT_CORE_END) * 0.6;
        const coreSize = TILE_SIZE * (0.6 - t * 1.2);
        octx.globalAlpha = coreAlpha;
        octx.fillStyle = "#ffe0a0";
        octx.beginPath();
        octx.arc(cx, cy, Math.max(1, coreSize), 0, Math.PI * 2);
        octx.fill();
      }

      // Shockwave ring — expands outward
      if (t < IMPACT_RING_END) {
        const ringR = TILE_SIZE * 0.5 + t * TILE_SIZE;
        octx.globalAlpha = (1 - t / IMPACT_RING_END) * 0.7;
        octx.strokeStyle = "#ffcc44";
        octx.lineWidth = 2;
        octx.beginPath();
        octx.arc(cx, cy, ringR, 0, Math.PI * 2);
        octx.stroke();
      }

      // Debris sparks — 5 particles flying outward
      if (t < IMPACT_DEBRIS_END) {
        const sparkAlpha = 1 - t / IMPACT_DEBRIS_END;
        for (let i = 0; i < 5; i++) {
          const angle = (seed + i * 1.3) % (Math.PI * 2);
          const dist = t * (TILE_SIZE * 0.8 + i * 3);
          const sx = cx + Math.cos(angle) * dist;
          const sy = cy + Math.sin(angle) * dist - t * 3;
          octx.globalAlpha = sparkAlpha * 0.9;
          octx.fillStyle = i % 2 === 0 ? "#ffaa30" : "#ff6600";
          octx.fillRect(sx - 1, sy - 1, 2, 2);
        }
      }

      // Smoke — dark puff rising, lingers in second half
      if (t > IMPACT_SMOKE_START) {
        const smokeT = (t - IMPACT_SMOKE_START) / (1 - IMPACT_SMOKE_START);
        const smokeR = TILE_SIZE * 0.4 + smokeT * TILE_SIZE * 0.3;
        octx.globalAlpha = (1 - smokeT) * 0.35;
        octx.fillStyle = "#3a3028";
        octx.beginPath();
        octx.arc(cx, cy - smokeT * 4, smokeR, 0, Math.PI * 2);
        octx.fill();
      }

      octx.globalAlpha = 1.0;
    }
  }

  // Cannonballs in flight
  if (overlay?.battle?.cannonballs) {
    for (const ball of overlay.battle.cannonballs) {
      const height = Math.sin(ball.progress * Math.PI);
      const radius = 3 + height * 2;
      octx.fillStyle = ball.incendiary ? "#c22" : "#111";
      octx.beginPath();
      octx.arc(ball.x, ball.y, radius, 0, Math.PI * 2);
      octx.fill();
    }
  }

  // In-flight propaganda balloons
  if (overlay?.battle?.balloons) {
    for (const b of overlay.battle.balloons) {
      const t = b.progress;
      const radius = 8;
      const basketOffset = radius + 9; // envelope center to basket center
      // Interpolate so the basket (not envelope) arrives at the target center
      const cx = b.x + (b.targetX - b.x) * t;
      const cy =
        b.y + (b.targetY - basketOffset - b.y) * t - Math.sin(t * Math.PI) * 40;
      // Balloon envelope (main body — red)
      octx.fillStyle = "#b03030";
      octx.beginPath();
      octx.ellipse(cx, cy - 1, radius, radius + 2, 0, 0, Math.PI * 2);
      octx.fill();
      // Highlight (specular)
      octx.fillStyle = "rgba(220, 120, 120, 0.5)";
      octx.beginPath();
      octx.ellipse(cx - 2, cy - 4, 3, 4, -0.3, 0, Math.PI * 2);
      octx.fill();
      // Panel seams
      octx.strokeStyle = "#802020";
      octx.lineWidth = 0.5;
      octx.beginPath();
      octx.moveTo(cx, cy - radius - 1);
      octx.lineTo(cx, cy + radius + 1);
      octx.stroke();
      octx.beginPath();
      octx.moveTo(cx - radius, cy);
      octx.lineTo(cx + radius, cy);
      octx.stroke();
      // Envelope outline
      octx.strokeStyle = "#601818";
      octx.lineWidth = 1;
      octx.beginPath();
      octx.ellipse(cx, cy - 1, radius, radius + 2, 0, 0, Math.PI * 2);
      octx.stroke();
      // Ropes (two angled lines from envelope base to basket)
      octx.strokeStyle = "#6a5a3a";
      octx.lineWidth = 0.7;
      octx.beginPath();
      octx.moveTo(cx - 3, cy + radius + 1);
      octx.lineTo(cx - 2, cy + radius + 7);
      octx.stroke();
      octx.beginPath();
      octx.moveTo(cx + 3, cy + radius + 1);
      octx.lineTo(cx + 2, cy + radius + 7);
      octx.stroke();
      // Basket (wicker)
      octx.fillStyle = "#8b6914";
      octx.fillRect(cx - 3, cy + radius + 7, 6, 4);
      octx.fillStyle = "#a07a1a";
      octx.fillRect(cx - 2, cy + radius + 8, 4, 2);
      // Basket rim
      octx.fillStyle = "#6a4a0a";
      octx.fillRect(cx - 3, cy + radius + 7, 6, 1);
    }
  }

  // Burning pits
  if (overlay?.entities?.burningPits) {
    const t = performance.now() / 1000;
    for (const pit of overlay.entities.burningPits) {
      const px = pit.col * TILE_SIZE;
      const py = pit.row * TILE_SIZE;
      const mid = TILE_SIZE / 2;
      const flicker = (Math.sin(t * 8 + pit.row * SEED_ROW + pit.col * SEED_COL) + 1) * 0.15;
      const stage = Math.max(1, Math.min(3, pit.roundsLeft));
      drawSprite(octx, `burning_pit_${stage}`, px, py);
      // Animated lava flicker (round glow, stronger for fresh pits)
      if (stage >= 2) {
        const intensity = stage === 3 ? 1.0 : 0.5;
        const emberR = 180 + Math.floor(flicker * 75);
        const emberG = 60 + Math.floor(flicker * 40);
        const radius = stage === 3 ? 4 : 3;
        octx.fillStyle = `rgba(${emberR}, ${emberG}, 0, ${(0.15 + flicker * 0.3) * intensity})`;
        octx.beginPath();
        octx.arc(px + mid, py + mid, radius, 0, Math.PI * 2);
        octx.fill();
      }
    }
  }

  // Crosshairs (all players)
  if (overlay?.battle?.crosshairs) {
    const t = performance.now() / 1000;
    for (const ch of overlay.battle.crosshairs) {
      const cx = Math.round(ch.x) + 0.5;
      const cy = Math.round(ch.y) + 0.5;
      const [cr, cg, cb] =
        CROSSHAIR_COLORS[ch.playerId % CROSSHAIR_COLORS.length]!;
      const ready = ch.cannonReady === true;
      const alpha = ready
        ? 0.7 + 0.3 * Math.sin(t * CROSSHAIR_READY_FREQ)
        : 0.35 + 0.15 * Math.sin(t * CROSSHAIR_IDLE_FREQ);
      const arm = ready
        ? CROSSHAIR_ARM_READY + Math.sin(t * CROSSHAIR_READY_FREQ) * CROSSHAIR_ARM_PULSE
        : CROSSHAIR_ARM_IDLE;
      const diag = Math.round(arm * 0.7);
      const gap = ready ? 5 : 3;

      const drawArm = (
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        color: string,
      ) => {
        octx.strokeStyle = `rgba(0,0,0,${alpha * 0.8})`;
        octx.lineWidth = 5;
        octx.beginPath();
        octx.moveTo(x1, y1);
        octx.lineTo(x2, y2);
        octx.stroke();
        octx.strokeStyle = color;
        octx.lineWidth = 2;
        octx.beginPath();
        octx.moveTo(x1, y1);
        octx.lineTo(x2, y2);
        octx.stroke();
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

  // Phase timer at river junction
  if (overlay?.ui?.timer != null && overlay.ui.timer >= 0) {
    const secs = Math.max(0, Math.ceil(overlay.ui.timer) - 1);
    const text = `${secs}`;
    const jx = map.junction.x * TILE_SIZE + TILE_SIZE / 2;
    const jy = map.junction.y * TILE_SIZE + TILE_SIZE / 2;
    octx.save();
    octx.font = FONT_TIMER;
    octx.textAlign = "center";
    octx.textBaseline = "middle";
    octx.fillStyle = SHADOW_COLOR;
    octx.fillText(text, jx + 1, jy + 1);
    octx.fillStyle = "#fff";
    octx.fillText(text, jx, jy);
    octx.restore();
  }
}

/** Draw a semi-transparent cannon sprite as a placement phantom. */
function drawPhantomCannon(
  ctx: CanvasRenderingContext2D,
  row: number,
  col: number,
  valid: boolean,
  kind: string,
  facing = 0,
): void {
  const cx = col * TILE_SIZE;
  const cy = row * TILE_SIZE;
  const sz = kind === CannonMode.SUPER ? 3 : 2;
  const s = TILE_SIZE * sz;
  const mid = s / 2;

  ctx.save();
  ctx.globalAlpha = valid ? 0.7 : 0.5;

  if (kind === CannonMode.BALLOON) {
    // Balloon base preview — sprite with red tint overlay if invalid
    drawSprite(ctx, "balloon_base", cx, cy);
    if (!valid) {
      ctx.fillStyle = "rgba(170, 34, 34, 0.4)";
      ctx.fillRect(cx, cy, s, s);
    }
    ctx.restore();
    return;
  }

  // Draw actual cannon sprite at alpha, tinted red if invalid
  ctx.translate(cx + mid, cy + mid);
  ctx.rotate(facing);
  const tint = !valid;
  if (kind === CannonMode.SUPER) {
    // Super gun phantom — symmetric around (0,0)
    ctx.fillStyle = tint ? "#3a1111" : "#1a1a1a";
    ctx.fillRect(-14, -8, 28, 24);
    ctx.fillStyle = tint ? "#553333" : "#333";
    ctx.fillRect(-18, -6, 5, 11);
    ctx.fillRect(13, -6, 5, 11);
    ctx.fillStyle = tint ? "#4a2222" : "#2a2a2a";
    ctx.fillRect(-16, -2, 32, 2);
    ctx.fillStyle = tint ? "#884444" : "#444";
    ctx.fillRect(-4, -18, 8, 27);
    ctx.fillStyle = tint ? "#331111" : "#111";
    ctx.fillRect(-1, -18, 2, 3);
    ctx.fillStyle = tint ? "#cc4444" : "#a33";
    ctx.fillRect(-5, -11, 10, 2);
    ctx.fillRect(-5, -5, 10, 2);
  } else {
    // Normal cannon phantom — symmetric around (0,0)
    ctx.fillStyle = tint ? "#3a1111" : "#1a1a1a";
    ctx.fillRect(-10, -5, 20, 16);
    ctx.fillStyle = tint ? "#553333" : "#333";
    ctx.fillRect(-12, -3, 4, 8);
    ctx.fillRect(8, -3, 4, 8);
    ctx.fillStyle = tint ? "#4a2222" : "#2a2a2a";
    ctx.fillRect(-10, 0, 20, 2);
    ctx.fillStyle = tint ? "#884444" : "#555";
    ctx.fillRect(-2, -11, 4, 17);
    ctx.fillStyle = tint ? "#331111" : "#111";
    ctx.fillRect(-1, -11, 2, 2);
    ctx.fillStyle = tint ? "#aa4444" : "#777";
    ctx.fillRect(-3, -6, 6, 2);
  }
  ctx.restore();
}

/** Draw a single phantom piece (fill + optional outline). */
function drawPiecePhantom(
  octx: CanvasRenderingContext2D,
  offsets: [number, number][],
  row: number,
  col: number,
  fillColor: string,
  alpha: number,
  outline: boolean,
): void {
  octx.save();
  octx.globalAlpha = alpha;
  octx.fillStyle = fillColor;
  for (const [dr, dc] of offsets) {
    octx.fillRect((col + dc) * TILE_SIZE, (row + dr) * TILE_SIZE, TILE_SIZE, TILE_SIZE);
  }
  if (outline) {
    octx.strokeStyle = "#fff";
    octx.lineWidth = 1;
    for (const [dr, dc] of offsets) {
      octx.strokeRect((col + dc) * TILE_SIZE, (row + dr) * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
  }
  octx.restore();
}
