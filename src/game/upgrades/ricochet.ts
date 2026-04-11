/**
 * Ricochet upgrade — after the initial impact, a cannonball bounces to 2
 * additional random positions within decaying radii. Each bounce processes
 * a full impact (walls, cannons, grunts) but a cannon that already took
 * damage in the initial hit can't be double-hit on a later bounce.
 *
 * Hook implemented: onImpactResolved (post-impact follow-up).
 * Wired through src/game/upgrade-system.ts. Battle-system supplies the
 * `applyBounce` callback, which owns the actual computeImpact + apply +
 * emit machinery — this file owns the upgrade-specific RNG + geometry.
 */

import {
  BATTLE_MESSAGE,
  type ImpactEvent,
} from "../../shared/core/battle-events.ts";
import { GRID_COLS, GRID_ROWS } from "../../shared/core/grid.ts";
import type { ValidPlayerSlot } from "../../shared/core/player-slot.ts";
import type { GameState } from "../../shared/core/types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";

/** Dedup key set shared across bounces: identifies cannons already damaged
 *  in the chain so later bounces can't re-hit them. */
export type RicochetHitSet = Set<string>;

/** Callback supplied by battle-system to apply an impact at a bounce position.
 *  Receives the same hitCannons set on every call so the caller can skip
 *  cannon events for cannons already hit earlier in the chain. */
export type RicochetApplyBounce = (
  row: number,
  col: number,
  hitCannons: RicochetHitSet,
) => void;

/** Number of random bounces after a ricochet impact. */
const RICOCHET_BOUNCES = 2;
/** Max Chebyshev distance for each successive bounce (decays to simulate energy loss). */
const RICOCHET_RADII: readonly number[] = [5, 3];

/** Run ricochet bounces for an initial impact. No-op when the shooter
 *  doesn't own Ricochet. Consumes state.rng twice per bounce (dr, dc). */
export function ricochetProcessBounces(
  state: GameState,
  shooterId: ValidPlayerSlot,
  hitRow: number,
  hitCol: number,
  initialImpactEvents: readonly ImpactEvent[],
  applyBounce: RicochetApplyBounce,
): void {
  if (!state.players[shooterId]?.upgrades.get(UID.RICOCHET)) return;

  const hitCannons: RicochetHitSet = new Set();
  for (const evt of initialImpactEvents) {
    if (evt.type === BATTLE_MESSAGE.CANNON_DAMAGED) {
      hitCannons.add(`${evt.playerId}:${evt.cannonIdx}`);
    }
  }

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
    applyBounce(bounceRow, bounceCol, hitCannons);
  }
}
