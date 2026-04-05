import {
  Action,
  isInteractiveMode,
  isPlacementPhase,
  isReselectPhase,
  isSelectionPhase,
  Mode,
  Phase,
} from "../shared/game-phase.ts";
import { CURSOR_DEFAULT, CURSOR_POINTER } from "../shared/platform.ts";
import type { RegisterOnlineInputDeps } from "./input.ts";
import {
  dispatchBattleFire,
  dispatchGameAction,
  dispatchModeTap,
  dispatchPlacement,
  dispatchPointerMove,
  dispatchTowerSelect,
  isTouchSuppressed,
} from "./input-dispatch.ts";

// Function type export — consumed as type-only import by runtime/
export type RegisterMouseHandlersFn = (deps: RegisterOnlineInputDeps) => void;

const CLICK_EVENT = "click";

// Note: keyboard checks mode in per-handler switches (different keys per mode).
// Mouse checks mode at event-handler level because all mouse actions share the
// same guard: no game state → no-op, lobby active → lobby hit-test only.
//
// Touch-suppression: all mouse click handlers MUST call isTouchSuppressed()
// before dispatching — see markTouchTime() pairing in input-dispatch.ts.
// This prevents synthetic click events that mobile browsers fire after touchend.
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

  // Touch-suppression check: touchend calls markTouchTime() in input-touch-canvas.ts;
  // this guard prevents the synthetic click that mobile browsers fire after touchend.
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

  // Right-click rotates piece / cycles cannon mode / rotates aim
  renderer.eventTarget.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (isTouchSuppressed()) return;
    const state = getState();
    if (!state || !isInteractiveMode(getMode())) return;
    deps.withPointerPlayer((human) => {
      dispatchGameAction(human, Action.ROTATE, state, deps.gameAction);
    });
  });
}
