/**
 * Tower rendering — drawTowers layer and tower highlight overlay.
 */

import { TILE_SIZE } from "./grid.ts";
import { getPlayerColor, PLAYER_NAMES } from "./player-config.ts";
import { drawSpriteCentered } from "./render-sprites.ts";
import {
  FONT_FLOAT_LG,
  rgb,
  SHADOW_COLOR_DENSE,
  TEXT_ALIGN_CENTER,
  TOWER_FLASH_MS,
} from "./render-theme.ts";
import type { MapData, RenderOverlay } from "./render-types.ts";
import { towerCenterPx } from "./spatial.ts";

/** Draw towers (alive, destroyed, highlighted, selected). */
export function drawTowers(
  overlayCtx: CanvasRenderingContext2D,
  map: MapData,
  overlay?: RenderOverlay,
  now?: number,
): void {
  for (let i = 0; i < map.towers.length; i++) {
    const tower = map.towers[i]!;
    const { x: cx, y: cy } = towerCenterPx(tower);

    const ownerId = overlay?.entities?.homeTowers?.get(i);
    const inBattle = !!overlay?.battle?.battleTerritory;
    const suffix = inBattle ? "_battle" : "";

    const alive = overlay?.entities?.towerAlive?.[i];
    if (alive !== undefined && !alive) {
      const debrisName =
        ownerId !== undefined
          ? `tower_debris_p${ownerId}${suffix}`
          : `tower_debris${suffix}`;
      drawSpriteCentered(overlayCtx, debrisName, cx, cy);
      continue;
    }

    if (overlay?.selection?.selected === i || ownerId !== undefined) {
      const homeName =
        ownerId !== undefined
          ? `tower_home_p${ownerId}${suffix}`
          : `tower_home_p0${suffix}`;
      drawSpriteCentered(overlayCtx, homeName, cx, cy);
      // Player name label above home tower (battle phase only, semi-transparent)
      if (ownerId !== undefined && inBattle) {
        const name = PLAYER_NAMES[ownerId] ?? `P${ownerId + 1}`;
        const c = getPlayerColor(ownerId).interiorLight;
        overlayCtx.save();
        overlayCtx.globalAlpha = 0.7;
        overlayCtx.font = FONT_FLOAT_LG;
        overlayCtx.textAlign = TEXT_ALIGN_CENTER;
        overlayCtx.textBaseline = "bottom";
        overlayCtx.fillStyle = SHADOW_COLOR_DENSE;
        overlayCtx.fillText(name, cx, cy - 20);
        overlayCtx.fillStyle = rgb(c);
        overlayCtx.fillText(name, cx - 0.5, cy - 20.5);
        overlayCtx.restore();
      }
    } else {
      drawSpriteCentered(overlayCtx, `tower_neutral${suffix}`, cx, cy);
    }

    if (overlay?.selection?.highlighted === i) {
      drawTowerHighlight(overlayCtx, cx, cy, undefined, now);
    }
    if (overlay?.selection?.highlights) {
      for (const hl of overlay.selection.highlights) {
        if (hl.towerIdx === i) {
          const c = getPlayerColor(hl.playerId).interiorLight;
          drawTowerHighlight(overlayCtx, cx, cy, rgb(c), now);
        }
      }
    }
  }
}

/** Draw a highlight selector around a tower position. */
function drawTowerHighlight(
  overlayCtx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  color?: string,
  now?: number,
): void {
  const margin = 4 + TILE_SIZE / 2;
  const bx = cx - 15 - margin;
  const by = cy - 16 - margin;
  const w = 30 + margin * 2;
  const h = 32 + margin * 2;
  const corner = 10;
  const thickness = 4;

  // Slow flash: alpha pulses between 0.4 and 1.0 over ~1.5s cycle
  const flash = 0.7 + 0.3 * Math.sin((now ?? Date.now()) / TOWER_FLASH_MS);
  overlayCtx.save();
  overlayCtx.globalAlpha = flash;
  overlayCtx.fillStyle = color ?? "#ffcc00";
  // Top-left
  overlayCtx.fillRect(bx, by, corner, thickness);
  overlayCtx.fillRect(bx, by + thickness, thickness, corner - thickness);
  // Top-right
  overlayCtx.fillRect(bx + w - corner, by, corner, thickness);
  overlayCtx.fillRect(
    bx + w - thickness,
    by + thickness,
    thickness,
    corner - thickness,
  );
  // Bottom-left
  overlayCtx.fillRect(bx, by + h - thickness, corner, thickness);
  overlayCtx.fillRect(bx, by + h - corner, thickness, corner - thickness);
  // Bottom-right
  overlayCtx.fillRect(bx + w - corner, by + h - thickness, corner, thickness);
  overlayCtx.fillRect(
    bx + w - thickness,
    by + h - corner,
    thickness,
    corner - thickness,
  );
  overlayCtx.restore();
}
