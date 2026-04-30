import { executeCannonFire, schedulePiecePlacement } from "../game/index.ts";
import { type GameMessage, MESSAGE } from "../protocol/protocol.ts";
import type { ScheduledAction } from "../shared/core/action-schedule.ts";
import { createCannonFiredMsg } from "../shared/core/battle-events.ts";
import {
  type BattleController,
  type BattleViewState,
  type BuildController,
  type BuildViewState,
  type CannonController,
  type CannonViewState,
  type ControllerIdentity,
  type InputReceiver,
} from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";

interface OnlineSendActionsDeps {
  /** Network send — closes over the runtime's NetworkApi.send. */
  send: (msg: GameMessage) => void;
  /** Late-bound state getter — runtime state is sentinel until startGame(). */
  getState: () => GameState;
  /** Lockstep queue. The originator enqueues with the same applyAt it
   *  broadcasts, so it applies in lockstep with receivers. */
  schedule: (action: ScheduledAction) => void;
  /** Buffer depth in sim ticks. `applyAt = state.simTick + safetyTicks`. */
  safetyTicks: number;
}

/** Factory for the three send-on-success action wrappers. Binds `send` and
 *  `getState` once at construction so call sites don't have to plumb them
 *  through every invocation. */
export function createOnlineSendActions(deps: OnlineSendActionsDeps) {
  const { send, getState, schedule, safetyTicks } = deps;

  /** Lockstep piece-place: validate now, broadcast with `applyAt`, schedule
   *  the apply on this peer with the same `applyAt`. Receivers do the same
   *  on wire receipt, so the apply (and its order-sensitive RNG-consuming
   *  `recheckTerritory` cascade) runs at the same logical tick on every
   *  peer. */
  function tryPlacePiece(
    ctrl: ControllerIdentity & BuildController & InputReceiver,
    gameState: BuildViewState,
  ): boolean {
    const intent = ctrl.tryPlacePiece(gameState);
    if (!intent) return false;
    const stamped = schedulePiecePlacement({
      schedule,
      state: getState(),
      intent,
      safetyTicks,
      clampBuildCursor: (piece) => ctrl.clampBuildCursor(piece),
    });
    if (!stamped) return false;
    send({ type: MESSAGE.OPPONENT_PIECE_PLACED, ...stamped });
    return true;
  }

  function tryPlaceCannon(
    ctrl: ControllerIdentity & CannonController & InputReceiver,
    gameState: CannonViewState,
    max: number,
  ): boolean {
    const row = ctrl.cannonCursor.row;
    const col = ctrl.cannonCursor.col;
    const mode = ctrl.getCannonPlaceMode();
    const placed = ctrl.tryPlaceCannon(gameState, max);
    if (placed) {
      send({
        type: MESSAGE.OPPONENT_CANNON_PLACED,
        playerId: ctrl.playerId,
        row,
        col,
        mode,
      });
    }
    return placed;
  }

  function fire(ctrl: BattleController, gameState: BattleViewState): void {
    const intent = ctrl.fire(gameState);
    if (!intent) return;
    const ball = executeCannonFire(getState(), intent, ctrl);
    if (ball) send(createCannonFiredMsg(ball));
  }

  return { tryPlacePiece, tryPlaceCannon, fire };
}
