/**
 * Human-player lookup — cached per-frame lookup of the first human controller.
 *
 * Used by nearly every sub-system (camera, selection, input, phase-ticks,
 * life-lost) so it lives in its own module rather than inline in runtime.ts.
 */

import {
  type InputReceiver,
  isHuman,
  type PlayerController,
} from "./controller-interfaces.ts";
import type { RuntimeState } from "./runtime-state.ts";

interface HumanLookup {
  /** Return the first non-eliminated human controller (prefers mouse-joined slot). */
  firstHuman: () => (PlayerController & InputReceiver) | null;
  /** Run `action` with the first human controller. No-op if no human exists
   *  (e.g. all-AI game) — the action callback will NOT be called. */
  withFirstHuman: (
    action: (human: PlayerController & InputReceiver) => void,
  ) => void;
  /** Clear the per-frame cache. Must be called at the start of each frame. */
  clearCache: () => void;
}

export function createHumanLookup(runtimeState: RuntimeState): HumanLookup {
  let cachedFirstHuman: (PlayerController & InputReceiver) | null | undefined;

  function firstHuman(): (PlayerController & InputReceiver) | null {
    if (cachedFirstHuman !== undefined) return cachedFirstHuman;
    // Prefer the player who joined via mouse/trackpad
    if (runtimeState.mouseJoinedSlot !== null) {
      const ctrl = runtimeState.controllers.find(
        (c) => c.playerId === runtimeState.mouseJoinedSlot,
      );
      if (
        ctrl &&
        isHuman(ctrl) &&
        !runtimeState.state.players[ctrl.playerId]?.eliminated
      )
        return (cachedFirstHuman = ctrl);
    }
    for (const ctrl of runtimeState.controllers) {
      if (
        isHuman(ctrl) &&
        !runtimeState.state.players[ctrl.playerId]?.eliminated
      )
        return (cachedFirstHuman = ctrl);
    }
    return (cachedFirstHuman = null);
  }

  function withFirstHuman(
    action: (human: PlayerController & InputReceiver) => void,
  ): void {
    const human = firstHuman();
    if (!human) return;
    action(human);
  }

  function clearCache(): void {
    cachedFirstHuman = undefined;
  }

  return { firstHuman, withFirstHuman, clearCache };
}
