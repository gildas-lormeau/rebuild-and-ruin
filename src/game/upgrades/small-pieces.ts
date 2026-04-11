/**
 * Small Pieces upgrade — the picker's build bag draws from the
 * small-piece sub-pool for one round, making it easier to thread pieces
 * through narrow gaps. Read at build-phase start by the controller's
 * initBag hook (player/controller-types.ts).
 *
 * Hook implemented: useSmallPieces (controller query).
 * Wired through src/game/upgrade-system.ts.
 */

import type { Player } from "../../shared/core/player-types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";

/** True when this player owns Small Pieces this round. */
export function smallPiecesOwns(player: Player): boolean {
  return !!player.upgrades.get(UID.SMALL_PIECES);
}
