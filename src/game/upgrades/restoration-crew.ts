/**
 * Restoration Crew upgrade — one dead tower the player encloses this
 * build phase revives immediately instead of becoming pending.
 * Player-only, one-use (consumed after the instant revival fires).
 *
 * Hook implemented: restorationCrewInstantRevive (end-of-build tower revival).
 * Wired through src/game/upgrade-system.ts → build-system.ts.
 */

import type { Player } from "../../shared/core/player-types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";

/** If the player owns Restoration Crew, consume it and return true
 *  (caller should revive the tower immediately). Returns false when
 *  the upgrade is absent or already spent this round. */
export function restorationCrewInstantRevive(player: Player): boolean {
  if (!player.upgrades.get(UID.RESTORATION_CREW)) return false;
  player.upgrades.delete(UID.RESTORATION_CREW);
  return true;
}
