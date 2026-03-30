import type { RegisterOnlineInputDeps } from "./input.ts";
import {
  dispatchBattleFire,
  dispatchModeTap,
  dispatchPlacement,
  dispatchPointerMove,
  dispatchTowerSelect,
  isTouchSuppressed,
} from "./input-dispatch.ts";
import { CURSOR_DEFAULT, CURSOR_POINTER } from "./platform.ts";
import {
  isInteractiveMode,
  isPlacementPhase,
  isReselectPhase,
  isSelectionPhase,
  Mode,
  Phase,
} from "./types.ts";

const CLICK_EVENT = "click";

// Note: keyboard checks mode in per-handler switches (different keys per mode).
// Mouse checks mode at event-handler level because all mouse actions share the
// same guard: no game state → no-op, lobby active → lobby hit-test only.
export function registerMouseHandlers(deps: RegisterOnlineInputDeps): void {
  const { renderer, getState, getMode, coords } = deps;

  renderer.eventTarget.addEventListener("mousemove", (e) => {
    const mode = getMode();
    const { x, y } = renderer.clientToSurface(e.clientX, e.clientY);
    if (mode === Mode.LOBBY) {
      renderer.eventTarget.style.cursor = deps.lobby.cursorAt(x, y);
    } else if (mode === Mode.STOPPED) {
      renderer.eventTarget.style.cursor = CURSOR_POINTER;
    } else if (mode === Mode.OPTIONS) {
      renderer.eventTarget.style.cursor = deps.options.cursorAt(x, y);
    } else if (mode === Mode.CONTROLS) {
      renderer.eventTarget.style.cursor = deps.options.controlsCursorAt(x, y);
    } else if (mode === Mode.GAME) {
      const state = getState();
      renderer.eventTarget.style.cursor =
        state?.phase === Phase.BATTLE ? "none" : CURSOR_DEFAULT;
    } else {
      renderer.eventTarget.style.cursor = CURSOR_DEFAULT;
    }

    const state = getState();
    if (!state || deps.lobby.isActive()) return;
    dispatchPointerMove(x, y, state, deps);
  });

  renderer.eventTarget.addEventListener(CLICK_EVENT, (e) => {
    if (isTouchSuppressed()) return;
    const { x, y } = renderer.clientToSurface(e.clientX, e.clientY);
    const mode = getMode();
    const state = getState();

    if (dispatchModeTap(x, y, mode, deps)) return;
    if (!state || !isInteractiveMode(mode)) return;

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
