/**
 * Shield Battery upgrade — at battle start, every cannon entirely inside
 * the home-tower's enclosed region is marked shielded. Shielded cannons
 * ignore wall hits in their absorption radius (the rampart shield code
 * treats `shielded` and `isRampartCannon` symmetrically).
 *
 * Hook implemented: shieldBatteryElectAll (battle-phase-start election).
 * Wired through src/game/upgrade-system.ts. The home-region BFS is
 * injected by cannon-system to avoid an L5 → L6 import cycle.
 */

import { isPlayerEliminated, type Player } from "../../shared/player-types.ts";
import {
  cannonSize,
  isBalloonCannon,
  isCannonAlive,
  isRampartCannon,
  packTile,
} from "../../shared/spatial.ts";
import type { GameState } from "../../shared/types.ts";
import { UID } from "../../shared/upgrade-defs.ts";

/** Mark every cannon inside the home enclosed region as shielded.
 *  Skips dead cannons, balloons, and rampart cannons (which already
 *  carry their own shield mechanic). */
export function shieldBatteryElectAll(
  state: GameState,
  homeEnclosedRegion: (player: Player) => Set<number>,
): void {
  for (const player of state.players) {
    if (isPlayerEliminated(player)) continue;
    if (!player.upgrades.get(UID.SHIELD_BATTERY)) continue;
    if (!player.homeTower) continue;
    const region = homeEnclosedRegion(player);
    for (const cannon of player.cannons) {
      if (
        !isCannonAlive(cannon) ||
        isBalloonCannon(cannon) ||
        isRampartCannon(cannon)
      )
        continue;
      const sz = cannonSize(cannon.mode);
      let allInside = true;
      for (let dr = 0; dr < sz && allInside; dr++) {
        for (let dc = 0; dc < sz && allInside; dc++) {
          if (!region.has(packTile(cannon.row + dr, cannon.col + dc))) {
            allInside = false;
          }
        }
      }
      if (allInside) cannon.shielded = true;
    }
  }
}
