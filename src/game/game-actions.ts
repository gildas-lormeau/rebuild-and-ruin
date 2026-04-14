/**
 * Game action executors — pure functions that apply a controller intent
 * to game state and update the controller's bookkeeping on success.
 *
 * Shared by both local play (runtime-composition.ts) and online play
 * (online-runtime-game.ts via online-send-actions.ts callbacks).
 */

import type { Cannonball } from "../shared/core/battle-types.ts";
import { advancePlayerBag } from "../shared/core/player-types.ts";
import type {
  BattleController,
  BuildController,
  FireIntent,
  PlaceCannonIntent,
  PlacePieceIntent,
} from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import { fireNextReadyCannon } from "./battle-system.ts";
import { placePiece } from "./build-system.ts";
import { canPlaceCannon, placeCannon } from "./cannon-system.ts";

/** Execute a piece placement intent against game state.
 *  On success, advances the player's piece bag and clamps the cursor. */
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
    const player = state.players[intent.playerId];
    if (player) advancePlayerBag(player, true);
    ctrl.clampBuildCursor(intent.piece);
  }
  return placed;
}

/** Execute a cannon-placement intent against game state.
 *  Returns true on success, false when validation fails (occupied tile, etc.). */
export function executePlaceCannon(
  state: GameState,
  intent: PlaceCannonIntent,
  maxSlots: number,
): boolean {
  const player = state.players[intent.playerId];
  if (!player) return false;
  if (!canPlaceCannon(player, intent.row, intent.col, intent.mode, state)) {
    return false;
  }
  return placeCannon(
    player,
    intent.row,
    intent.col,
    maxSlots,
    intent.mode,
    state,
  );
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
