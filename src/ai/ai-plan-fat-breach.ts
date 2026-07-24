/**
 * AI tactic — minimum breach cut (`findMinBreach`). Drill the FEWEST live enemy
 * wall tiles that let the 8-dir enclosure flood reach a defended interior — a
 * diagonal staircase through a fat ring of ANY thickness. A backstop to
 * deny-enclosure (which now leads with the same min-cut): it catches the breach
 * for AIs whose deny roll didn't fire.
 */

import type { TilePos } from "../shared/core/geometry-types.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import { orderByNearest } from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import type { Rng } from "../shared/platform/rng.ts";
import { filterActiveEnemies } from "../shared/sim/board-occupancy.ts";
import { findMinBreach, leadWithEnemy } from "./ai-strategy-battle.ts";

/** Minimum walls an enemy must have to bother running a breach search. A real
 *  large-enclosure ring has far more than this; the floor only skips trivially
 *  walled players cheaply. */
const FAT_BREACH_MIN_WALLS = 9;
/** Max breach holes fired in a single chain (also the per-search cost cap). */
const MAX_FAT_BREACH_TARGETS = 8;

/** Plan a minimum-cut breach: the fewest enemy wall tiles to destroy so the
 *  8-dir flood breaches a large enclosure, fired as a nearest-neighbour walk
 *  from the shooter's crosshair. The scan leads with the battle's sticky victim
 *  (`preferredEnemyId` — keeps the crosshair on one castle), shuffled rest.
 *  Returns null when no enemy has an intact large enclosure breachable
 *  within the cannon budget. */
export function planFatBreach(
  state: BattleViewState,
  playerId: ValidPlayerId,
  usableCannonCount: number,
  rng: Rng,
  cursor: TilePos,
  preferredEnemyId: ValidPlayerId | undefined,
): TilePos[] | null {
  const enemies = filterActiveEnemies(state, playerId);
  rng.shuffle(enemies);
  leadWithEnemy(enemies, preferredEnemyId);
  const cap = Math.min(usableCannonCount, MAX_FAT_BREACH_TARGETS);

  for (const enemy of enemies) {
    if (enemy.walls.size < FAT_BREACH_MIN_WALLS) continue;
    const breach = findMinBreach(state, enemy, cap, rng, cursor);
    // Fire the cut as a nearest-neighbour walk seeded at the live crosshair,
    // like every other `findMinBreach` consumer (deny / pinch / max-repair /
    // grunt-breach). `findMinBreach` returns each ring's cut shell-first and
    // concatenates rings, so entering the list at index 0 can mean a cross-map
    // glide to the far end of a staircase — and the crosshair glides at bounded
    // speed, so that hop directly costs shots. Cut membership is unchanged;
    // only the firing order is.
    if (breach) return orderByNearest(breach, undefined, cursor);
  }
  return null;
}
