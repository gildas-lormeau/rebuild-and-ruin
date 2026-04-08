import { createCannonFiredMsg } from "../game/battle-system.ts";
import type { Cannonball } from "../shared/battle-types.ts";
import { type GameMessage, MESSAGE } from "../shared/protocol.ts";
import type {
  BattleController,
  BattleViewState,
  BuildController,
  BuildViewState,
  CannonController,
  CannonViewState,
  ControllerIdentity,
  FireIntent,
  InputReceiver,
  PlacePieceIntent,
} from "../shared/system-interfaces.ts";

export function tryPlacePieceAndSend(
  ctrl: ControllerIdentity & BuildController & InputReceiver,
  gameState: BuildViewState,
  executePlacePiece: (intent: PlacePieceIntent) => boolean,
  send: (msg: GameMessage) => void,
): boolean {
  const intent = ctrl.tryPlacePiece(gameState);
  if (!intent) return false;
  const placed = executePlacePiece(intent);
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

export function tryPlaceCannonAndSend(
  ctrl: ControllerIdentity & CannonController & InputReceiver,
  gameState: CannonViewState,
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
  gameState: BattleViewState,
  executeFire: (intent: FireIntent) => Cannonball | null,
  send: (msg: GameMessage) => void,
): void {
  const intent = ctrl.fire(gameState);
  if (!intent) return;
  const ball = executeFire(intent);
  if (ball) send(createCannonFiredMsg(ball));
}
