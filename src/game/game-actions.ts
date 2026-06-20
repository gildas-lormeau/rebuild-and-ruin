/**
 * Game action executors — pure functions that apply a controller intent
 * to game state and update the controller's bookkeeping on success.
 *
 * Shared by both local play (runtime/composition.ts) and online play
 * (online/runtime/game.ts via online-send-actions.ts callbacks).
 */

import type { Cannonball } from "../shared/core/battle-types.ts";
import type {
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
 *  Bag advancement runs inside `applyPiecePlacement` so host and watcher
 *  consume the same state.rng calls. Here we only clamp the cursor against
 *  the newly drawn piece so no tile of the proposal falls offscreen. */
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
    ctrl.clampBuildCursor(player?.currentPiece);
  }
  return placed;
}

/** Execute a cannon-placement intent against game state.
 *  Returns true on success, false when validation fails (occupied tile,
 *  slot budget exhausted, etc.).
 *
 *  Single entry point for IMMEDIATE-APPLY cannon placement — used by
 *  HumanController.tryPlaceCannon (built from cursor + selected mode)
 *  and by AiController's cannon brain (intent from `pickTarget`).
 *  Online host human + AssistedHuman go through `scheduleCannonPlacement`
 *  instead (deferred apply + wire broadcast); see
 *  online/online-send-actions.ts.
 *
 *  CALLERS MUST CONSUME THE RETURN VALUE — a `false` return means the
 *  placement was rejected, and the caller is expected to react (stop the
 *  flush loop, retry, etc.). Statement-form calls that drop the bool
 *  hide validation failures and have caused at least one infinite-loop
 *  bug (see flushCannon's generator refactor). */
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

/** Execute a fire intent against game state. The round-robin selector
 *  (`player.cannonRotationIdx`) is read and advanced inside
 *  `fireNextReadyCannon` — GameState owns it, not the controller.
 *  Returns the newly created cannonball, or null if no cannon was ready. */
export function executeCannonFire(
  state: GameState,
  intent: FireIntent,
): Cannonball | null {
  const fired = fireNextReadyCannon(
    state,
    intent.playerId,
    intent.targetRow,
    intent.targetCol,
  );
  if (!fired) return null;
  return state.cannonballs[state.cannonballs.length - 1]!;
}
