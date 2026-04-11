/**
 * Reinforced Walls upgrade — first hit on each wall is absorbed (wall survives
 * and is marked damaged; second hit destroys it normally).
 *
 * Hook implemented: shouldAbsorbWallHit (per-event gate during wall impacts).
 * Wired through src/game/upgrade-system.ts.
 */

import type { Player } from "../../shared/player-types.ts";
import { UID } from "../../shared/upgrade-defs.ts";

/** True when this wall tile should be absorbed rather than destroyed.
 *  Returns false if the player doesn't own the upgrade, or if this wall
 *  has already taken its one absorption (tracked in damagedWalls). */
export function reinforcedWallsShouldAbsorb(
  player: Player,
  tileKey: number,
): boolean {
  if (!player.upgrades.get(UID.REINFORCED_WALLS)) return false;
  return !player.damagedWalls.has(tileKey);
}
