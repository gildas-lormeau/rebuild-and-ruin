/**
 * Conscription upgrade — killed grunts have a chance to respawn on a random
 * enemy zone, keeping pressure on opponents.
 *
 * Hook implemented: onGruntKilled (query-style — returns a respawn target for
 * the caller to spawn, leaving spawn-position mechanics in battle-system).
 * Wired through src/game/upgrade-system.ts.
 */

import {
  BOARD_LOCAL_SITE,
  deriveBoardLocalSeed,
} from "../../shared/core/ai-seed.ts";
import type { ValidPlayerId } from "../../shared/core/player-slot.ts";
import { isPlayerSeated } from "../../shared/core/player-types.ts";
import type {
  ConscriptionRespawnTarget,
  GameState,
  UpgradeImpl,
} from "../../shared/core/types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";
import { Rng } from "../../shared/platform/rng.ts";

/** Probability that a killed grunt triggers a Conscription respawn. */
const CONSCRIPTION_SPAWN_CHANCE = 0.75;
export const conscriptionImpl: UpgradeImpl = { onGruntKilled };

/** Roll for a Conscription respawn after the shooter kills a grunt.
 *  Returns a victim anchor point, or null if the upgrade is inactive or the
 *  roll fails. R5b: fires a board-dependent number of times per battle (once
 *  per kill), so the bool + pick draw from a private Rng keyed by the dead
 *  grunt's tile — the shared cursor is never advanced here. */
function onGruntKilled(
  state: GameState,
  shooterId: ValidPlayerId,
  killedGruntTile: number,
): ConscriptionRespawnTarget | null {
  const shooter = state.players[shooterId];
  if (!shooter?.upgrades.get(UID.CONSCRIPTION)) return null;
  const localRng = new Rng(
    deriveBoardLocalSeed(
      state.rng.seed,
      state.round,
      BOARD_LOCAL_SITE.CONSCRIPTION_RESPAWN,
      killedGruntTile,
    ),
  );
  if (!localRng.bool(CONSCRIPTION_SPAWN_CHANCE)) return null;
  const enemies = state.players.filter(
    (player) => isPlayerSeated(player) && player.id !== shooterId,
  );
  if (enemies.length === 0) return null;
  const victim = localRng.pick(enemies);
  const home = victim.homeTower;
  if (!home) return null;
  return {
    victimId: victim.id,
    anchorRow: home.row,
    anchorCol: home.col,
  };
}
