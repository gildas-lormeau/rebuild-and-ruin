/**
 * Originator-side helpers for the lockstep scheduled-actions queue.
 *
 * Both wire-broadcast piece placements (network.send) and controller-driven
 * placements (AssistedHumanController.senders) follow the same recipe:
 *   1. Validate against current state.
 *   2. Stamp `applyAt = state.simTick + safetyTicks`.
 *   3. Enqueue an `apply` closure that calls `applyPiecePlacement` and
 *      clamps the originator's build cursor.
 *   4. Broadcast a wire message carrying the same `applyAt`.
 *
 * This module owns step 1-3; step 4 stays at the call site (the wire-message
 * shape varies between the runtime broadcast path and the controller-senders
 * path). Receivers re-use a slimmer enqueue inside `online-server-events.ts`
 * — same `applyAt`, no clamp.
 */

import type { ScheduledAction } from "../shared/core/action-schedule.ts";
import type { PieceShape } from "../shared/core/pieces.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type { PlacePieceIntent } from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import { applyPiecePlacement, canPlacePiece } from "./build-system.ts";

/** Stamped placement returned by `schedulePiecePlacement` — caller spreads
 *  it into the wire message so both originator and receiver enqueue with
 *  the same `applyAt`. */
interface ScheduledPiecePlacement {
  applyAt: number;
  playerId: ValidPlayerSlot;
  row: number;
  col: number;
  offsets: [number, number][];
}

/** Validate the placement, enqueue the apply with the lockstep stamp,
 *  return the stamped fields. Returns null when the placement is rejected
 *  (caller should treat as a no-op — no enqueue, no broadcast). */
export function schedulePiecePlacement(args: {
  schedule: (action: ScheduledAction) => void;
  state: GameState;
  intent: PlacePieceIntent;
  safetyTicks: number;
  clampBuildCursor: (piece: PieceShape | undefined) => void;
}): ScheduledPiecePlacement | null {
  const { schedule, state, intent, safetyTicks, clampBuildCursor } = args;
  if (
    !canPlacePiece(
      state,
      intent.playerId,
      intent.piece.offsets,
      intent.row,
      intent.col,
    )
  ) {
    return null;
  }
  const offsets: [number, number][] = intent.piece.offsets.map(([dr, dc]) => [
    dr,
    dc,
  ]);
  const applyAt = state.simTick + safetyTicks;
  const playerId = intent.playerId;
  const row = intent.row;
  const col = intent.col;
  schedule({
    applyAt,
    playerId,
    apply: (drainState) => {
      applyPiecePlacement(drainState, playerId, offsets, row, col);
      clampBuildCursor(drainState.players[playerId]?.currentPiece);
    },
  });
  return { applyAt, playerId, row, col, offsets };
}
