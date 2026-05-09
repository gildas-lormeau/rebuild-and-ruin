/**
 * Small Pieces upgrade — the picker's build bag draws from the
 * small-piece sub-pool for one round, easing thread-the-gap placements.
 * Read at build-phase start by the controller's initBag hook
 * (player/controller-types.ts).
 */

import type { Player } from "../../shared/core/player-types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";
import type { UpgradeImpl } from "./upgrade-types.ts";

export const smallPiecesImpl: UpgradeImpl = { useSmallPieces };

/** True when this player owns Small Pieces this round. */
function useSmallPieces(player: Player): boolean {
  return !!player.upgrades.get(UID.SMALL_PIECES);
}
