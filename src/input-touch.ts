/**
 * Touch input handler for mobile devices.
 *
 * Maps touch events to the same deps callbacks as mouse/keyboard input.
 * Single-touch only. Gesture discrimination: tap vs drag.
 */

import type { InputReceiver, PlayerController } from "./controller-interfaces.ts";
import type { RegisterOnlineInputDeps } from "./input.ts";
import { clientToCanvas, dispatchBattleFire, dispatchModeTap, dispatchPlacement, dispatchPointerMove, dispatchTowerSelect, isGameInteractionMode, markTouchTime } from "./input-dispatch.ts";
import { BALLOON_SIZE, CannonMode, isPlacementPhase, isSelectionPhase, NORMAL_CANNON_SIZE, Phase, SUPER_GUN_SIZE } from "./types.ts";

const TAP_MAX_DIST = 20;
  // CSS pixels
const TAP_MAX_TIME = 300;

export function registerTouchHandlers(deps: RegisterOnlineInputDeps): void {
  const {
    canvas,
    getState,
    getMode,
    isLobbyActive,
    screenToWorld,
    onPinchStart,
    onPinchUpdate,
    onPinchEnd,
  } = deps;

  // Gesture tracking
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;
  /** Set when touchstart lands directly on the current phantom (tap confirms placement). */
  let phantomTapped = false;

  // Pinch-to-zoom tracking
  let pinchActive = false;
  let pinchStartDist = 0;
  let suppressSingleTouch = false;

  function canvasCoords(touch: Touch): { x: number; y: number } {
    return clientToCanvas(touch.clientX, touch.clientY, canvas);
  }

  function isTap(touch: Touch): boolean {
    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const duration = performance.now() - touchStartTime;
    return dist < TAP_MAX_DIST && duration < TAP_MAX_TIME;
  }

  // --- touchstart: record gesture start + update cursor position ---
  canvas.addEventListener("touchstart", (e) => {
    e.preventDefault();
    phantomTapped = false;

    // Two-finger pinch start
    if (e.touches.length >= 2) {
      const c0 = canvasCoords(e.touches[0]!), c1 = canvasCoords(e.touches[1]!);
      pinchStartDist = Math.hypot(c1.x - c0.x, c1.y - c0.y);
      const midX = (c0.x + c1.x) / 2, midY = (c0.y + c1.y) / 2;
      onPinchStart?.(midX, midY);
      pinchActive = true;
      suppressSingleTouch = true;
      return;
    }
    if (suppressSingleTouch) return;

    const touch = e.touches[0];
    if (!touch) return;

    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    touchStartTime = performance.now();

    const { x, y } = canvasCoords(touch);
    const state = getState();
    if (!state || isLobbyActive()) return;

    // Tap-on-phantom: if the touch lands directly on the current phantom,
    // skip cursor movement so the tap can confirm placement at touchend.
    if (isPlacementPhase(state.phase) && isGameInteractionMode(getMode(), deps.modeValues)) {
      const tile = deps.pixelToTile(x, y);
      let hit = false;
      deps.withFirstHuman((human) => {
        hit = isOnPhantom(human, state.phase, tile.row, tile.col);
      });
      if (hit) {
        phantomTapped = true;
        return;
      }
    }

    // Activate floating buttons when touching the canvas during placement phases
    if (isPlacementPhase(state.phase)) {
      deps.setDirectTouchActive?.(true);
    }

    // Update cursor/crosshair position on touch down
    dispatchPointerMove(x, y, state, deps);
  }, { passive: false });

  // --- touchmove: update cursor/crosshair as finger drags ---
  canvas.addEventListener("touchmove", (e) => {
    e.preventDefault();

    // Two-finger pinch move
    if (pinchActive && e.touches.length >= 2) {
      const c0 = canvasCoords(e.touches[0]!), c1 = canvasCoords(e.touches[1]!);
      const dist = Math.hypot(c1.x - c0.x, c1.y - c0.y);
      const midX = (c0.x + c1.x) / 2, midY = (c0.y + c1.y) / 2;
      // Inverted: scale > 1 = fingers closer = zoom out (viewport grows)
      const scale = pinchStartDist / Math.max(1, dist);
      onPinchUpdate?.(midX, midY, scale);
      return;
    }
    if (suppressSingleTouch) return;

    const touch = e.touches[0];
    if (!touch) return;

    const { x, y } = canvasCoords(touch);
    const state = getState();
    if (!state || isLobbyActive()) return;

    dispatchPointerMove(x, y, state, deps);
  }, { passive: false });

  // --- touchend: tap = commit action, drag-release = fire in battle only ---
  canvas.addEventListener("touchend", (e) => {
    e.preventDefault();

    // Pinch end
    if (pinchActive) {
      if (e.touches.length < 2) {
        pinchActive = false;
        onPinchEnd?.();
        if (e.touches.length === 0) suppressSingleTouch = false;
      }
      return;
    }
    if (suppressSingleTouch) {
      if (e.touches.length === 0) suppressSingleTouch = false;
      return;
    }

    const touch = e.changedTouches[0];
    if (!touch) return;
    markTouchTime();

    const { x, y } = canvasCoords(touch);
    const mode = getMode();
    const state = getState();
    const tap = isTap(touch);

    // Non-game modes: tap acts as click
    if (tap && dispatchModeTap(x, y, mode, deps)) return;

    if (!state || !isGameInteractionMode(mode, deps.modeValues)) return;

    // Selection: first tap highlights, second tap on same tower confirms
    if (tap && isSelectionPhase(state.phase)) {
      const w = screenToWorld(x, y);
      dispatchTowerSelect(w.wx, w.wy, state, state.phase === Phase.CASTLE_RESELECT, deps, true);
    }

    // Build / Cannon: tap on phantom places directly; otherwise tap-to-place when no floating buttons
    if (tap && (phantomTapped || !deps.isDirectTouchActive?.())) {
      dispatchPlacement(state, deps);
    }

    // Battle: always fire on touch release (tap or drag)
    dispatchBattleFire(x, y, state, deps);
  }, { passive: false });

  // Reset pinch state if OS cancels touches (e.g. phone call, gesture conflict)
  canvas.addEventListener("touchcancel", () => {
    if (pinchActive) onPinchEnd?.();
    pinchActive = false;
    suppressSingleTouch = false;
  });

  // Prevent long-press context menu
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
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
    const size = mode === CannonMode.SUPER ? SUPER_GUN_SIZE
      : mode === CannonMode.BALLOON ? BALLOON_SIZE
      : NORMAL_CANNON_SIZE;
    const cr = human.cannonCursor.row;
    const cc = human.cannonCursor.col;
    return row >= cr && row < cr + size && col >= cc && col < cc + size;
  }
  return false;
}
