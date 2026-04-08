/**
 * Game action executors — pure functions that apply a controller intent
 * to game state and update the controller's bookkeeping on success.
 *
 * Shared by both local play (assembly.ts) and online play
 * (online-runtime-game.ts via online-send-actions.ts callbacks).
 */

import type { Cannonball } from "../shared/battle-types.ts";
import type {
  BattleController,
  BattleViewState,
  BuildController,
  BuildViewState,
  FireIntent,
  InputReceiver,
  PlacePieceIntent,
  PlayerController,
} from "../shared/system-interfaces.ts";
import type { GameState } from "../shared/types.ts";
import { fireNextReadyCannon } from "./battle-system.ts";
import { placePiece } from "./build-system.ts";

/** Local-play adapter: get a place-piece intent from the controller and execute it.
 *  Used as the default (offline) implementation of tryPlacePieceAndSend. */
export function localPlacePiece(
  mutableState: GameState,
  ctrl: PlayerController & InputReceiver,
  viewState: BuildViewState,
): boolean {
  const intent = ctrl.tryPlacePiece(viewState);
  if (!intent) return false;
  return executePlacePiece(mutableState, intent, ctrl);
}

/** Execute a piece placement intent against game state.
 *  On success, advances the controller's piece bag and clamps the cursor. */
export function executePlacePiece(
  state: GameState,
  intent: PlacePieceIntent,
  ctrl: BuildController,
): boolean {
  const placed = placePiece(
    state,
    intent.playerId,
    intent.piece,
    intent.row,
    intent.col,
  );
  if (placed) {
    ctrl.advanceBag(true);
    ctrl.clampBuildCursor(intent.piece);
  }
  return placed;
}

/** Local-play adapter: get a fire intent from the controller and execute it.
 *  Used as the default (offline) implementation of fireAndSend. */
export function localFire(
  mutableState: GameState,
  ctrl: PlayerController,
  viewState: BattleViewState,
): void {
  const intent = ctrl.fire(viewState);
  if (!intent) return;
  executeCannonFire(mutableState, intent, ctrl);
}

/** Execute a fire intent against game state.
 *  On success, updates the controller's cannon rotation index.
 *  Returns the newly created cannonball, or null if no cannon was ready. */
export function executeCannonFire(
  state: GameState,
  intent: FireIntent,
  ctrl: BattleController,
): Cannonball | null {
  const fired = fireNextReadyCannon(
    state,
    intent.playerId,
    ctrl.cannonRotationIdx,
    intent.targetRow,
    intent.targetCol,
  );
  if (!fired) return null;
  ctrl.cannonRotationIdx = fired.rotationIdx;
  return state.cannonballs[state.cannonballs.length - 1]!;
}
