/**
 * AI commit port — apply-strategy seam for AiController's three mutating
 * commits (piece/cannon placement, fire). DIRECT_COMMIT_PORT mutates
 * GameState now; networkedCommitPort schedules + broadcasts. Only the port
 * swaps, so both controllers share AiController's tick logic verbatim. The
 * `state as GameState` casts are isolated here — every real call passes the
 * full state (ViewState params document the per-phase field contract).
 */

import {
  executeCannonFire,
  executePlaceCannon,
  executePlacePiece,
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
  BattleViewState,
  BuildController,
  BuildViewState,
  CannonViewState,
  FireIntent,
  PlaceCannonIntent,
  PlacePieceIntent,
} from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";

/** Apply-strategy for AiController's three mutating commits. Each returns a
 *  success bool — for fire, whether a cannon was ready and fired. The
 *  round-robin selector now lives on GameState (`player.cannonRotationIdx`),
 *  advanced by the executors, so the controller no longer threads an index. */
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
  fire(state: BattleViewState, intent: FireIntent): boolean;
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
  fire: (state, intent) =>
    executeCannonFire(state as GameState, intent) !== null,
};

/** Deferred-apply port: schedule the apply on the lockstep queue with a
 *  `safetyTicks` stamp and broadcast the wire payload, so assisted-human AI
 *  exercises the exact path a remote human's input takes. */
export function networkedCommitPort(opts: {
  schedule: (action: ScheduledAction<GameState>) => void;
  senders: CommitSenders;
  safetyTicks: number;
  /** Mirrors `createOnlineSendActions.isQuarantined`: board commits are
   *  dropped while the peer is fast-forward replaying banked lockstep
   *  debt — the assisted AI re-decides on a later tick once level. */
  isQuarantined: () => boolean;
}): AiCommitPort {
  const { schedule, senders, safetyTicks, isQuarantined } = opts;
  return {
    placePiece(state, intent, ctrl) {
      if (isQuarantined()) return false;
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
      if (isQuarantined()) return false;
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
    fire(state, intent) {
      if (isQuarantined()) return false;
      const msg = scheduleCannonFire({
        schedule,
        state: state as GameState,
        intent,
        safetyTicks,
      });
      if (!msg) return false;
      senders.sendCannonFired(msg);
      return true;
    },
  };
}
