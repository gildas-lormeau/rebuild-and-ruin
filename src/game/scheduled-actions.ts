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
import {
  type CannonFiredMessage,
  createCannonFiredMsg,
} from "../shared/core/battle-events.ts";
import type { CannonMode } from "../shared/core/battle-types.ts";
import type { CannonPlacedPayload } from "../shared/core/phantom-types.ts";
import type { PieceShape } from "../shared/core/pieces.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type {
  BattleController,
  FireIntent,
  PlaceCannonIntent,
  PlacePieceIntent,
} from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import {
  applyCannonFiredOriginator,
  prepareCannonFireForLockstep,
} from "./battle-system.ts";
import { applyPiecePlacement, canPlacePiece } from "./build-system.ts";
import {
  applyCannonPlacement,
  effectivePlacementCost,
  isCannonPlacementLegal,
} from "./cannon-system.ts";
import { consumeRapidEmplacement } from "./upgrades/rapid-emplacement.ts";

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

/** Originator-side cannon-fire scheduler. Validates the fire intent
 *  (selecting the next ready cannon by rotation), pins the trajectory
 *  (drawing `state.rng` for any active modifier jitter on the originator),
 *  and enqueues `applyCannonFiredOriginator` for `applyAt`. The wire
 *  message shape is built from the resolved trajectory; receivers enqueue
 *  `applyCannonFired` for the same `applyAt` so the ball-push, scoring,
 *  and bus-driven side effects align across peers.
 *
 *  Returns the stamped wire message + new rotation index, or null when no
 *  cannon is ready (caller treats as a no-op — no enqueue, no broadcast). */
export function scheduleCannonFire(args: {
  schedule: (action: ScheduledAction) => void;
  state: GameState;
  intent: FireIntent;
  ctrl: BattleController;
  safetyTicks: number;
}): { msg: CannonFiredMessage; rotationIdx: number } | null {
  const { schedule, state, intent, ctrl, safetyTicks } = args;
  const fired = prepareCannonFireForLockstep(
    state,
    intent.playerId,
    ctrl.cannonRotationIdx,
    intent.targetRow,
    intent.targetCol,
  );
  if (!fired) return null;
  const applyAt = state.simTick + safetyTicks;
  const msg: CannonFiredMessage = {
    ...createCannonFiredMsg(fired.ball),
    applyAt,
  };
  schedule({
    applyAt,
    playerId: intent.playerId,
    apply: (drainState) => applyCannonFiredOriginator(drainState, msg),
  });
  return { msg, rotationIdx: fired.rotationIdx };
}

/** Originator-side cannon-place scheduler. Validates against `cannonLimits`
 *  + spatial rules now (so an invalid placement never enqueues nor
 *  broadcasts), and enqueues the apply for `applyAt`. Both originator and
 *  receiver call `applyCannonPlacement` + `consumeRapidEmplacement` at the
 *  same logical tick, so cannon-slot occupancy and the consequent
 *  `cannonPlaceDone` checkpointing align across peers.
 *
 *  Returns the stamped wire payload, or null when validation fails. */
export function scheduleCannonPlacement(args: {
  schedule: (action: ScheduledAction) => void;
  state: GameState;
  intent: PlaceCannonIntent;
  maxSlots: number;
  safetyTicks: number;
}): CannonPlacedPayload | null {
  const { schedule, state, intent, maxSlots, safetyTicks } = args;
  const player = state.players[intent.playerId];
  if (!player) return null;
  if (
    !isCannonPlacementLegal(
      player,
      intent.row,
      intent.col,
      intent.mode,
      maxSlots,
      state,
    )
  ) {
    return null;
  }
  const applyAt = state.simTick + safetyTicks;
  const playerId = intent.playerId;
  const row = intent.row;
  const col = intent.col;
  const mode: CannonMode = intent.mode;
  // Reserve the slot-cost up front: `isCannonPlacementLegal` reads this
  // counter so subsequent placements in the same SAFETY window respect
  // the pending occupancy. Released at apply (drain).
  const cost = effectivePlacementCost(player, mode);
  state.pendingCannonSlotCost[playerId] =
    (state.pendingCannonSlotCost[playerId] ?? 0) + cost;
  schedule({
    applyAt,
    playerId,
    apply: (drainState) => {
      drainState.pendingCannonSlotCost[playerId] = Math.max(
        0,
        (drainState.pendingCannonSlotCost[playerId] ?? 0) - cost,
      );
      const drainPlayer = drainState.players[playerId];
      if (!drainPlayer) return;
      applyCannonPlacement(drainPlayer, row, col, mode, drainState);
      consumeRapidEmplacement(drainPlayer);
    },
  });
  return { playerId, row, col, mode, applyAt };
}
