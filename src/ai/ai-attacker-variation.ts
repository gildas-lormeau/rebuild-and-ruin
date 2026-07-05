/**
 * Per-attacker variation for structural breach plans. The cut planners
 * (`findMinBreach`, `selectExposedBreach`) are pure functions of the TARGET's
 * geometry, so two attackers of one ring would fire an identical, lockstep
 * tile sequence (visibly cloned AI). Starting each attacker at the tile
 * nearest its OWN crosshair breaks that — different crosshairs, different
 * starts — and makes the chain's entry hop the cheapest available.
 */

import type { TilePos } from "../shared/core/geometry-types.ts";
import { manhattanDistance } from "../shared/core/spatial.ts";

/** Rotate a breach's firing order to start at the tile nearest `cursor` (the
 *  attacker's live crosshair). Rotation, NOT shuffle: it preserves the
 *  planner's tile adjacency — consecutive shots still concentrate into one
 *  breach — while moving where this attacker begins. Replaces the old
 *  slot-offset rotation (`floor(slot * len / 3)`), which entered multi-ring
 *  cuts mid-ring and wrapped the crosshair across distant rings — the single
 *  largest source of >=15-tile intra-chain glides. Cuts of <=2 tiles are
 *  returned unrotated. */
export function rotateBreachForAttacker(
  tiles: readonly TilePos[],
  cursor: TilePos,
): TilePos[] {
  if (tiles.length <= 2) return [...tiles];
  let offset = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let idx = 0; idx < tiles.length; idx++) {
    const tile = tiles[idx]!;
    const dist = manhattanDistance(tile.row, tile.col, cursor.row, cursor.col);
    if (dist < best) {
      best = dist;
      offset = idx;
    }
  }
  if (offset === 0) return [...tiles];
  return [...tiles.slice(offset), ...tiles.slice(0, offset)];
}
