import { type GameMessage, MESSAGE } from "../../server/protocol.ts";
import { createCannonFiredMsg } from "../game/battle-system.ts";
import type {
  BattleController,
  BuildController,
  CannonController,
  ControllerIdentity,
  InputReceiver,
} from "../shared/system-interfaces.ts";
import type { GameState } from "../shared/types.ts";

export function tryPlacePieceAndSend(
  ctrl: ControllerIdentity & BuildController & InputReceiver,
  gameState: GameState,
  send: (msg: GameMessage) => void,
): boolean {
  const piece = ctrl.getCurrentPiece();
  const row = ctrl.buildCursor.row;
  const col = ctrl.buildCursor.col;
  const placed = ctrl.tryPlacePiece(gameState);
  if (placed && piece) {
    send({
      type: MESSAGE.OPPONENT_PIECE_PLACED,
      playerId: ctrl.playerId,
      row,
      col,
      offsets: piece.offsets,
    });
  }
  return placed;
}

export function tryPlaceCannonAndSend(
  ctrl: ControllerIdentity & CannonController & InputReceiver,
  gameState: GameState,
  max: number,
  send: (msg: GameMessage) => void,
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

export function fireAndSend(
  ctrl: BattleController,
  gameState: GameState,
  send: (msg: GameMessage) => void,
): void {
  const ballsBefore = gameState.cannonballs.length;
  ctrl.fire(gameState);

  if (gameState.cannonballs.length > ballsBefore) {
    send(
      createCannonFiredMsg(
        gameState.cannonballs[gameState.cannonballs.length - 1]!,
      ),
    );
  }
}
