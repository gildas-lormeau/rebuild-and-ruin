/**
 * Shield Battery upgrade — at battle start, every cannon entirely inside
 * the home-tower enclosed region is marked shielded; shielded cannons
 * ignore direct cannonball impacts (see `cannon.shielded` check in
 * battle-system's collectCannonImpacts). The home-region BFS is injected
 * by cannon-system to avoid an L5 → L6 import cycle.
 */

import {
  isBalloonCannon,
  isCannonAlive,
  isRampartCannon,
} from "../../shared/core/battle-types.ts";
import { isPlayerEliminated } from "../../shared/core/player-types.ts";
import { cannonSize, packTile } from "../../shared/core/spatial.ts";
import type {
  BattleStartCannonDeps,
  GameState,
  UpgradeImpl,
} from "../../shared/core/types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";

export const shieldBatteryImpl: UpgradeImpl = { onBattlePhaseStart };

/** Mark every cannon inside the home enclosed region as shielded.
 *  Skips dead cannons, balloons, and rampart cannons (which already
 *  carry their own shield mechanic). */
function onBattlePhaseStart(
  state: GameState,
  deps: BattleStartCannonDeps,
): void {
  for (const player of state.players) {
    if (isPlayerEliminated(player)) continue;
    if (!player.upgrades.get(UID.SHIELD_BATTERY)) continue;
    if (!player.homeTower) continue;
    const region = deps.homeEnclosedRegion(player);
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
