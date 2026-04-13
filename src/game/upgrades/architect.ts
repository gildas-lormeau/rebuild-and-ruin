/**
 * Architect upgrade — piece placements may overlap one own wall tile,
 * letting players weave new pieces through gaps in existing walls.
 *
 * Hook implemented: wallOverlapAllowance (piece-validation query).
 * Wired through src/game/upgrade-system.ts. Only affects own walls —
 * enemy walls still block placement unconditionally.
 */

import type { Player } from "../../shared/core/player-types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";
import type { UpgradeImpl } from "./upgrade-types.ts";

/** Number of own-wall tiles an Architect-owning player may overlap per piece. */
const ARCHITECT_OVERLAP_LIMIT = 1;
export const architectImpl: UpgradeImpl = { wallOverlapAllowance };

/** How many own-wall tiles this player is allowed to overlap in a single
 *  piece placement. Returns 0 when Architect is not owned. */
function wallOverlapAllowance(player: Player): number {
  return player.upgrades.get(UID.ARCHITECT) ? ARCHITECT_OVERLAP_LIMIT : 0;
}
