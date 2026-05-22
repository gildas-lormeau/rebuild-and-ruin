/**
 * AI tactic — super attack. Like wall demolition but strides every other
 * tile, spreading the chain across a longer wall segment for more breaches
 * per shot.
 */

import type { TilePos } from "../shared/core/geometry-types.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import type { Rng } from "../shared/platform/rng.ts";
import { planWallDemolition } from "./ai-plan-wall-demolition.ts";

/** Plan a super attack: like wall demolition but hit every other tile (stride of 2). */
export function planSuperAttack(
  state: BattleViewState,
  playerId: ValidPlayerId,
  usableCannonCount: number,
  rng: Rng,
): TilePos[] | null {
  const segment = planWallDemolition(
    state,
    playerId,
    usableCannonCount * 2,
    rng,
  );
  if (!segment) return null;
  // Keep every other tile
  const strided = segment.filter((_, i) => i % 2 === 0);
  return strided.length >= 2 ? strided : null;
}
