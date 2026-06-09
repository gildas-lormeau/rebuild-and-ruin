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

/** Plan a super attack: like wall demolition but hit every other tile (stride
 *  of 2). The stride is applied INSIDE planWallDemolition, before its flood
 *  validation — so the every-other-tile set that actually gets fired is the
 *  set proven to breach (striding an already-validated contiguous segment
 *  could keep holes that breach nothing on a ≥2-thick wall body). */
export function planSuperAttack(
  state: BattleViewState,
  playerId: ValidPlayerId,
  usableCannonCount: number,
  rng: Rng,
): TilePos[] | null {
  const strided = planWallDemolition(
    state,
    playerId,
    usableCannonCount * 2,
    rng,
    2,
  );
  return strided && strided.length >= 2 ? strided : null;
}
