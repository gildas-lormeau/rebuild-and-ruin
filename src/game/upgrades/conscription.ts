/**
 * Conscription upgrade — killed grunts have a chance to respawn on a random
 * enemy zone, keeping pressure on opponents.
 *
 * Hook implemented: onGruntKilled (query-style — returns a respawn target for
 * the caller to spawn, leaving spawn-position mechanics in battle-system).
 * Wired through src/game/upgrade-system.ts.
 */

import type { ValidPlayerSlot } from "../../shared/core/player-slot.ts";
import { isPlayerSeated } from "../../shared/core/player-types.ts";
import type { GameState } from "../../shared/core/types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";
import type {
  ConscriptionRespawnTarget,
  UpgradeImpl,
} from "./upgrade-types.ts";

/** Probability that a killed grunt triggers a Conscription respawn. */
const CONSCRIPTION_SPAWN_CHANCE = 0.75;
export const conscriptionImpl: UpgradeImpl = { onGruntKilled };

/** Roll for a Conscription respawn after the shooter kills a grunt.
 *  Returns a victim anchor point, or null if the upgrade is inactive or the
 *  roll fails. Consumes state.rng (bool + pick) only when Conscription owns. */
function onGruntKilled(
  state: GameState,
  shooterId: ValidPlayerSlot,
): ConscriptionRespawnTarget | null {
  const shooter = state.players[shooterId];
  if (!shooter?.upgrades.get(UID.CONSCRIPTION)) return null;
  if (!state.rng.bool(CONSCRIPTION_SPAWN_CHANCE)) return null;
  const enemies = state.players.filter(
    (player) => isPlayerSeated(player) && player.id !== shooterId,
  );
  if (enemies.length === 0) return null;
  const victim = state.rng.pick(enemies);
  const home = victim.homeTower;
  if (!home) return null;
  return {
    victimId: victim.id,
    anchorRow: home.row,
    anchorCol: home.col,
  };
}
