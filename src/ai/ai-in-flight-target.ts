/**
 * In-flight cannonball target dedup, shared by the battle strategy
 * (`ai-strategy-battle`) and the battle phase machine (`ai-phase-battle`).
 * Both the target picker AND the chain-attack driver must avoid stacking a
 * second ball onto a tile one of our OWN balls is already heading at (a
 * non-reinforced wall dies on the first hit, so a follow-up ball lands on
 * bare ground). Lives in its own leaf module so both paths can share it.
 */

import type { Cannonball } from "../shared/core/battle-types.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import { pxToTile } from "../shared/core/spatial.ts";

/** True if one of `playerId`'s OWN cannonballs in flight is targeting
 *  (row, col). Scoped to the effective firer (`scoringPlayerId ?? playerId`,
 *  so captured-cannon shots count for the capturer) — see the fairness note at
 *  the call sites: the AI must not read opponents' ball targets. */
export function isTileTargetedByInFlightBall(
  state: { readonly cannonballs: readonly Cannonball[] },
  row: number,
  col: number,
  playerId: ValidPlayerId,
): boolean {
  return state.cannonballs.some(
    (b) =>
      (b.scoringPlayerId ?? b.playerId) === playerId &&
      ballTargeting(b, row, col),
  );
}

/** True if a cannonball in flight is targeting (row, col). */
function ballTargeting(
  b: Pick<Cannonball, "targetY" | "targetX">,
  row: number,
  col: number,
): boolean {
  return pxToTile(b.targetY) === row && pxToTile(b.targetX) === col;
}
