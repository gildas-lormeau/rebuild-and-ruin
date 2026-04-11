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
import { isStateReady, type RuntimeState } from "./runtime-state.ts";

interface PointerPlayerLookup {
  /** Return the human controller that owns mouse/touch input, or null in demo mode. */
  pointerPlayer: () => (PlayerController & InputReceiver) | null;
  /** Run `action` with the pointer player.
   *  Returns `true` if the action ran, `false` if there is no human to receive
   *  the input (all-AI / demo / online-watcher mode).
   *  Callers that need to know whether the click/tap was actually handled —
   *  e.g. to suppress a fallback path, log a diagnostic, or surface a "no
   *  humans" UI hint — should inspect the return value. Older code may ignore
   *  it (the silent no-op preserves the previous behavior). */
  withPointerPlayer: (
    action: (human: PlayerController & InputReceiver) => void,
  ) => boolean;
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
        isPlayerAlive(runtimeState.state.players[ctrl.playerId])
      )
        return (cached = ctrl);
    }
    for (const ctrl of runtimeState.controllers) {
      if (
        isHuman(ctrl) &&
        isPlayerAlive(runtimeState.state.players[ctrl.playerId])
      )
        return (cached = ctrl);
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
