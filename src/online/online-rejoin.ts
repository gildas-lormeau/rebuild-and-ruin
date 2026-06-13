/**
 * Rejoin / seat give-back host-side gate (HIGH-2 step 3c).
 *
 * A re-admitted peer (server `rejoinRoom`) adopts a targeted resync, then
 * asks the host to hand its seat back from the AI that took it over. The
 * host alone decides; this is the game-state half of that decision (the
 * requester's seat ownership is already proven server-side by the token).
 */

import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import { isPlayerAlive } from "../shared/core/player-types.ts";
import type { GameState } from "../shared/core/types.ts";

/** Host-side gate for a forwarded REQUEST_SEAT_RECLAIM: may this seat be
 *  handed back to its returning human owner right now?
 *
 *  Two conditions, both matching user-locked decisions (2026-06-13):
 *  - **AI currently holds the seat** — the seat-takeover cleared it from
 *    `occupiedSlots` (see online-seat-takeover.ts `clearSeatSlots`), so an
 *    absent slot means an AI is mirror-simulating it. A still-present slot
 *    is human-held (the owner never actually left, or already reclaimed) —
 *    nothing to give back.
 *  - **The owner is still alive** — an eliminated owner stays a watcher
 *    (its seat's AI plays the match out); only a live owner gets its seat
 *    back. This is the `reclaim-while-alive` rule.
 *
 *  Mirrors the idempotency guard inside `applySeatReclaim` (which no-ops
 *  when `occupiedSlots.has(playerId)`), so a request the apply would reject
 *  is rejected here before it is ever stamped + broadcast. */
export function isSeatReclaimable(
  state: GameState,
  occupiedSlots: ReadonlySet<ValidPlayerId>,
  playerId: ValidPlayerId,
): boolean {
  if (occupiedSlots.has(playerId)) return false;
  const player = state.players[playerId];
  return player !== undefined && isPlayerAlive(player);
}
