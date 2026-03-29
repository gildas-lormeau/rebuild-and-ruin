/**
 * Touch input handler for mobile devices.
 *
 * Maps touch events to the same deps callbacks as mouse/keyboard input.
 * Single-touch only. Gesture discrimination: tap vs drag.
 */

import type {
  InputReceiver,
  PlayerController,
} from "./controller-interfaces.ts";
import {
  type RegisterOnlineInputDeps,
  TAP_MAX_DIST,
  TAP_MAX_TIME,
} from "./input.ts";
import {
  dispatchBattleFire,
  dispatchModeTap,
  dispatchPlacement,
  dispatchPointerMove,
  dispatchTowerSelect,
  isGameInteractionMode,
  markTouchTime,
} from "./input-dispatch.ts";
import { cannonSize } from "./spatial.ts";
import {
  isPlacementPhase,
  isReselectPhase,
  isSelectionPhase,
  Phase,
} from "./types.ts";

/** Mutable gesture-tracking state shared across touch handlers. */
interface GestureState {
  touchStartX: number;
  touchStartY: number;
  touchStartTime: number;
  /** Set when touchstart lands directly on the current phantom (tap confirms placement). */
  touchedPhantom: boolean;
  pinchActive: boolean;
  pinchStartDist: number;
  /** Suppress single-finger events until all fingers lift (avoids ghost taps after pinch). */
  suppressSingleTouch: boolean;
}

export function registerTouchHandlers(deps: RegisterOnlineInputDeps): void {
  const { renderer, coords } = deps;
  const gs = createGestureState();

  renderer.eventTarget.addEventListener(
    "touchstart",
    (e) => handleTouchStart(e, gs, deps),
    { passive: false },
  );
  renderer.eventTarget.addEventListener(
    "touchmove",
    (e) => handleTouchMove(e, gs, deps),
    { passive: false },
  );
  renderer.eventTarget.addEventListener(
    "touchend",
    (e) => handleTouchEnd(e, gs, deps),
    { passive: false },
  );
  renderer.eventTarget.addEventListener("touchcancel", () => {
    if (gs.pinchActive) coords.onPinchEnd?.();
    gs.pinchActive = false;
    gs.suppressSingleTouch = false;
  });
  renderer.eventTarget.addEventListener("contextmenu", (e) =>
    e.preventDefault(),
  );
}

function createGestureState(): GestureState {
  return {
    touchStartX: 0,
    touchStartY: 0,
    touchStartTime: 0,
    touchedPhantom: false,
    pinchActive: false,
    pinchStartDist: 0,
    suppressSingleTouch: false,
  };
}

function handleTouchStart(
  e: TouchEvent,
  gs: GestureState,
  deps: RegisterOnlineInputDeps,
): void {
  e.preventDefault();
  gs.touchedPhantom = false;
  const { renderer, getState, getMode, coords } = deps;

  // Two-finger pinch start (minimum 2 fingers to distinguish from single-touch pan)
  const MIN_PINCH_FINGERS = 2;
  if (e.touches.length >= MIN_PINCH_FINGERS) {
    const c0 = canvasCoords(e.touches[0]!, renderer),
      c1 = canvasCoords(e.touches[1]!, renderer);
    gs.pinchStartDist = Math.hypot(c1.x - c0.x, c1.y - c0.y);
    const midX = (c0.x + c1.x) / 2,
      midY = (c0.y + c1.y) / 2;
    coords.onPinchStart?.(midX, midY);
    gs.pinchActive = true;
    gs.suppressSingleTouch = true;
    return;
  }
  if (gs.suppressSingleTouch) return;

  const touch = e.touches[0];
  if (!touch) return;

  gs.touchStartX = touch.clientX;
  gs.touchStartY = touch.clientY;
  gs.touchStartTime = performance.now();

  const { x, y } = canvasCoords(touch, renderer);
  const state = getState();
  if (!state || deps.lobby.isActive()) return;

  // Tap-on-phantom: if the touch lands directly on the current phantom,
  // skip cursor movement so the tap can confirm placement at touchend.
  if (
    isPlacementPhase(state.phase) &&
    isGameInteractionMode(getMode(), deps.modeValues)
  ) {
    const tile = coords.pixelToTile(x, y);
    let hit = false;
    deps.withFirstHuman((human) => {
      hit = isOnPhantom(human, state.phase, tile.row, tile.col);
    });
    if (hit) {
      gs.touchedPhantom = true;
      return;
    }
  }

  // Activate floating buttons when touching the canvas during placement phases
  if (isPlacementPhase(state.phase)) {
    deps.setDirectTouchActive?.(true);
  }

  // Update cursor/crosshair position on touch down
  dispatchPointerMove(x, y, state, deps);
}

function handleTouchMove(
  e: TouchEvent,
  gs: GestureState,
  deps: RegisterOnlineInputDeps,
): void {
  e.preventDefault();
  const { renderer, getState, coords } = deps;

  // Two-finger pinch move
  if (gs.pinchActive && e.touches.length >= 2) {
    const c0 = canvasCoords(e.touches[0]!, renderer),
      c1 = canvasCoords(e.touches[1]!, renderer);
    const dist = Math.hypot(c1.x - c0.x, c1.y - c0.y);
    const midX = (c0.x + c1.x) / 2,
      midY = (c0.y + c1.y) / 2;
    // Inverted: scale > 1 = fingers closer = zoom out (viewport grows)
    const scale = gs.pinchStartDist / Math.max(1, dist);
    coords.onPinchUpdate?.(midX, midY, scale);
    return;
  }
  if (gs.suppressSingleTouch) return;

  const touch = e.touches[0];
  if (!touch) return;

  const { x, y } = canvasCoords(touch, renderer);
  const state = getState();
  if (!state || deps.lobby.isActive()) return;

  dispatchPointerMove(x, y, state, deps);
}

function handleTouchEnd(
  e: TouchEvent,
  gs: GestureState,
  deps: RegisterOnlineInputDeps,
): void {
  e.preventDefault();
  const { renderer, getState, getMode, coords } = deps;

  // Pinch end
  if (gs.pinchActive) {
    if (e.touches.length < 2) {
      gs.pinchActive = false;
      coords.onPinchEnd?.();
      if (e.touches.length === 0) gs.suppressSingleTouch = false;
    }
    return;
  }
  if (gs.suppressSingleTouch) {
    if (e.touches.length === 0) gs.suppressSingleTouch = false;
    return;
  }

  const touch = e.changedTouches[0];
  if (!touch) return;
  markTouchTime();

  const { x, y } = canvasCoords(touch, renderer);
  const mode = getMode();
  const state = getState();
  const tap = isTap(touch, gs);

  // Non-game modes: tap acts as click
  if (tap && dispatchModeTap(x, y, mode, deps)) return;

  if (!state || !isGameInteractionMode(mode, deps.modeValues)) return;

  // Selection: first tap highlights, second tap on same tower confirms
  if (tap && isSelectionPhase(state.phase)) {
    const w = coords.screenToWorld(x, y);
    dispatchTowerSelect(
      w.wx,
      w.wy,
      state,
      isReselectPhase(state.phase),
      deps,
      true,
    );
  }

  // Build / Cannon: tap on phantom places directly; otherwise tap-to-place when no floating buttons
  if (tap && (gs.touchedPhantom || !deps.isDirectTouchActive?.())) {
    dispatchPlacement(state, deps);
  }

  // Battle: always fire on touch release (tap or drag)
  dispatchBattleFire(x, y, state, deps);
}

function canvasCoords(
  touch: Touch,
  renderer: RegisterOnlineInputDeps["renderer"],
): { x: number; y: number } {
  return renderer.clientToSurface(touch.clientX, touch.clientY);
}

function isTap(touch: Touch, gs: GestureState): boolean {
  const dx = touch.clientX - gs.touchStartX;
  const dy = touch.clientY - gs.touchStartY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const duration = performance.now() - gs.touchStartTime;
  return dist < TAP_MAX_DIST && duration < TAP_MAX_TIME;
}

/** Check whether a tile position overlaps the current piece/cannon phantom. */
function isOnPhantom(
  human: PlayerController & InputReceiver,
  phase: Phase,
  row: number,
  col: number,
): boolean {
  if (phase === Phase.WALL_BUILD) {
    const piece = human.getCurrentPiece();
    if (!piece) return false;
    const cr = human.buildCursor.row;
    const cc = human.buildCursor.col;
    return piece.offsets.some(([dr, dc]) => cr + dr === row && cc + dc === col);
  }
  if (phase === Phase.CANNON_PLACE) {
    const mode = human.getCannonPlaceMode();
    const size = cannonSize(mode);
    const cr = human.cannonCursor.row;
    const cc = human.cannonCursor.col;
    return row >= cr && row < cr + size && col >= cc && col < cc + size;
  }
  return false;
}
