/**
 * Erosion upgrade — sweeps one layer of exposed walls (≤1 orthogonal
 * neighbor) from every alive player. Global, one-shot effect fired at
 * pick time. Mirrors the end-of-build debris sweep but runs during
 * UPGRADE_PICK so the next build phase starts from a slightly cleaner
 * board for everyone.
 *
 * Hook implemented: onPick (per-entry side effect).
 * Wired through src/game/upgrade-system.ts. Idempotent across multiple
 * pickers via a flag-count guard — only the first picker runs the sweep
 * (each `sweepIsolatedWalls` call peels a layer, so naive re-run would
 * compound). Interior is rechecked by `applyUpgradePicksFromDialog`
 * after the entry batch resolves, so the dirty flag set by the sweep
 * is honored before any reader.
 */

import { sweepIsolatedWalls } from "../../shared/core/board-occupancy.ts";
import { isPlayerEliminated } from "../../shared/core/player-types.ts";
import type { GameState } from "../../shared/core/types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";
import type { UpgradeImpl } from "./upgrade-types.ts";

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
