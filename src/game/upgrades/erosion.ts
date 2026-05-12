/**
 * Erosion upgrade — at pick time sweeps one layer of exposed walls
 * (≤1 orthogonal neighbor) from every alive player. Idempotent across
 * multiple pickers via a flag-count guard (each sweepIsolatedWalls peels
 * a layer; naive re-run would compound). Interior is rechecked by
 * `applyUpgradePicksFromDialog` after the entry batch resolves.
 */

import { sweepIsolatedWalls } from "../../shared/core/board-occupancy.ts";
import { isPlayerEliminated } from "../../shared/core/player-types.ts";
import type { GameState, UpgradeImpl } from "../../shared/core/types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";

export const erosionImpl: UpgradeImpl = { onPick };

function onPick(state: GameState): void {
  let pickerCount = 0;
  for (const player of state.players) {
    if (player.upgrades.get(UID.EROSION)) pickerCount++;
  }
  if (pickerCount > 1) return;

  for (const player of state.players) {
    if (isPlayerEliminated(player)) continue;
    if (player.walls.size === 0) continue;
    sweepIsolatedWalls(player);
  }
}
