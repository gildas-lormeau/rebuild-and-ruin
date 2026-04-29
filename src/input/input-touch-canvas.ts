/**
 * Touch input handler for mobile devices.
 *
 * Maps touch events to the same deps callbacks as mouse/keyboard input.
 * Single-touch only. Gesture discrimination: tap vs drag.
 *
 * ### Pinch suppression state machine
 *
 * After a two-finger pinch, single-touch events are suppressed until all
 * fingers lift. This prevents "ghost taps" when releasing from a pinch gesture.
 *
 *   touchstart (2+ fingers) → pinchActive=true, suppressSingleTouch=true
 *   touchend   (1 finger left) → pinchActive=false (pinch done, suppress still on)
 *   touchend   (0 fingers)     → suppressSingleTouch=false (all clear)
 *
 * While suppressSingleTouch is true, all single-finger events early-return.
 */

import type { RegisterOnlineInputDeps } from "../runtime/runtime-contracts.ts";
import {
  isPlacementPhase,
  isReselectPhase,
  isSelectionPhase,
  Phase,
} from "../shared/core/game-phase.ts";
import { cannonSize } from "../shared/core/spatial.ts";
import type {
  InputReceiver,
  PlayerController,
} from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import { Action } from "../shared/ui/input-action.ts";
import { TAP_MAX_DIST, TAP_MAX_TIME } from "./input.ts";
import {
  dispatchBattleFire,
  dispatchGameAction,
  dispatchModeTap,
  dispatchPlacement,
  dispatchPointerMove,
  dispatchPointerMoveWorld,
  dispatchTowerSelect,
  markTouchTime,
  shouldHandleGameInput,
} from "./input-dispatch.ts";

/** Mutable gesture-tracking state shared across touch handlers. */
interface GestureState {
  touchStartX: number;
  touchStartY: number;
  touchStartTime: number;
  /** True when touchstart landed on the current phantom. Lets a tap on the
   *  piece itself confirm placement (like the overlay confirm button) even
   *  when direct-touch is locked. */
  startedOnPhantom: boolean;
  pinchActive: boolean;
  pinchStartDist: number;
  /** True once fingers moved apart during a pinch (distinguishes zoom from two-finger tap). */
  pinchMoved: boolean;
  /** Suppress single-finger events until all fingers lift (avoids ghost taps after pinch). */
  suppressSingleTouch: boolean;
  /** Delta-drag anchor: cursor world pos + finger screen pos at touchstart.
   *  Cursor world during drag = anchor world + (current screen − anchor screen) × scale.
   *  Decouples cursor world position from camera pans (no feedback loop). */
  dragAnchor: {
    worldX: number;
    worldY: number;
    screenX: number;
    screenY: number;
  } | null;
}

// Function type export — consumed as type-only import by runtime/
/** Minimum finger-distance change (px) to count as a real pinch vs a two-finger tap. */
const PINCH_MOVE_THRESHOLD = 10;

export function registerTouchHandlers(deps: RegisterOnlineInputDeps): void {
  const { renderer, coords } = deps;
  const gestureState = createGestureState();

  renderer.eventTarget.addEventListener(
    "touchstart",
    (e) => handleTouchStart(e, gestureState, deps),
    { passive: false },
  );
  renderer.eventTarget.addEventListener(
    "touchmove",
    (e) => handleTouchMove(e, gestureState, deps),
    { passive: false },
  );
  renderer.eventTarget.addEventListener(
    "touchend",
    (e) => handleTouchEnd(e, gestureState, deps),
    { passive: false },
  );
  renderer.eventTarget.addEventListener("touchcancel", () => {
    if (gestureState.pinchActive) coords.onPinchEnd?.();
    gestureState.pinchActive = false;
    gestureState.suppressSingleTouch = false;
    gestureState.dragAnchor = null;
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
    startedOnPhantom: false,
    pinchActive: false,
    pinchStartDist: 0,
    pinchMoved: false,
    suppressSingleTouch: false,
    dragAnchor: null,
  };
}

function handleTouchStart(
  e: TouchEvent,
  gestureState: GestureState,
  deps: RegisterOnlineInputDeps,
): void {
  e.preventDefault();
  gestureState.startedOnPhantom = false;
  const { renderer, getState, getMode, coords } = deps;

  // Two-finger pinch start (minimum 2 fingers to distinguish from single-touch pan)
  const MIN_PINCH_FINGERS = 2;
  if (e.touches.length >= MIN_PINCH_FINGERS) {
    const c0 = canvasCoords(e.touches[0]!, renderer),
      c1 = canvasCoords(e.touches[1]!, renderer);
    gestureState.pinchStartDist = Math.hypot(c1.x - c0.x, c1.y - c0.y);
    const midX = (c0.x + c1.x) / 2,
      midY = (c0.y + c1.y) / 2;
    coords.onPinchStart?.(midX, midY);
    gestureState.pinchActive = true;
    gestureState.pinchMoved = false;
    gestureState.suppressSingleTouch = true;
    // Drop any single-touch drag anchor — the pinch invalidates the
    // recorded world/screen pair (camera scale changes during pinch).
    // Without this, lifting the 2nd finger with the 1st still down
    // would resume single-touch drag with a stale pre-pinch anchor.
    gestureState.dragAnchor = null;
    return;
  }
  if (gestureState.suppressSingleTouch) return;

  const touch = e.touches[0];
  if (!touch) return;

  gestureState.touchStartX = touch.clientX;
  gestureState.touchStartY = touch.clientY;
  gestureState.touchStartTime = performance.now();

  const { x, y } = canvasCoords(touch, renderer);
  const state = getState();
  if (!state || deps.lobby.isActive()) return;

  // Placement phases: when direct-touch is locked (after the player's first
  // tap-place) or when the tap lands on the current phantom, skip the
  // absolute cursor-move on touchstart. Pure taps stay inert; if the player
  // then drags, touchmove falls through to absolute pointer-move (no anchor
  // set), so the piece tracks the finger directly. The onPhantom flag is
  // recorded so a tap on the piece itself still confirms placement (like
  // the overlay confirm button) even after the lock kicks in.
  if (
    isPlacementPhase(state.phase) &&
    shouldHandleGameInput(getMode(), state)
  ) {
    const locked = deps.isDirectTouchActive?.() ?? false;
    const tile = coords.pixelToTile(x, y);
    let onPhantom = false;
    deps.withPointerPlayer((human) => {
      onPhantom = isOnPhantom(human, state, tile.row, tile.col);
    });
    gestureState.startedOnPhantom = onPhantom;
    if (locked || onPhantom) {
      gestureState.dragAnchor = null;
      return;
    }
  }

  // Update cursor/crosshair position on touch down (skip during transitions —
  // the viewport may still be lerping from a different zone, so screen-to-tile
  // conversion would place the cursor at wrong coordinates).
  if (shouldHandleGameInput(getMode(), state)) {
    // 1. Dispatch cursor at the touched world pos (absolute, using current
    //    viewport). This places the cursor where the user tapped.
    // 2. Record the delta-drag anchor so subsequent touchmove events use
    //    finger screen-delta (camera pans don't shift the cursor world pos).
    // 3. If the tap landed in the outer 25% ring of the viewport, queue a
    //    smooth tap-nudge to bring the tap into the inner 75% comfort zone.
    const tapWorld = coords.screenToWorld(x, y);
    dispatchPointerMove(x, y, state, deps);
    gestureState.dragAnchor = {
      worldX: tapWorld.wx,
      worldY: tapWorld.wy,
      screenX: x,
      screenY: y,
    };
    coords.centerCameraOnTap?.(tapWorld.wx, tapWorld.wy);
  }
}

function handleTouchMove(
  e: TouchEvent,
  gestureState: GestureState,
  deps: RegisterOnlineInputDeps,
): void {
  e.preventDefault();
  const { renderer, getState, coords } = deps;

  // Two-finger pinch move
  if (gestureState.pinchActive && e.touches.length >= 2) {
    const c0 = canvasCoords(e.touches[0]!, renderer),
      c1 = canvasCoords(e.touches[1]!, renderer);
    const dist = Math.hypot(c1.x - c0.x, c1.y - c0.y);
    if (
      !gestureState.pinchMoved &&
      Math.abs(dist - gestureState.pinchStartDist) > PINCH_MOVE_THRESHOLD
    ) {
      gestureState.pinchMoved = true;
    }
    const midX = (c0.x + c1.x) / 2,
      midY = (c0.y + c1.y) / 2;
    // Inverted: scale > 1 = fingers closer = zoom out (viewport grows)
    const scale = gestureState.pinchStartDist / Math.max(1, dist);
    coords.onPinchUpdate?.(midX, midY, scale);
    return;
  }
  if (gestureState.suppressSingleTouch) return;

  const touch = e.touches[0];
  if (!touch) return;

  const { x, y } = canvasCoords(touch, renderer);
  const state = getState();
  if (!state || deps.lobby.isActive()) return;

  // Skip during transitions — viewport may still be lerping from a different
  // zone (e.g. enemy zone after battle), causing wrong cursor placement.
  if (!shouldHandleGameInput(deps.getMode(), state)) return;

  const phase = state.phase;
  const anchor = gestureState.dragAnchor;
  if (anchor && (phase === Phase.WALL_BUILD || phase === Phase.CANNON_PLACE)) {
    // Delta drag (placement phases only): cursor world += finger screen-delta
    // × current viewport scale. Computed via two screenToWorld calls under
    // the current viewport — the vp.x (and vp.y) terms cancel between the
    // two, leaving a pure scale-from-screen-delta. Camera pans during the
    // drag don't shift the cursor's world position.
    //
    // BATTLE intentionally falls through to absolute (`dispatchPointerMove`
    // with `pickHitWorld`) so the crosshair ray-picks elevated geometry
    // under tilt — the player taps to aim/fire there, never drags.
    const w0 = coords.screenToWorld(anchor.screenX, anchor.screenY);
    const w1 = coords.screenToWorld(x, y);
    const targetWx = anchor.worldX + (w1.wx - w0.wx);
    const targetWy = anchor.worldY + (w1.wy - w0.wy);
    dispatchPointerMoveWorld(targetWx, targetWy, state, deps);
    return;
  }

  dispatchPointerMove(x, y, state, deps);
}

function handleTouchEnd(
  e: TouchEvent,
  gestureState: GestureState,
  deps: RegisterOnlineInputDeps,
): void {
  e.preventDefault();
  const { renderer, getState, getMode, coords } = deps;

  // Pinch end
  if (gestureState.pinchActive) {
    if (e.touches.length < 2) {
      const wasTap = !gestureState.pinchMoved;
      gestureState.pinchActive = false;
      coords.onPinchEnd?.();
      if (e.touches.length === 0) gestureState.suppressSingleTouch = false;
      // Two-finger tap without movement → rotate
      if (wasTap) {
        const state = getState();
        if (shouldHandleGameInput(getMode(), state)) {
          deps.withPointerPlayer((human) => {
            dispatchGameAction(human, Action.ROTATE, state, deps.gameAction);
          });
        }
      }
    }
    return;
  }
  if (gestureState.suppressSingleTouch) {
    if (e.touches.length === 0) gestureState.suppressSingleTouch = false;
    return;
  }

  const touch = e.changedTouches[0];
  if (!touch) return;
  markTouchTime();

  const { x, y } = canvasCoords(touch, renderer);
  const mode = getMode();
  const state = getState();
  const tap = isTap(touch, gestureState);

  // Non-game modes: tap acts as click
  if (tap && dispatchModeTap(x, y, mode, deps)) return;

  if (!shouldHandleGameInput(mode, state)) return;

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

  // Build / Cannon placement on touch release. Two paths place a piece:
  //  - Tap on the phantom itself: confirms placement (same effect as the
  //    floating overlay confirm button). Works in both locked and unlocked
  //    states so the player's "tap the piece to place it" muscle memory
  //    survives the lockout.
  //  - Tap elsewhere on the map while unlocked: places at the tapped tile.
  //    Afterwards direct-touch locks, so subsequent taps near overlay
  //    buttons can't accidentally trigger another placement.
  // A locked tap on empty map is inert. Drag-end never commits — drags are
  // for repositioning only; the player commits via tap-on-piece, the
  // overlay confirm button, or the d-pad (which also clears the lock).
  if (tap && isPlacementPhase(state.phase)) {
    const locked = deps.isDirectTouchActive?.() ?? false;
    if (gestureState.startedOnPhantom || !locked) {
      dispatchPlacement(state, deps);
      deps.setDirectTouchActive?.(true);
    }
  }

  // Battle: always fire on touch release (tap or drag)
  dispatchBattleFire(x, y, state, deps);

  // Clear delta-drag anchor only when the last finger lifts (a stray
  // changedTouches[0] doesn't necessarily mean all fingers are off).
  if (e.touches.length === 0) gestureState.dragAnchor = null;
}

function canvasCoords(
  touch: Touch,
  renderer: RegisterOnlineInputDeps["renderer"],
): { x: number; y: number } {
  return renderer.clientToSurface(touch.clientX, touch.clientY);
}

function isTap(touch: Touch, gestureState: GestureState): boolean {
  const dx = touch.clientX - gestureState.touchStartX;
  const dy = touch.clientY - gestureState.touchStartY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const duration = performance.now() - gestureState.touchStartTime;
  return dist < TAP_MAX_DIST && duration < TAP_MAX_TIME;
}

/** Check whether a tile position overlaps the current piece/cannon phantom. */
function isOnPhantom(
  human: PlayerController & InputReceiver,
  state: GameState,
  row: number,
  col: number,
): boolean {
  const phase = state.phase;
  if (phase === Phase.WALL_BUILD) {
    const piece = state.players[human.playerId]?.currentPiece;
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
