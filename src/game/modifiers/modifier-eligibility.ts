/** Fresh-castle protection helpers for modifier targeting. A player
 *  whose castle was just (re)built gets one battle of protection for the
 *  castle footprint (2x2 tower + castle-wall ring) — `inGracePeriod` is
 *  set in `confirmTowerSelection` and cleared in `finalizeBattle`. The
 *  protection is tile-scoped, not zone-scoped: surges
 *  and wildfire still apply elsewhere in the zone. */

import { TOWER_SIZE } from "../../shared/core/game-constants.ts";
import { isPlayerSeated } from "../../shared/core/player-types.ts";
import { packTile } from "../../shared/core/spatial.ts";
import type { GameState } from "../../shared/core/types.ts";
import type { ZoneId } from "../../shared/core/zone-id.ts";

/** Zones owned by a seated (non-eliminated) player. Modifiers that target
 *  territory (wildfire, dry lightning, sinkhole, grunt surge)
 *  must never mutate an eliminated player's zone. */
export function getActiveZones(state: GameState): ZoneId[] {
  const zones: ZoneId[] = [];
  for (const player of state.players) {
    if (!isPlayerSeated(player)) continue;
    zones.push(player.homeTower.zone);
  }
  return zones;
}

/** Tile keys covered by any fresh castle's 2x2 tower + castle-wall ring.
 *  Modifiers that place damage on tiles (wildfire, dry lightning, sinkhole)
 *  skip these; applyFireScar asserts it never touches one. */
export function getProtectedCastleTiles(state: GameState): ReadonlySet<number> {
  const protectedTiles = new Set<number>();
  for (const player of state.players) {
    if (!isPlayerSeated(player)) continue;
    if (!player.inGracePeriod) continue;
    for (const key of player.castleWallTiles) protectedTiles.add(key);
    const { row, col } = player.homeTower;
    for (let dr = 0; dr < TOWER_SIZE; dr++) {
      for (let dc = 0; dc < TOWER_SIZE; dc++) {
        protectedTiles.add(packTile(row + dr, col + dc));
      }
    }
  }
  return protectedTiles;
}
