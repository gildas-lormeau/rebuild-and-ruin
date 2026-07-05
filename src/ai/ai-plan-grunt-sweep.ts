/**
 * AI tactic — grunt sweep. Chain-fires at enemy grunts attacking a specific
 * player, ordered by nearest neighbour from the shooter's crosshair. Used
 * both for self-defence and as the inner planner for the charity sweep
 * tactic.
 */

import { aimReachesTile } from "../game/index.ts";
import { MODIFIER_ID } from "../shared/core/game-constants.ts";
import type { TilePos } from "../shared/core/geometry-types.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import { orderByNearest, zoneAt } from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";

/** A sweep triggers only with MORE than this many grunts in the victim's
 *  zone (`<=` comparison — exactly 15 is still below the trigger). Lowered
 *  during grunt-heavy modifiers (grunt_surge, frozen_river) so the AI reacts
 *  sooner to the increased threat. */
const GRUNT_SWEEP_THRESHOLD = 15;
const GRUNT_SWEEP_THRESHOLD_MODIFIER = 8;

/** Plan a grunt sweep: chain-fire at enemy grunts attacking a specific player,
 *  ordered by nearest neighbor from the shooter's crosshair (`cursor`) — the
 *  sweep starts on the grunt closest to where the cursor already sits, so
 *  entering the chain costs no cross-map hop. The cursor seed also varies the
 *  walk per attacker (replacing the old rng-drawn random start).
 *  @param victimPlayerId — the player whose territory the grunts are attacking
 *    (the AI when called for our own defense; an enemy when called by
 *    `planCharitySweep` to clean up someone who can't fight back).
 *  Grunts are ownerless: "attacking the victim" means "currently sitting
 *  in the victim's zone", per the rule that grunts attack towers in
 *  their current territory. */
export function planGruntSweep(
  state: BattleViewState,
  victimPlayerId: ValidPlayerId,
  usableCannonCount: number,
  cursor: TilePos,
): TilePos[] | null {
  const victimZone = state.playerZones[victimPlayerId];
  const grunts = state.grunts.filter(
    (grunt) => zoneAt(state.map, grunt.row, grunt.col) === victimZone,
  );
  const mod = state.modern?.activeModifier;
  const threshold =
    mod === MODIFIER_ID.GRUNT_SURGE || mod === MODIFIER_ID.FROZEN_RIVER
      ? GRUNT_SWEEP_THRESHOLD_MODIFIER
      : GRUNT_SWEEP_THRESHOLD;
  if (grunts.length <= threshold) return null;
  // Threshold is a threat signal (count of attackers), but only sweep grunts we
  // can actually hit: a grunt hidden behind a camera-near wall would just
  // redirect the shot onto that wall (often our own perimeter or, in a charity
  // sweep, the beneficiary's wall). Skip them so cannons spend on real kills.
  const positions = grunts
    .filter((grunt) => aimReachesTile(state, grunt.row, grunt.col))
    .map((grunt) => ({ row: grunt.row, col: grunt.col }));
  if (positions.length === 0) return null;
  return orderByNearest(positions, usableCannonCount, cursor);
}
