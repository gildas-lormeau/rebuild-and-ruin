/**
 * Pointer-player lookup — cached per-frame lookup of the player that
 * receives mouse/touch input.
 *
 * On touch devices there is always exactly one human. On desktop,
 * pointer input goes to the player who joined via mouse click
 * (mouseJoinedSlot), falling back to the first human controller.
 */

import { isPlayerAlive } from "../shared/core/player-types.ts";
import {
  type InputReceiver,
  isHuman,
  type PlayerController,
} from "../shared/core/system-interfaces.ts";
import type { WithPointerPlayer } from "./runtime-contracts.ts";
import { isStateReady, type RuntimeState } from "./runtime-state.ts";

interface PointerPlayerLookup {
  /** Return the human controller that owns mouse/touch input, or null in demo mode. */
  pointerPlayer: () => (PlayerController & InputReceiver) | null;
  withPointerPlayer: WithPointerPlayer;
  /** Clear the per-frame cache. Must be called at the start of each frame. */
  clearCache: () => void;
}

export function createPointerPlayerLookup(
  runtimeState: RuntimeState,
): PointerPlayerLookup {
  let cached: (PlayerController & InputReceiver) | null | undefined;

  function pointerPlayer(): (PlayerController & InputReceiver) | null {
    if (cached !== undefined) return cached;
    if (!isStateReady(runtimeState) || runtimeState.lobby.active) {
      return (cached = null);
    }
    // Prefer the player who joined via mouse/trackpad
    if (runtimeState.inputTracking.mouseJoinedSlot !== null) {
      const ctrl = runtimeState.controllers.find(
        (c) => c.playerId === runtimeState.inputTracking.mouseJoinedSlot,
      );
      if (
        ctrl &&
        isHuman(ctrl) &&
        isPlayerAlive(runtimeState.state.players[ctrl.playerId])
      ) {
        return (cached = ctrl);
      }
    }
    for (const ctrl of runtimeState.controllers) {
      if (
        isHuman(ctrl) &&
        isPlayerAlive(runtimeState.state.players[ctrl.playerId])
      ) {
        return (cached = ctrl);
      }
    }
    return (cached = null);
  }

  function withPointerPlayer(
    action: (human: PlayerController & InputReceiver) => void,
  ): boolean {
    const active = pointerPlayer();
    if (!active) return false;
    action(active);
    return true;
  }

  function clearCache(): void {
    cached = undefined;
  }

  return { pointerPlayer, withPointerPlayer, clearCache };
}
