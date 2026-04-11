/**
 * Demolition upgrade — strips every non-load-bearing wall from all players
 * at pick time. A wall is "inner" if none of its 8-dir neighbors are
 * outside (reachable from map edges) — enclosures stay intact and thick
 * walls get thinned to a single-tile shell. Can merge adjacent castles.
 *
 * Hook implemented: onPickApplied (per-entry side effect).
 * Wired through src/game/upgrade-system.ts. Uses deletePlayerWallsBatch
 * (skips markWallsDirty) — interior is rechecked at the next piece
 * placement or end-of-build via recheckTerritory.
 */

import { deletePlayerWallsBatch } from "../../shared/board-occupancy.ts";
import { isPlayerEliminated } from "../../shared/player-types.ts";
import {
  computeOutside,
  DIRS_8,
  packTile,
  unpackTile,
} from "../../shared/spatial.ts";
import type { GameState } from "../../shared/types.ts";
import { UID, type UpgradeId } from "../../shared/upgrade-defs.ts";

/** Strip non-load-bearing walls from all players when the picked upgrade
 *  is Demolition. No-op for any other upgrade. Idempotent — a second
 *  call finds no inner walls because the first call already removed them. */
export function demolitionOnPick(state: GameState, choice: UpgradeId): void {
  if (choice !== UID.DEMOLITION) return;
  for (const player of state.players) {
    if (isPlayerEliminated(player)) continue;
    if (player.walls.size === 0) continue;
    const outside = computeOutside(player.walls);
    const inner: number[] = [];
    for (const key of player.walls) {
      const { r, c } = unpackTile(key);
      let loadBearing = false;
      for (const [dr, dc] of DIRS_8) {
        if (outside.has(packTile(r + dr, c + dc))) {
          loadBearing = true;
          break;
        }
      }
      if (!loadBearing) inner.push(key);
    }
    if (inner.length > 0) deletePlayerWallsBatch(player, inner);
  }
}
