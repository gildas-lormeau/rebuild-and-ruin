/**
 * Tower rendering — drawTowers layer and tower highlight overlay.
 */

import { drawSpriteCentered } from "./sprites.ts";
import { PLAYER_COLORS, PLAYER_NAMES } from "./player-config.ts";
import { TILE } from "./map-renderer.ts";
import type { MapData, RenderOverlay } from "./map-renderer.ts";

/** Draw a highlight selector around a tower position. */
function drawTowerHighlight(
  octx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  color?: string,
): void {
  const margin = 4;
  const bx = cx - 15 - margin;
  const by = cy - 16 - margin;
  const w = 30 + margin * 2;
  const h = 32 + margin * 2;
  const corner = 5;
  const t = 2; // thickness — matches UI border width

  octx.fillStyle = color ?? "#ffcc00";
  octx.fillRect(bx, by, corner, t);
  octx.fillRect(bx, by, t, corner);
  octx.fillRect(bx + w - corner, by, corner, t);
  octx.fillRect(bx + w - t, by, t, corner);
  octx.fillRect(bx, by + h - t, corner, t);
  octx.fillRect(bx, by + h - corner, t, corner);
  octx.fillRect(bx + w - corner, by + h - t, corner, t);
  octx.fillRect(bx + w - t, by + h - corner, t, corner);
}

/** Draw towers (alive, destroyed, highlighted, selected). */
export function drawTowers(
  octx: CanvasRenderingContext2D,
  map: MapData,
  overlay?: RenderOverlay,
): void {
  for (let i = 0; i < map.towers.length; i++) {
    const tower = map.towers[i]!;
    const cx = (tower.col + 1) * TILE;
    const cy = (tower.row + 1) * TILE;

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
        const c = PLAYER_COLORS[ownerId % PLAYER_COLORS.length]!.interiorLight;
        octx.save();
        octx.globalAlpha = 0.7;
        octx.font = "bold 14px sans-serif";
        octx.textAlign = "center";
        octx.textBaseline = "bottom";
        octx.fillStyle = `rgba(0,0,0,0.8)`;
        octx.fillText(name, cx, cy - 20);
        octx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
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
          const colors = PLAYER_COLORS[hl.playerId % PLAYER_COLORS.length]!;
          const rgb = hl.confirmed
            ? `rgb(${colors.interiorLight[0]},${colors.interiorLight[1]},${colors.interiorLight[2]})`
            : `rgb(${Math.min(255, colors.interiorLight[0] + 80)},${Math.min(255, colors.interiorLight[1] + 80)},${Math.min(255, colors.interiorLight[2] + 80)})`;
          drawTowerHighlight(octx, cx, cy, rgb);
        }
      }
    }
  }
}
