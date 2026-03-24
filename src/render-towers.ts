/**
 * Tower rendering — drawTowers layer and tower highlight overlay.
 */

import { TILE_SIZE } from "./grid.ts";
import { getPlayerColor, PLAYER_NAMES } from "./player-config.ts";
import { FONT_FLOAT_LG, rgb, TOWER_FLASH_MS } from "./render-theme.ts";
import type { MapData, RenderOverlay } from "./render-types.ts";
import { drawSpriteCentered } from "./sprites.ts";

/** Draw towers (alive, destroyed, highlighted, selected). */
export function drawTowers(
  octx: CanvasRenderingContext2D,
  map: MapData,
  overlay?: RenderOverlay,
): void {
  for (let i = 0; i < map.towers.length; i++) {
    const tower = map.towers[i]!;
    const cx = (tower.col + 1) * TILE_SIZE;
    const cy = (tower.row + 1) * TILE_SIZE;

    const ownerId = overlay?.entities?.homeTowers?.get(i);
    const inBattle = !!overlay?.battle?.battleTerritory;
    const suffix = inBattle ? "_battle" : "";

    const alive = overlay?.entities?.towerAlive?.[i];
    if (alive !== undefined && !alive) {
      const debrisName =
        ownerId !== undefined
          ? `tower_debris_p${ownerId}${suffix}`
          : `tower_debris${suffix}`;
      drawSpriteCentered(octx, debrisName, cx, cy);
      continue;
    }

    if (overlay?.selection?.selected === i || ownerId !== undefined) {
      const homeName =
        ownerId !== undefined
          ? `tower_home_p${ownerId}${suffix}`
          : `tower_home_p0${suffix}`;
      drawSpriteCentered(octx, homeName, cx, cy);
      // Player name label above home tower (battle phase only, semi-transparent)
      if (ownerId !== undefined && inBattle) {
        const name = PLAYER_NAMES[ownerId] ?? `P${ownerId + 1}`;
        const c = getPlayerColor(ownerId).interiorLight;
        octx.save();
        octx.globalAlpha = 0.7;
        octx.font = FONT_FLOAT_LG;
        octx.textAlign = "center";
        octx.textBaseline = "bottom";
        octx.fillStyle = `rgba(0,0,0,0.8)`;
        octx.fillText(name, cx, cy - 20);
        octx.fillStyle = rgb(c);
        octx.fillText(name, cx - 0.5, cy - 20.5);
        octx.restore();
      }
    } else {
      drawSpriteCentered(octx, `tower_neutral${suffix}`, cx, cy);
    }

    if (overlay?.selection?.highlighted === i) {
      drawTowerHighlight(octx, cx, cy);
    }
    if (overlay?.selection?.highlights) {
      for (const hl of overlay.selection.highlights) {
        if (hl.towerIdx === i) {
          const c = getPlayerColor(hl.playerId).interiorLight;
          drawTowerHighlight(octx, cx, cy, rgb(c));
        }
      }
    }
  }
}
/** Draw a highlight selector around a tower position. */
function drawTowerHighlight(
  octx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  color?: string,
): void {
  const margin = 4 + TILE_SIZE / 2;
  const bx = cx - 15 - margin;
  const by = cy - 16 - margin;
  const w = 30 + margin * 2;
  const h = 32 + margin * 2;
  const corner = 10;
  const t = 4; // thickness

  // Slow flash: alpha pulses between 0.4 and 1.0 over ~1.5s cycle
  const flash = 0.7 + 0.3 * Math.sin(Date.now() / TOWER_FLASH_MS);
  octx.save();
  octx.globalAlpha = flash;
  octx.fillStyle = color ?? "#ffcc00";
  // Top-left
  octx.fillRect(bx, by, corner, t);
  octx.fillRect(bx, by + t, t, corner - t);
  // Top-right
  octx.fillRect(bx + w - corner, by, corner, t);
  octx.fillRect(bx + w - t, by + t, t, corner - t);
  // Bottom-left
  octx.fillRect(bx, by + h - t, corner, t);
  octx.fillRect(bx, by + h - corner, t, corner - t);
  // Bottom-right
  octx.fillRect(bx + w - corner, by + h - t, corner, t);
  octx.fillRect(bx + w - t, by + h - corner, t, corner - t);
  octx.restore();
}
