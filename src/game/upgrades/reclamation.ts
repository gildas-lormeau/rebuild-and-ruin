/**
 * Reclamation upgrade — clears every dead-cannon debris from the picker's
 * zone, freeing up those tiles for fresh placements in the next cannon
 * phase. Per-player effect fired at pick time.
 *
 * Hook implemented: onPickApplied (per-entry side effect).
 * Wired through src/game/upgrade-system.ts.
 */

import type { Player } from "../../shared/core/player-types.ts";
import { isCannonAlive } from "../../shared/core/spatial.ts";
import { UID, type UpgradeId } from "../../shared/core/upgrade-defs.ts";

/** Filter out dead cannons from the picker's cannon list when the picked
 *  upgrade is Reclamation. No-op for any other upgrade. */
export function reclamationOnPick(player: Player, choice: UpgradeId): void {
  if (choice !== UID.RECLAMATION) return;
  player.cannons = player.cannons.filter(isCannonAlive);
}
