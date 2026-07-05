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
import { countUsableCannons } from "./ai-strategy-battle.ts";

/** Skip charity sweep if the enemy has more usable cannons than this. */
const CHARITY_CANNON_THRESHOLD = 6;

/** Plan a charity sweep: kill grunts on an enemy's territory when they can't.
 *  "Can't defend" means usable cannons (alive AND enclosed — same
 *  `countUsableCannons` definition as everywhere else): a fully-breached
 *  enemy with plenty of alive-but-unenclosed cannons is defenseless and
 *  receives charity. Enemies are shuffled like the sibling plans, so the
 *  first needy enemy isn't always the lowest slot. */
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
    if (countUsableCannons(state, enemy.id) > CHARITY_CANNON_THRESHOLD)
      continue;
    const targets = planGruntSweep(state, enemy.id, usableCannonCount, cursor);
    if (targets) return targets;
  }
  return null;
}
