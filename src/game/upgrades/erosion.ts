import { isPlayerEliminated } from "../../shared/core/player-slot.ts";
import { sweepIsolatedWalls } from "../../shared/core/player-walls.ts";
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
