/**
 * Touch input handler for mobile devices.
 *
 * Maps touch events to the same deps callbacks as mouse/keyboard input.
 * Single-touch only. Gesture discrimination: tap vs drag.
 */

import { towerAtPixel } from "./spatial.ts";

import { Phase } from "./types.ts";
import type { RegisterOnlineInputDeps } from "./input.ts";

const TAP_MAX_DIST = 20;  // CSS pixels
const TAP_MAX_TIME = 300;  // ms

export function registerTouchHandlers(deps: RegisterOnlineInputDeps): void {
  const {
    canvas,
    getState,
    getMode,
    modeValues,
    isLobbyActive,
    lobbyClick,
    showLobby,
    rematch,
    getGameOverFocused,
    closeOptions,
    closeControls,
    getControlsState,
    getLifeLostDialog,
    lifeLostDialogClick,
    withFirstHuman,
    pixelToTile,
    screenToWorld,
    onPinchStart,
    onPinchUpdate,
    onPinchEnd,
    maybeSendAimUpdate,
    tryPlaceCannonAndSend,
    tryPlacePieceAndSend,
    fireAndSend,
    getSelectionStates,
    highlightTowerForPlayer,
    confirmSelectionForPlayer,
    finishReselection,
    finishSelection,
    isHost,
    render,
  } = deps;

  // Gesture tracking
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;

  // Pinch-to-zoom tracking
  let pinchActive = false;
  let pinchStartDist = 0;
  let suppressSingleTouch = false;

  function canvasCoords(touch: Touch): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (touch.clientX - rect.left) * (canvas.width / rect.width),
      y: (touch.clientY - rect.top) * (canvas.height / rect.height),
    };
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

    // Update cursor/crosshair position on touch down
    if (state.phase === Phase.CASTLE_SELECT || state.phase === Phase.CASTLE_RESELECT) {
      withFirstHuman((human) => {
        const ss = getSelectionStates().get(human.playerId);
        if (!ss || ss.confirmed) return;
        const zone = state.playerZones[human.playerId] ?? 0;
        const w = screenToWorld(x, y);
        const idx = towerAtPixel(state.map.towers, w.wx, w.wy);
        if (idx !== null && idx !== ss.highlighted) {
          highlightTowerForPlayer(idx, zone, human.playerId);
        }
      });
    } else if (state.phase === Phase.WALL_BUILD) {
      withFirstHuman((human) => {
        const { row, col } = pixelToTile(x, y);
        human.setBuildCursor(row, col);
      });
    } else if (state.phase === Phase.CANNON_PLACE) {
      withFirstHuman((human) => {
        const { row, col } = pixelToTile(x, y);
        human.setCannonCursor(row, col);
        render();
      });
    } else if (state.phase === Phase.BATTLE) {
      withFirstHuman((human) => {
        const w = screenToWorld(x, y);
        human.setCrosshair(w.wx, w.wy);
        maybeSendAimUpdate(w.wx, w.wy);
      });
    }
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

    if (state.phase === Phase.CASTLE_SELECT || state.phase === Phase.CASTLE_RESELECT) {
      withFirstHuman((human) => {
        const ss = getSelectionStates().get(human.playerId);
        if (!ss || ss.confirmed) return;
        const zone = state.playerZones[human.playerId] ?? 0;
        const w = screenToWorld(x, y);
        const idx = towerAtPixel(state.map.towers, w.wx, w.wy);
        if (idx !== null && idx !== ss.highlighted) {
          highlightTowerForPlayer(idx, zone, human.playerId);
        }
      });
    } else if (state.phase === Phase.WALL_BUILD) {
      withFirstHuman((human) => {
        const { row, col } = pixelToTile(x, y);
        human.setBuildCursor(row, col);
      });
    } else if (state.phase === Phase.CANNON_PLACE) {
      withFirstHuman((human) => {
        const { row, col } = pixelToTile(x, y);
        human.setCannonCursor(row, col);
        render();
      });
    } else if (state.phase === Phase.BATTLE) {
      withFirstHuman((human) => {
        const w = screenToWorld(x, y);
        human.setCrosshair(w.wx, w.wy);
        maybeSendAimUpdate(w.wx, w.wy);
      });
    }
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

    const { x, y } = canvasCoords(touch);
    const mode = getMode();
    const state = getState();
    const tap = isTap(touch);

    // Non-game modes: tap acts as click
    if (tap) {
      if (mode === modeValues.STOPPED) {
        if (getGameOverFocused() === "rematch") rematch();
        else showLobby();
        return;
      }
      if (mode === modeValues.OPTIONS) { closeOptions(); return; }
      if (mode === modeValues.CONTROLS) {
        if (!getControlsState().rebinding) closeControls();
        return;
      }
      if (mode === modeValues.LIFE_LOST && getLifeLostDialog()) {
        lifeLostDialogClick(x, y);
        return;
      }
      if (isLobbyActive()) { lobbyClick(x, y); return; }
    }

    if (!state) return;

    // Selection: tap to confirm
    if (tap && (state.phase === Phase.CASTLE_SELECT || state.phase === Phase.CASTLE_RESELECT)) {
      const isReselect = state.phase === Phase.CASTLE_RESELECT;
      withFirstHuman((human) => {
        const ss = getSelectionStates().get(human.playerId);
        if (!ss || ss.confirmed) return;
        const zone = state.playerZones[human.playerId] ?? 0;
        const w = screenToWorld(x, y);
        const idx = towerAtPixel(state.map.towers, w.wx, w.wy);
        if (idx !== null && state.map.towers[idx]?.zone === zone) {
          highlightTowerForPlayer(idx, zone, human.playerId);
          if (confirmSelectionForPlayer(human.playerId, isReselect) && isHost()) {
            if (isReselect) finishReselection();
            else finishSelection();
          }
        }
      });
    }

    // Build: tap to place (cursor already set on touchstart/touchmove)
    if (tap && state.phase === Phase.WALL_BUILD) {
      withFirstHuman((human) => {
        tryPlacePieceAndSend(human, state);
      });
    }

    // Cannon: tap to place (cursor already set on touchstart/touchmove)
    if (tap && state.phase === Phase.CANNON_PLACE) {
      withFirstHuman((human) => {
        const max = state.cannonLimits[human.playerId] ?? 0;
        tryPlaceCannonAndSend(human, state, max);
        render();
      });
    }

    // Battle: always fire on touch release (tap or drag)
    if (state.phase === Phase.BATTLE && state.timer > 0 && state.battleCountdown <= 0) {
      withFirstHuman((human) => {
        const w = screenToWorld(x, y);
        human.setCrosshair(w.wx, w.wy);
        fireAndSend(human, state);
      });
    }
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
