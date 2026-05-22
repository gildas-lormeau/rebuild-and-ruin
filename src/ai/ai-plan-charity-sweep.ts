/**
 * AI tactic — charity sweep. Volunteer cannons to clear grunts off an
 * enemy's territory when that enemy can't defend (too few usable cannons).
 * Borrows planGruntSweep for the per-enemy targeting.
 */

import { filterActiveFiringCannons } from "../game/index.ts";
import type { TilePos } from "../shared/core/geometry-types.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import type { Rng } from "../shared/platform/rng.ts";
import { planGruntSweep } from "./ai-plan-grunt-sweep.ts";

/** Skip charity sweep if the enemy has more usable cannons than this. */
const CHARITY_CANNON_THRESHOLD = 6;

/** Plan a charity sweep: kill grunts on an enemy's territory when they can't. */
export function planCharitySweep(
  state: BattleViewState,
  playerId: ValidPlayerId,
  usableCannonCount: number,
  rng: Rng,
): TilePos[] | null {
  for (const enemy of state.players) {
    if (enemy.id === playerId || isPlayerEliminated(enemy)) continue;
    if (filterActiveFiringCannons(enemy).length > CHARITY_CANNON_THRESHOLD)
      continue;
    const targets = planGruntSweep(state, enemy.id, usableCannonCount, rng);
    if (targets) return targets;
  }
  return null;
}
