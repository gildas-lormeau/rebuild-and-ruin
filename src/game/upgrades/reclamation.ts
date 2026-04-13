/**
 * Reclamation upgrade — clears every dead-cannon debris from the picker's
 * zone, freeing up those tiles for fresh placements in the next cannon
 * phase. Per-player effect fired at pick time.
 *
 * Hook implemented: onPick (per-entry side effect).
 * Wired through src/game/upgrade-system.ts.
 */

import type { Player } from "../../shared/core/player-types.ts";
import { isCannonAlive } from "../../shared/core/spatial.ts";
import type { GameState } from "../../shared/core/types.ts";
import type { UpgradeImpl } from "./upgrade-types.ts";

export const reclamationImpl: UpgradeImpl = { onPick };

/** Filter out dead cannons from the picker's cannon list. */
function onPick(_state: GameState, player: Player): void {
  player.cannons = player.cannons.filter(isCannonAlive);
}
