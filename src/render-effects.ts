/**
 * Visual effects rendering — impacts, cannonballs, balloons, burning pits,
 * crosshairs, phantoms, bonus squares, houses, grunts.
 */

import { TILE } from "./map-renderer.ts";
import { FONT_TIMER } from "./render-theme.ts";
import { facingToCardinal } from "./spatial.ts";
import { drawSprite } from "./sprites.ts";
import { PLAYER_COLORS } from "./player-config.ts";
import type { RenderOverlay, MapData } from "./map-renderer.ts";

import type { RGB } from "./render-theme.ts";

// Crosshair colors per player
const CROSSHAIR_COLORS: RGB[] = [
  [255, 50, 50], // P1 red
  [60, 130, 255], // P2 blue
  [255, 200, 30], // P3 gold
];

// ---------------------------------------------------------------------------
// Phantom rendering
// ---------------------------------------------------------------------------

/** Draw a semi-transparent cannon sprite as a placement phantom. */
function drawPhantomCannon(
  ctx: CanvasRenderingContext2D,
  row: number,
  col: number,
  valid: boolean,
  isSuper: boolean,
  isBalloon: boolean,
  facing = 0,
): void {
  const cx = col * TILE;
  const cy = row * TILE;
  const sz = isSuper ? 3 : 2;
  const s = TILE * sz;
  const mid = s / 2;

  ctx.globalAlpha = valid ? 0.7 : 0.5;

  if (isBalloon) {
    // Balloon base preview — sprite with red tint overlay if invalid
    ctx.globalAlpha = valid ? 0.7 : 0.5;
    drawSprite(ctx, "balloon_base", cx, cy);
    if (!valid) {
      ctx.fillStyle = "rgba(170, 34, 34, 0.4)";
      ctx.fillRect(cx, cy, s, s);
    }
    ctx.globalAlpha = 1.0;
    return;
  }

  // Draw actual cannon sprite at alpha, tinted red if invalid
  ctx.save();
  ctx.translate(cx + mid, cy + mid);
  ctx.rotate(facing);
  const tint = !valid;
  if (isSuper) {
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
  ctx.globalAlpha = 1.0;
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
    octx.fillRect((col + dc) * TILE, (row + dr) * TILE, TILE, TILE);
  }
  if (outline) {
    octx.strokeStyle = "#fff";
    octx.lineWidth = 1;
    for (const [dr, dc] of offsets) {
      octx.strokeRect((col + dc) * TILE, (row + dr) * TILE, TILE, TILE);
    }
  }
  octx.restore();
}

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
        !!phantom.isSuper,
        !!phantom.isBalloon,
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
      const wall = PLAYER_COLORS[playerId % PLAYER_COLORS.length]!.wall;
      const fill = valid ? `rgb(${wall[0]},${wall[1]},${wall[2]})` : "#aa2222";
      drawPiecePhantom(octx, offsets, row, col, fill, 0.55, true);
    }
  }

  // AI phantom piece previews
  if (overlay?.phantoms?.aiPhantoms) {
    for (const phantom of overlay.phantoms.aiPhantoms) {
      const { offsets, row, col, playerId } = phantom;
      const wall = PLAYER_COLORS[playerId % PLAYER_COLORS.length]!.wall;
      drawPiecePhantom(
        octx,
        offsets,
        row,
        col,
        `rgb(${wall[0]},${wall[1]},${wall[2]})`,
        0.6,
        true,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Map entities
// ---------------------------------------------------------------------------

/** Draw bonus squares (flashing green diamonds). */
export function drawBonusSquares(
  octx: CanvasRenderingContext2D,
  overlay?: RenderOverlay,
): void {
  if (!overlay?.entities?.bonusSquares || overlay.battle?.battleTerritory)
    return;
  const flash = Math.sin(Date.now() / 300) * 0.15 + 0.85;
  for (const bs of overlay.entities.bonusSquares) {
    const bx = bs.col * TILE;
    const by = bs.row * TILE;
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
    const hx = house.col * TILE;
    const hy = house.row * TILE;
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
    const gx = grunt.col * TILE;
    const gy = grunt.row * TILE;
    const angle = grunt.facing ?? 0;
    const dir = facingToCardinal(angle);
    drawSprite(octx, `grunt_${dir}`, gx, gy);
  }
}

// ---------------------------------------------------------------------------
// Water animation (battle phase only)
// ---------------------------------------------------------------------------

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
      const px = c * TILE;
      const py = r * TILE;

      // Three wave highlights drifting at different speeds across the tile
      for (let i = 0; i < 3; i++) {
        const phase =
          t * (0.8 + i * 0.3) +
          r * (0.5 + i * 0.2) +
          c * (0.3 + i * 0.15) +
          i * 2.1;
        const wave = Math.sin(phase) * 0.5 + 0.5;
        const alpha = 0.06 + wave * 0.09;
        const wy = py + 1 + Math.floor(wave * (TILE - 3));
        const wx = px + 1 + ((i * 3) % (TILE - 4));
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

// ---------------------------------------------------------------------------
// Battle effects
// ---------------------------------------------------------------------------

/** Draw impact flashes, cannonballs, balloons, burning pits, crosshairs, and timer. */
export function drawBattleEffects(
  octx: CanvasRenderingContext2D,
  map: MapData,
  overlay?: RenderOverlay,
): void {
  // Impact flashes
  if (overlay?.battle?.impacts) {
    for (const impact of overlay.battle.impacts) {
      const t = impact.age / 0.3; // 0→1 over IMPACT_FLASH_DURATION
      if (t >= 1) continue;
      const cx = impact.col * TILE + TILE / 2;
      const cy = impact.row * TILE + TILE / 2;
      const seed = impact.row * 41 + impact.col * 17;

      // Core flash — brief bright spot, shrinks quickly
      if (t < 0.25) {
        const coreAlpha = (1 - t / 0.25) * 0.6;
        const coreSize = TILE * (0.6 - t * 1.2);
        octx.globalAlpha = coreAlpha;
        octx.fillStyle = "#ffe0a0";
        octx.beginPath();
        octx.arc(cx, cy, Math.max(1, coreSize), 0, Math.PI * 2);
        octx.fill();
      }

      // Shockwave ring — expands outward
      if (t < 0.6) {
        const ringR = TILE * 0.5 + t * TILE;
        octx.globalAlpha = (1 - t / 0.6) * 0.7;
        octx.strokeStyle = "#ffcc44";
        octx.lineWidth = 2;
        octx.beginPath();
        octx.arc(cx, cy, ringR, 0, Math.PI * 2);
        octx.stroke();
      }

      // Debris sparks — 5 particles flying outward
      if (t < 0.8) {
        const sparkAlpha = 1 - t / 0.8;
        for (let i = 0; i < 5; i++) {
          const angle = (seed + i * 1.3) % (Math.PI * 2);
          const dist = t * (TILE * 0.8 + i * 3);
          const sx = cx + Math.cos(angle) * dist;
          const sy = cy + Math.sin(angle) * dist - t * 3;
          octx.globalAlpha = sparkAlpha * 0.9;
          octx.fillStyle = i % 2 === 0 ? "#ffaa30" : "#ff6600";
          octx.fillRect(sx - 1, sy - 1, 2, 2);
        }
      }

      // Smoke — dark puff rising, lingers in second half
      if (t > 0.2) {
        const smokeT = (t - 0.2) / 0.8;
        const smokeR = TILE * 0.4 + smokeT * TILE * 0.3;
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
    for (const pit of overlay.entities.burningPits) {
      const px = pit.col * TILE;
      const py = pit.row * TILE;
      const mid = TILE / 2;
      const flicker = Math.random() * 0.3;
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
        ? 0.7 + 0.3 * Math.sin(t * 16)
        : 0.35 + 0.15 * Math.sin(t * 4);
      const arm = ready ? 14 + Math.sin(t * 16) * 3 : 10;
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
    const jx = map.junction.x * TILE + TILE / 2;
    const jy = map.junction.y * TILE + TILE / 2;
    octx.save();
    octx.font = FONT_TIMER;
    octx.textAlign = "center";
    octx.textBaseline = "middle";
    octx.fillStyle = "rgba(0,0,0,0.6)";
    octx.fillText(text, jx + 1, jy + 1);
    octx.fillStyle = "#fff";
    octx.fillText(text, jx, jy);
    octx.restore();
  }
}
