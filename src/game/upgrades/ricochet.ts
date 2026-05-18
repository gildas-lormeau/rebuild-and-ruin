/**
 * Ricochet upgrade — after the initial impact, a cannonball bounces to
 * 2 additional random positions within decaying radii. Yields each
 * bounce position as a generator; battle-system applies impact + dedup
 * between yields. RNG draws for dr/dc stay interleaved with any
 * applyImpactEvent RNG (HOUSE_CRUSHED grunt-spawn roll) — drift-safe.
 */

import type { ImpactEvent } from "../../shared/core/battle-events.ts";
import { GRID_COLS, GRID_ROWS } from "../../shared/core/grid.ts";
import type { ValidPlayerId } from "../../shared/core/player-slot.ts";
import type {
  BounceDescriptor,
  GameState,
  UpgradeImpl,
} from "../../shared/core/types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";

/** Number of random bounces after a ricochet impact. */
const RICOCHET_BOUNCES = 2;
/** Max Chebyshev distance for each successive bounce (decays to simulate energy loss). */
const RICOCHET_RADII: readonly number[] = [5, 3];
export const ricochetImpl: UpgradeImpl = { onImpactResolved };

function* onImpactResolved(
  state: GameState,
  shooterId: ValidPlayerId,
  hitRow: number,
  hitCol: number,
  _initialImpactEvents: readonly ImpactEvent[],
): Generator<BounceDescriptor, void> {
  if (!state.players[shooterId]?.upgrades.get(UID.RICOCHET)) return;

  let bounceRow = hitRow;
  let bounceCol = hitCol;
  for (let bounce = 0; bounce < RICOCHET_BOUNCES; bounce++) {
    const radius = RICOCHET_RADII[bounce]!;
    const span = radius * 2 + 1;
    let dr: number;
    let dc: number;
    do {
      dr = Math.floor(state.rng.next() * span) - radius;
      dc = Math.floor(state.rng.next() * span) - radius;
    } while (dr === 0 && dc === 0);
    bounceRow = Math.max(0, Math.min(bounceRow + dr, GRID_ROWS - 1));
    bounceCol = Math.max(0, Math.min(bounceCol + dc, GRID_COLS - 1));
    yield { row: bounceRow, col: bounceCol };
  }
}
