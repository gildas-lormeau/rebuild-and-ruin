/**
 * Reinforced Walls upgrade — first hit on each wall is absorbed (wall survives
 * and is marked damaged; second hit destroys it normally).
 *
 * Hook implemented: shouldAbsorbWallHit (per-event gate during wall impacts).
 * Wired through src/game/upgrade-system.ts.
 */

import type { Player } from "../../shared/core/player-types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";
import type { UpgradeImpl } from "./upgrade-types.ts";

export const reinforcedWallsImpl: UpgradeImpl = { shouldAbsorbWallHit };

/** True when this wall tile should be absorbed rather than destroyed.
 *  Returns false if the player doesn't own the upgrade, or if this wall
 *  has already taken its one absorption (tracked in damagedWalls). */
function shouldAbsorbWallHit(player: Player, tileKey: number): boolean {
  if (!player.upgrades.get(UID.REINFORCED_WALLS)) return false;
  return !player.damagedWalls.has(tileKey);
}
