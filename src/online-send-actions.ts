import type { GameMessage } from "../server/protocol.ts";
import { MSG } from "../server/protocol.ts";
import type { InputReceiver, PlayerController } from "./controller-interfaces.ts";
import type { GameState } from "./types.ts";

export function tryPlacePieceAndSend(
  ctrl: PlayerController & InputReceiver,
  gameState: GameState,
  send: (msg: GameMessage) => void,
): boolean {
  const piece = ctrl.getCurrentPiece();
  const row = ctrl.buildCursor.row;
  const col = ctrl.buildCursor.col;
  const placed = ctrl.tryPlacePiece(gameState);
  if (placed && piece) {
    send({
      type: MSG.OPPONENT_PIECE_PLACED,
      playerId: ctrl.playerId,
      row,
      col,
      offsets: piece.offsets,
    });
  }
  return placed;
}

export function tryPlaceCannonAndSend(
  ctrl: PlayerController & InputReceiver,
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
      type: MSG.OPPONENT_CANNON_PLACED,
      playerId: ctrl.playerId,
      row,
      col,
      mode,
    });
  }
  return placed;
}

export function fireAndSend(
  ctrl: PlayerController,
  gameState: GameState,
  send: (msg: GameMessage) => void,
): void {
  const ballsBefore = gameState.cannonballs.length;
  ctrl.fire(gameState);

  if (gameState.cannonballs.length > ballsBefore) {
    send(buildCannonFiredMsg(gameState.cannonballs[gameState.cannonballs.length - 1]!));
  }
}

export function buildCannonFiredMsg(ball: {
  playerId: number; cannonIdx: number;
  startX: number; startY: number; targetX: number; targetY: number;
  speed: number; incendiary?: boolean;
}): GameMessage {
  return {
    type: MSG.CANNON_FIRED,
    playerId: ball.playerId,
    cannonIdx: ball.cannonIdx,
    startX: ball.startX,
    startY: ball.startY,
    targetX: ball.targetX,
    targetY: ball.targetY,
    speed: ball.speed,
    incendiary: ball.incendiary || undefined,
  };
}
