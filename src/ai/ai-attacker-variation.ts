/**
 * Per-attacker variation for structural breach plans. The cut planners
 * (`findMinBreach`, `selectExposedBreach`) are pure functions of the TARGET's
 * geometry, and all AI slots share the one lockstep `state.rng` — so two players
 * sieging the same ring would fire an identical, lockstep tile sequence (visibly
 * cloned AI). Rotating the firing order by a per-attacker offset breaks that:
 * each slot starts the breach at a different tile.
 */

import type { TilePos } from "../shared/core/geometry-types.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";

/** The fixed slot cap (Red / Blue / Gold). Used as the divisor that spreads
 *  attacker start points evenly across a breach; a constant — not the live
 *  player count — so a slot's offset is stable regardless of who's eliminated. */
const MAX_SLOTS = 3;

/** Rotate a breach's firing order so each slot STARTS at a different tile, by
 *  spreading the start point across the cut by slot id: slot s begins at
 *  `floor(s * len / MAX_SLOTS)`. With ≤3 slots and a cut of ≥3 tiles those
 *  starts are always distinct (e.g. len 9 → slots start at 0 / 3 / 6), so two
 *  attackers of one ring never fire the same tile on the same tick. Deterministic
 *  (no rng) so it's identical across mirrored sims and never collapses two slots
 *  onto the same offset the way an rng-jittered offset can. Rotation, NOT
 *  shuffle: it preserves the nearest-neighbour contiguity the planner built —
 *  consecutive shots still concentrate into one breach — while moving where each
 *  attacker begins (so under a per-chain cannon budget the slots also bite
 *  different SUBSETS of a long cut). Cuts of ≤2 tiles are returned unrotated. */
export function rotateBreachForAttacker(
  tiles: readonly TilePos[],
  playerId: ValidPlayerId,
): TilePos[] {
  if (tiles.length <= 2) return [...tiles];
  const offset = Math.floor((playerId * tiles.length) / MAX_SLOTS);
  if (offset === 0) return [...tiles];
  return [...tiles.slice(offset), ...tiles.slice(0, offset)];
}
