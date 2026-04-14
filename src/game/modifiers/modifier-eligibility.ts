/** Grace-period helpers for modifier targeting.
 *
 *  A player whose castle was just (re)built gets one battle of protection from
 *  modifier effects — `player.freshCastle` is set in finalizeReselectedPlayers
 *  and cleared in enterBuildFromBattle at end of the protected battle. These
 *  helpers centralize the "which zones/players can modifiers touch" rule so
 *  every modifier applies the same grace-period logic. */

import type { Tower } from "../../shared/core/geometry-types.ts";
import { isPlayerSeated, type Player } from "../../shared/core/player-types.ts";
import type { GameState } from "../../shared/core/types.ts";

type SeatedPlayer = Player & { homeTower: Tower };

/** Zones eligible for modifier effects this battle (see above). */
export function getModifierEligibleZones(state: GameState): number[] {
  return getModifierEligiblePlayers(state).map(
    (player) => player.homeTower.zone,
  );
}

/** Seated players eligible for modifier effects this battle.
 *  Excludes freshly-reselected players (one-battle grace period). */
export function getModifierEligiblePlayers(state: GameState): SeatedPlayer[] {
  return state.players
    .filter(isPlayerSeated)
    .filter((player) => !player.freshCastle);
}

/** Set of zones in a grace period — used for assertions in wall/zone mutators
 *  to surface modifier authors who forget to filter via the helpers above. */
export function getGraceCastleZones(state: GameState): ReadonlySet<number> {
  const zones = new Set<number>();
  for (const player of state.players) {
    if (!isPlayerSeated(player)) continue;
    if (player.freshCastle) zones.add(player.homeTower.zone);
  }
  return zones;
}
