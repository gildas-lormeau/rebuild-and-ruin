/**
 * Demolition upgrade — at pick time strips every non-load-bearing wall
 * from all players (a wall is inner when none of its 8-dir neighbors are
 * outside). Enclosures stay intact, thick walls thin to a single shell,
 * and adjacent castles can merge. Uses deletePlayerWallsBatch (skips
 * markWallsDirty) — interior is rechecked at the next piece placement
 * or end-of-build via recheckTerritory.
 */

import type { TileKey } from "../../shared/core/grid.ts";
import { isPlayerEliminated } from "../../shared/core/player-slot.ts";
import {
  computeOutside,
  DIRS_8,
  inBounds,
  packTile,
  unpackTile,
} from "../../shared/core/spatial.ts";
import type { GameState, UpgradeImpl } from "../../shared/core/types.ts";
import { deletePlayerWallsBatch } from "../../shared/sim/player-walls.ts";

export const demolitionImpl: UpgradeImpl = { onPick };

/** Strip non-load-bearing walls from all players. Idempotent — a second
 *  call finds no inner walls because the first call already removed them. */
function onPick(state: GameState): void {
  for (const player of state.players) {
    if (isPlayerEliminated(player)) continue;
    if (player.walls.size === 0) continue;
    const outside = computeOutside(player.walls);
    const inner: TileKey[] = [];
    for (const key of player.walls) {
      const { row, col } = unpackTile(key);
      let loadBearing = false;
      for (const [dr, dc] of DIRS_8) {
        const nr = row + dr,
          nc = col + dc;
        if (!inBounds(nr, nc) || outside.has(packTile(nr, nc))) {
          loadBearing = true;
          break;
        }
      }
      if (!loadBearing) inner.push(key);
    }
    if (inner.length > 0) deletePlayerWallsBatch(player, inner);
  }
}
