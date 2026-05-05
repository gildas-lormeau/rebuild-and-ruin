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
import { isSessionLive, type RuntimeState } from "./runtime-state.ts";

interface PointerPlayerLookup {
  /** Return the human controller that owns mouse/touch input, or null in demo mode. */
  pointerPlayer: () => (PlayerController & InputReceiver) | null;
  /** Cache-independent boolean: true iff at least one alive human controller
   *  exists right now. Use from paths that run between frames (bootstrap →
   *  enterTowerSelection) where `pointerPlayer()`'s per-frame cache would
   *  still hold the lobby tick's stale `null`. */
  hasPointerPlayer: () => boolean;
  withPointerPlayer: WithPointerPlayer;
  /** Clear the per-frame cache. Must be called at the start of each frame. */
  clearCache: () => void;
}

export function createPointerPlayerLookup(
  runtimeState: RuntimeState,
): PointerPlayerLookup {
  let cached: (PlayerController & InputReceiver) | null | undefined;

  function isEligibleHuman(
    ctrl: PlayerController,
  ): ctrl is PlayerController & InputReceiver {
    return (
      isHuman(ctrl) && isPlayerAlive(runtimeState.state.players[ctrl.playerId])
    );
  }

  function pointerPlayer(): (PlayerController & InputReceiver) | null {
    if (cached !== undefined) return cached;
    if (!isSessionLive(runtimeState)) {
      return (cached = null);
    }
    // Prefer the player who joined via mouse/trackpad
    if (runtimeState.inputTracking.mouseJoinedSlot !== null) {
      const ctrl = runtimeState.controllers.find(
        (c) => c.playerId === runtimeState.inputTracking.mouseJoinedSlot,
      );
      if (ctrl && isEligibleHuman(ctrl)) {
        return (cached = ctrl);
      }
    }
    for (const ctrl of runtimeState.controllers) {
      if (isEligibleHuman(ctrl)) {
        return (cached = ctrl);
      }
    }
    return (cached = null);
  }

  function hasPointerPlayer(): boolean {
    if (!isSessionLive(runtimeState)) return false;
    return runtimeState.controllers.some(isEligibleHuman);
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

  return { pointerPlayer, hasPointerPlayer, withPointerPlayer, clearCache };
}
