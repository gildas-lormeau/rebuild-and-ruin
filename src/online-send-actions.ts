import type { GameMessage } from "../server/protocol.ts";
import type { GameState } from "./types.ts";
import type { PlayerController } from "./player-controller.ts";

export function tryPlacePieceAndSend(
  ctrl: PlayerController,
  gameState: GameState,
  send: (msg: GameMessage) => void,
): boolean {
  const piece = ctrl.getCurrentPiece();
  const row = ctrl.buildCursor.row;
  const col = ctrl.buildCursor.col;
  const placed = ctrl.tryPlacePiece(gameState);
  if (placed && piece) {
    send({
      type: "opponent_piece_placed",
      playerId: ctrl.playerId,
      row,
      col,
      offsets: piece.offsets,
    });
  }
  return placed;
}

export function tryPlaceCannonAndSend(
  ctrl: PlayerController,
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
      type: "opponent_cannon_placed",
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
    const ball = gameState.cannonballs[gameState.cannonballs.length - 1]!;
    send({
      type: "cannon_fired",
      playerId: ball.playerId,
      cannonIdx: ball.cannonIdx,
      startX: ball.startX,
      startY: ball.startY,
      targetX: ball.targetX,
      targetY: ball.targetY,
      speed: ball.speed,
      incendiary: ball.incendiary || undefined,
    });
  }
}
