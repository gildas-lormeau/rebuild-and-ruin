/**
 * AI tactic — charity sweep. Volunteer cannons to clear grunts off an
 * enemy's territory when that enemy can't defend (too few usable cannons).
 * Borrows planGruntSweep for the per-enemy targeting.
 */

import type { TilePos } from "../shared/core/geometry-types.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import type { Rng } from "../shared/platform/rng.ts";
import { filterActiveEnemies } from "../shared/sim/board-occupancy.ts";
import { planGruntSweep } from "./ai-plan-grunt-sweep.ts";
import { countBatteryCannons } from "./ai-strategy-battle.ts";

/** Skip charity sweep if the enemy commands a bigger battery than this. Kept in
 *  step with `CHAIN_ATTACK_MIN_CANNONS`'s re-derivation (6 ready ≈ 7 battery)
 *  so "this enemy can't defend itself" keeps the same measured meaning. */
const CHARITY_CANNON_THRESHOLD = 7;

/** Plan a charity sweep: kill grunts on an enemy's territory when they can't.
 *  "Can't defend" means their BATTERY (`countBatteryCannons` — alive AND
 *  enclosed, reload ignored, the same measure every min-cannon gate uses): a
 *  fully-breached enemy with plenty of alive-but-unenclosed cannons is
 *  defenseless and receives charity, while an enemy who merely has balls in the
 *  air is not. Enemies are shuffled like the sibling plans, so the first needy
 *  enemy isn't always the lowest slot. */
export function planCharitySweep(
  state: BattleViewState,
  playerId: ValidPlayerId,
  usableCannonCount: number,
  rng: Rng,
  cursor: TilePos,
): TilePos[] | null {
  const enemies = filterActiveEnemies(state, playerId);
  rng.shuffle(enemies);
  for (const enemy of enemies) {
    if (countBatteryCannons(state, enemy.id) > CHARITY_CANNON_THRESHOLD)
      continue;
    const targets = planGruntSweep(state, enemy.id, usableCannonCount, cursor);
    if (targets) return targets;
  }
  return null;
}
