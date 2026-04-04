/**
 * Pointer-player lookup — cached per-frame lookup of the player that
 * receives mouse/touch input.
 *
 * On touch devices there is always exactly one human. On desktop,
 * pointer input goes to the player who joined via mouse click
 * (mouseJoinedSlot), falling back to the first human controller.
 */

import {
  type InputReceiver,
  isHuman,
  type PlayerController,
} from "../shared/system-interfaces.ts";
import { isStateReady, type RuntimeState } from "./runtime-state.ts";

interface PointerPlayerLookup {
  /** Return the human controller that owns mouse/touch input, or null in demo mode. */
  pointerPlayer: () => (PlayerController & InputReceiver) | null;
  /** Run `action` with the pointer player. No-op in demo mode (all-AI). */
  withPointerPlayer: (
    action: (human: PlayerController & InputReceiver) => void,
  ) => void;
  /** Clear the per-frame cache. Must be called at the start of each frame. */
  clearCache: () => void;
}

export function createPointerPlayerLookup(
  runtimeState: RuntimeState,
): PointerPlayerLookup {
  let cached: (PlayerController & InputReceiver) | null | undefined;

  function pointerPlayer(): (PlayerController & InputReceiver) | null {
    if (cached !== undefined) return cached;
    if (!isStateReady(runtimeState)) return (cached = null);
    // Prefer the player who joined via mouse/trackpad
    if (runtimeState.inputTracking.mouseJoinedSlot !== null) {
      const ctrl = runtimeState.controllers.find(
        (c) => c.playerId === runtimeState.inputTracking.mouseJoinedSlot,
      );
      if (
        ctrl &&
        isHuman(ctrl) &&
        !runtimeState.state.players[ctrl.playerId]?.eliminated
      )
        return (cached = ctrl);
    }
    for (const ctrl of runtimeState.controllers) {
      if (
        isHuman(ctrl) &&
        !runtimeState.state.players[ctrl.playerId]?.eliminated
      )
        return (cached = ctrl);
    }
    return (cached = null);
  }

  function withPointerPlayer(
    action: (human: PlayerController & InputReceiver) => void,
  ): void {
    const pp = pointerPlayer();
    if (!pp) return;
    action(pp);
  }

  function clearCache(): void {
    cached = undefined;
  }

  return { pointerPlayer, withPointerPlayer, clearCache };
}
