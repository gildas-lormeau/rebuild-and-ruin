/**
 * Battle-start crosshair targeting — runtime-root primitive consumed by
 * the composition root (crosshair seeding at battle entry) and
 * `subsystems/camera.ts` (battle-entry zone anchor). The persisted
 * last-aimed position lives on `RuntimeState.lastBattleCrosshair`;
 * this module is pure policy over passed-in values.
 */

import type { GameMap, TilePos } from "../shared/core/geometry-types.ts";
import {
  bestEnemyZone,
  isPlayerEliminated,
  playerByZone,
} from "../shared/core/player-types.ts";
import { pxToTile, towerCenterPx, zoneAt } from "../shared/core/spatial.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";

/** Compute the crosshair target for battle start (touch devices).
 *  - If `lastPos` targets a living enemy, return it.
 *  - Otherwise aim at the best enemy's home tower.
 *  Returns null when no valid target exists. */
export function battleTargetPosition(
  players: readonly {
    eliminated: boolean;
    score: number;
    homeTower: TilePos | null;
  }[],
  playerZones: readonly ZoneId[],
  map: GameMap,
  myPid: number,
  lastPos: { x: number; y: number } | undefined,
): { x: number; y: number } | null {
  // Restore last position if targeted opponent is alive
  if (lastPos) {
    const row = pxToTile(lastPos.y);
    const col = pxToTile(lastPos.x);
    // `zoneAt` is bounds-safe and maps the water sentinel (0) to
    // undefined — equivalent to the historical raw-array read plus
    // its `!== 0` check.
    const zone = zoneAt(map, row, col);
    if (zone !== undefined) {
      const pid = playerByZone(playerZones, zone);
      if (
        pid !== undefined &&
        pid !== myPid &&
        !isPlayerEliminated(players[pid])
      ) {
        return { x: lastPos.x, y: lastPos.y };
      }
    }
  }

  // First battle or opponent died: aim at best enemy's home tower
  const zone = bestEnemyZone(players, playerZones, myPid);
  if (zone === null) return null;
  const pid = playerByZone(playerZones, zone);
  const tower = pid !== undefined ? players[pid]?.homeTower : null;
  if (!tower) return null;
  return towerCenterPx(tower);
}
