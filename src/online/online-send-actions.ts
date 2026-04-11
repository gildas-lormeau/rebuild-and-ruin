import { executeCannonFire, executePlacePiece } from "../game/index.ts";
import { createCannonFiredMsg } from "../shared/battle-events.ts";
import { type GameMessage, MESSAGE } from "../shared/net/protocol.ts";
import {
  type BattleController,
  type BattleViewState,
  type BuildController,
  type BuildViewState,
  type CannonController,
  type CannonViewState,
  type ControllerIdentity,
  type InputReceiver,
} from "../shared/system-interfaces.ts";
import type { GameState } from "../shared/types.ts";

interface OnlineSendActionsDeps {
  /** Network send — closes over the runtime's NetworkApi.send. */
  send: (msg: GameMessage) => void;
  /** Late-bound state getter — runtime state is sentinel until startGame(). */
  getState: () => GameState;
}

/** Factory for the three send-on-success action wrappers. Binds `send` and
 *  `getState` once at construction so call sites don't have to plumb them
 *  through every invocation. */
export function createOnlineSendActions(deps: OnlineSendActionsDeps) {
  const { send, getState } = deps;

  function tryPlacePieceAndSend(
    ctrl: ControllerIdentity & BuildController & InputReceiver,
    gameState: BuildViewState,
  ): boolean {
    const intent = ctrl.tryPlacePiece(gameState);
    if (!intent) return false;
    const placed = executePlacePiece(getState(), intent, ctrl);
    if (placed) {
      send({
        type: MESSAGE.OPPONENT_PIECE_PLACED,
        playerId: intent.playerId,
        row: intent.row,
        col: intent.col,
        offsets: intent.piece.offsets,
      });
    }
    return placed;
  }

  function tryPlaceCannonAndSend(
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

  function fireAndSend(
    ctrl: BattleController,
    gameState: BattleViewState,
  ): void {
    const intent = ctrl.fire(gameState);
    if (!intent) return;
    const ball = executeCannonFire(getState(), intent, ctrl);
    if (ball) send(createCannonFiredMsg(ball));
  }

  return { tryPlacePieceAndSend, tryPlaceCannonAndSend, fireAndSend };
}
