/**
 * `UIContext` construction — the adapter that bridges internal runtime
 * state to the render-ui-screens functions (options, controls, lobby
 * overlays). Pure projection over `runtimeState` plus the few
 * config-supplied thunks; no subsystem dependencies.
 */

import { isPaused, type RuntimeState, safeState, setMode } from "./state.ts";
import type { UIContext } from "./ui-contracts.ts";

export function createUIContext(deps: {
  readonly runtimeState: RuntimeState;
  readonly isOnline: boolean;
  readonly getLobbyRemaining: () => number;
  readonly getSoundReady: () => boolean;
}): UIContext {
  const { runtimeState } = deps;
  return {
    getState: () => safeState(runtimeState),
    settings: runtimeState.settings,
    getMode: () => runtimeState.mode,
    setMode: (mode) => {
      setMode(runtimeState, mode);
    },
    getPaused: () => isPaused(runtimeState),
    setPaused: (paused) => {
      // `setPaused` is called from the user-facing pause toggle
      // (options menu / pause key). `pausedBy` is a single-owner slot,
      // so clearing also clears a visibility-driven pause — acceptable
      // because the tab must be visible for the user to hit the toggle
      // at all. (Online play never reaches here: togglePause and
      // mid-game F1 are disabled while online.)
      runtimeState.pausedBy = paused ? "user" : "none";
    },
    optionsCursor: {
      get value() {
        return runtimeState.optionsUI.cursor;
      },
      set value(value) {
        runtimeState.optionsUI.cursor = value;
      },
    },
    controlsState: runtimeState.controlsState,
    getOptionsContext: () => runtimeState.optionsUI.context,
    setOptionsContext: (context) => {
      runtimeState.optionsUI.context = context;
    },
    lobby: runtimeState.lobby,
    getFrame: () => runtimeState.frame,
    getLobbyRemaining: deps.getLobbyRemaining,
    isOnline: deps.isOnline,
    getSoundReady: deps.getSoundReady,
  };
}
