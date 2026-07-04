/**
 * AI tactic — minimum breach cut (`findMinBreach`). Drill the FEWEST live enemy
 * wall tiles that let the 8-dir enclosure flood reach a defended interior — a
 * diagonal staircase through a fat ring of ANY thickness. A backstop to
 * deny-enclosure (which now leads with the same min-cut): it catches the breach
 * for AIs whose deny roll didn't fire.
 */

import type { TilePos } from "../shared/core/geometry-types.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import type { Rng } from "../shared/platform/rng.ts";
import { filterActiveEnemies } from "../shared/sim/board-occupancy.ts";
import { findMinBreach } from "./ai-strategy-battle.ts";

/** Minimum walls an enemy must have to bother running a breach search. A real
 *  large-enclosure ring has far more than this; the floor only skips trivially
 *  walled players cheaply. */
const FAT_BREACH_MIN_WALLS = 9;
/** Max breach holes fired in a single chain (also the per-search cost cap). */
const MAX_FAT_BREACH_TARGETS = 8;

/** Plan a minimum-cut breach: the fewest enemy wall tiles to destroy so the
 *  8-dir flood breaches a large enclosure, ordered shell-first for chain
 *  execution. Returns null when no enemy has an intact large enclosure
 *  breachable within the cannon budget. */
export function planFatBreach(
  state: BattleViewState,
  playerId: ValidPlayerId,
  usableCannonCount: number,
  rng: Rng,
): TilePos[] | null {
  const enemies = filterActiveEnemies(state, playerId);
  rng.shuffle(enemies);
  const cap = Math.min(usableCannonCount, MAX_FAT_BREACH_TARGETS);

  for (const enemy of enemies) {
    if (enemy.walls.size < FAT_BREACH_MIN_WALLS) continue;
    const breach = findMinBreach(state, enemy, cap, rng);
    if (breach) return breach;
  }
  return null;
}
