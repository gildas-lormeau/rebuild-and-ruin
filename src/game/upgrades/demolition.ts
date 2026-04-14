/**
 * Demolition upgrade — strips every non-load-bearing wall from all players
 * at pick time. A wall is "inner" if none of its 8-dir neighbors are
 * outside (reachable from map edges) — enclosures stay intact and thick
 * walls get thinned to a single-tile shell. Can merge adjacent castles.
 *
 * Hook implemented: onPick (per-entry side effect).
 * Wired through src/game/upgrade-system.ts. Uses deletePlayerWallsBatch
 * (skips markWallsDirty) — interior is rechecked at the next piece
 * placement or end-of-build via recheckTerritory.
 */

import { isPlayerEliminated } from "../../shared/core/player-types.ts";
import { deletePlayerWallsBatch } from "../../shared/core/player-walls.ts";
import {
  computeOutside,
  DIRS_8,
  packTile,
  unpackTile,
} from "../../shared/core/spatial.ts";
import type { GameState } from "../../shared/core/types.ts";
import type { UpgradeImpl } from "./upgrade-types.ts";

export const demolitionImpl: UpgradeImpl = { onPick };

/** Strip non-load-bearing walls from all players. Idempotent — a second
 *  call finds no inner walls because the first call already removed them. */
function onPick(state: GameState): void {
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
