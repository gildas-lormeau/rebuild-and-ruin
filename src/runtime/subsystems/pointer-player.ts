/**
 * Pointer-player lookup — cached per-frame lookup of the player that
 * receives mouse/touch input.
 *
 * On touch devices there is always exactly one human. On desktop,
 * pointer input goes to the player who joined via mouse click
 * (mouseJoinedSlot), falling back to the first human controller.
 */

import { isHuman } from "../../shared/core/controller-guards.ts";
import { isPlayerAlive } from "../../shared/core/player-types.ts";
import {
  type InputReceiver,
  type PlayerController,
} from "../../shared/core/system-interfaces.ts";
import type { WithPointerPlayer } from "../../shared/ui/input-deps.ts";
import { isSessionLive, type RuntimeState } from "../state.ts";

interface PointerPlayerLookup {
  /** Return the human controller that owns mouse/touch input, or null in demo mode. */
  pointerPlayer: () => (PlayerController & InputReceiver) | null;
  /** Plain `{x, y}` crosshair of the pointer player, or null if none.
   *  The single read of `getCrosshair()` → bare-coords shape. */
  pointerCrosshair: () => { x: number; y: number } | null;
  /** Cache-independent boolean: true iff at least one alive human controller
   *  exists right now. The cheaper shape for per-tick gates (camera
   *  auto-zoom) that only need existence, not the resolved controller. */
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
    // The not-live bail is NOT cached — it's a liveness gate, not a
    // lookup result. Bootstrap's awaits let lobby substeps run (each
    // refreshing the cache for its own frame), and `enterTowerSelection`
    // then reads BETWEEN frames, after setState + setMode(SELECTION)
    // made the session live. Memoizing the lobby tick's null handed it
    // a stale null and silently skipped parking the round-1 mobile
    // auto-zoom viewport. Skipping the cache costs nothing here: this
    // path does no controller scan.
    if (!isSessionLive(runtimeState)) return null;
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

  function pointerCrosshair(): { x: number; y: number } | null {
    const active = pointerPlayer();
    if (!active) return null;
    const ch = active.getCrosshair();
    return { x: ch.x, y: ch.y };
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

  return {
    pointerPlayer,
    pointerCrosshair,
    hasPointerPlayer,
    withPointerPlayer,
    clearCache,
  };
}
