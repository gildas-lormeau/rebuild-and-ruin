/**
 * Local-play action surface — the offline counterpart to
 * `createOnlineSendActions` in src/online/. Each method executes the
 * matching `executeX` mutation directly against runtime state;
 * `maybeSendAimUpdate` is a no-op because there are no peers to broadcast
 * to. The returned object matches the `OnlineActions` shape so the input
 * dispatcher consumes one surface regardless of online/offline mode.
 */

import {
  executeCannonFire,
  executePlaceCannon,
  executePlacePiece,
} from "../game/index.ts";
import type { RuntimeState } from "./runtime-state.ts";
import type { OnlineActions } from "./runtime-types.ts";

export function createLocalInputActions(
  runtimeState: RuntimeState,
): OnlineActions {
  return {
    maybeSendAimUpdate: () => {},
    tryPlaceCannon: (ctrl, gameState, max) => {
      const intent = ctrl.tryPlaceCannon(gameState);
      if (!intent) return false;
      return executePlaceCannon(runtimeState.state, intent, max);
    },
    tryPlacePiece: (ctrl, gameState) => {
      const intent = ctrl.tryPlacePiece(gameState);
      if (!intent) return false;
      return executePlacePiece(runtimeState.state, intent, ctrl);
    },
    fire: (ctrl, gameState) => {
      const intent = ctrl.fire(gameState);
      if (!intent) return;
      executeCannonFire(runtimeState.state, intent, ctrl);
    },
  };
}
