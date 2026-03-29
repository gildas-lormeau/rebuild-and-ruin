import type { RegisterOnlineInputDeps } from "./input.ts";
import {
  dispatchBattleFire,
  dispatchModeTap,
  dispatchPlacement,
  dispatchPointerMove,
  dispatchTowerSelect,
  isGameInteractionMode,
  isTouchSuppressed,
} from "./input-dispatch.ts";
import {
  isPlacementPhase,
  isReselectPhase,
  isSelectionPhase,
  Phase,
} from "./types.ts";

// Note: keyboard checks mode in per-handler switches (different keys per mode).
// Mouse checks mode at event-handler level because all mouse actions share the
// same guard: no game state → no-op, lobby active → lobby hit-test only.
export function registerMouseHandlers(deps: RegisterOnlineInputDeps): void {
  const { renderer, getState, getMode, modeValues, coords } = deps;

  renderer.eventTarget.addEventListener("mousemove", (e) => {
    const mode = getMode();
    if (mode === modeValues.LOBBY || mode === modeValues.STOPPED) {
      renderer.eventTarget.style.cursor = "pointer";
    } else if (mode === modeValues.GAME) {
      const state = getState();
      renderer.eventTarget.style.cursor =
        state?.phase === Phase.BATTLE ? "none" : "default";
    } else {
      renderer.eventTarget.style.cursor = "default";
    }

    const state = getState();
    if (!state || deps.lobby.isActive()) return;
    const { x, y } = renderer.clientToSurface(e.clientX, e.clientY);
    dispatchPointerMove(x, y, state, deps);
  });

  renderer.eventTarget.addEventListener("click", (e) => {
    if (isTouchSuppressed()) return;
    const { x, y } = renderer.clientToSurface(e.clientX, e.clientY);
    const mode = getMode();
    const state = getState();

    if (dispatchModeTap(x, y, mode, deps)) return;
    if (!state || !isGameInteractionMode(mode, modeValues)) return;

    if (isSelectionPhase(state.phase)) {
      const tw = coords.screenToWorld(x, y);
      dispatchTowerSelect(
        tw.wx,
        tw.wy,
        state,
        isReselectPhase(state.phase),
        deps,
      );
    } else if (isPlacementPhase(state.phase)) {
      dispatchPlacement(state, deps);
    } else {
      dispatchBattleFire(x, y, state, deps);
    }
  });
}
