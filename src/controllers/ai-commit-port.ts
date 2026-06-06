/**
 * AI commit port — apply-strategy seam for AiController's three mutating
 * commits (piece/cannon placement, fire). DIRECT_COMMIT_PORT mutates
 * GameState now; networkedCommitPort schedules + broadcasts. Only the port
 * swaps, so both controllers share AiController's tick logic verbatim. The
 * `state as GameState` casts are isolated here — every real call passes the
 * full state (ViewState params document the per-phase field contract).
 */

import {
  executePlaceCannon,
  executePlacePiece,
  fireNextReadyCannon,
  scheduleCannonFire,
  scheduleCannonPlacement,
  schedulePiecePlacement,
} from "../game/index.ts";
import type { ScheduledAction } from "../shared/core/action-schedule.ts";
import type { CannonFiredMessage } from "../shared/core/battle-events.ts";
import type {
  CannonPlacedPayload,
  PiecePlacedPayload,
} from "../shared/core/phantom-types.ts";
import type {
  BattleController,
  BattleViewState,
  BuildController,
  BuildViewState,
  CannonViewState,
  FireIntent,
  PlaceCannonIntent,
  PlacePieceIntent,
} from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";

/** Apply-strategy for AiController's three mutating commits. Returns mirror
 *  the executors: a success bool for placements, the new rotation index (or
 *  null when no cannon fired) for fire. */
export interface AiCommitPort {
  placePiece(
    state: BuildViewState,
    intent: PlacePieceIntent,
    ctrl: BuildController,
  ): boolean;
  placeCannon(
    state: CannonViewState,
    intent: PlaceCannonIntent,
    maxSlots: number,
  ): boolean;
  fire(
    state: BattleViewState,
    intent: FireIntent,
    ctrl: BattleController,
  ): number | null;
}

/** Wire-broadcast callbacks the networked port needs — a structural subset
 *  of the assisted-human controller's full sender set (which also carries
 *  the upgrade/life-lost senders the port doesn't touch). */
export interface CommitSenders {
  sendPiecePlaced: (payload: PiecePlacedPayload) => void;
  sendCannonPlaced: (payload: CannonPlacedPayload) => void;
  sendCannonFired: (msg: CannonFiredMessage) => void;
}

/** Immediate-apply port: mutate GameState in place via the executors.
 *  The default for local play and the online host's own AI slots. */
export const DIRECT_COMMIT_PORT: AiCommitPort = {
  placePiece: (state, intent, ctrl) =>
    executePlacePiece(state as GameState, intent, ctrl),
  placeCannon: (state, intent, maxSlots) =>
    executePlaceCannon(state as GameState, intent, maxSlots),
  fire: (state, intent, ctrl) => {
    const fired = fireNextReadyCannon(
      state as GameState,
      intent.playerId,
      ctrl.cannonRotationIdx,
      intent.targetRow,
      intent.targetCol,
    );
    return fired ? fired.rotationIdx : null;
  },
};

/** Deferred-apply port: schedule the apply on the lockstep queue with a
 *  `safetyTicks` stamp and broadcast the wire payload, so assisted-human AI
 *  exercises the exact path a remote human's input takes. */
export function networkedCommitPort(opts: {
  schedule: (action: ScheduledAction<GameState>) => void;
  senders: CommitSenders;
  safetyTicks: number;
}): AiCommitPort {
  const { schedule, senders, safetyTicks } = opts;
  return {
    placePiece(state, intent, ctrl) {
      const stamped = schedulePiecePlacement({
        schedule,
        state,
        intent,
        safetyTicks,
        clampBuildCursor: (piece) => ctrl.clampBuildCursor(piece),
      });
      if (!stamped) return false;
      senders.sendPiecePlaced(stamped);
      return true;
    },
    placeCannon(state, intent, maxSlots) {
      const stamped = scheduleCannonPlacement({
        schedule,
        state: state as GameState,
        intent,
        maxSlots,
        safetyTicks,
      });
      if (!stamped) return false;
      senders.sendCannonPlaced(stamped);
      return true;
    },
    fire(state, intent, ctrl) {
      const fired = scheduleCannonFire({
        schedule,
        state: state as GameState,
        intent,
        ctrl,
        safetyTicks,
      });
      if (!fired) return null;
      senders.sendCannonFired(fired.msg);
      return fired.rotationIdx;
    },
  };
}
