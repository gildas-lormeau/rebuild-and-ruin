/**
 * Shared input dispatch helpers.
 *
 * Pure functions that translate pointer/tap events into game actions.
 * Used by mouse input (input.ts), touch input (input-touch.ts),
 * and touch UI controls (touch-ui.ts).
 */

import type { InputReceiver, PlayerController } from "./controller-interfaces.ts";
import type { WorldPos } from "./geometry-types.ts";
import type { LifeLostDialogState } from "./life-lost.ts";
import { towerAtPixel } from "./spatial.ts";
import { type ControlsState, type GameState, isSelectionPhase, Phase, type SelectionState } from "./types.ts";

export interface ModeValues {
  LOBBY: number;
  OPTIONS: number;
  CONTROLS: number;
  SELECTION: number;
  BANNER: number;
  BALLOON_ANIM: number;
  CASTLE_BUILD: number;
  LIFE_LOST: number;
  GAME: number;
  STOPPED: number;
}

const TOUCH_CLICK_SUPPRESS_MS = 500;

/** Timestamp of last touchend; suppresses synthetic click events on mobile. */
let lastTouchTime = 0;

export function markTouchTime(): void { lastTouchTime = performance.now(); }

/** Whether a recent touch should suppress the current synthetic click. */
export function isTouchSuppressed(): boolean { return performance.now() - lastTouchTime < TOUCH_CLICK_SUPPRESS_MS; }

/** Whether the current mode allows gameplay interaction (tower selection or active game). */
export function isGameInteractionMode(mode: number, mv: { GAME: number; SELECTION: number }): boolean {
  return mode === mv.GAME || mode === mv.SELECTION;
}

/**
 * Convert a client-space coordinate to canvas backing-store coordinates,
 * accounting for object-fit:contain letterboxing.
 */
export function clientToCanvas(clientX: number, clientY: number, canvas: HTMLCanvasElement): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const { contentW, contentH, offsetX, offsetY } = computeLetterboxLayout(canvas, rect);
  return {
    x: ((clientX - rect.left - offsetX) / contentW) * canvas.width,
    y: ((clientY - rect.top - offsetY) / contentH) * canvas.height,
  };
}

/**
 * Compute the letterbox layout for a canvas inside a container,
 * assuming object-fit:contain scaling.
 */
export function computeLetterboxLayout(canvas: HTMLCanvasElement, rect: DOMRect): { contentW: number; contentH: number; offsetX: number; offsetY: number } {
  const canvasRatio = canvas.width / canvas.height;
  const rectRatio = rect.width / rect.height;
  if (rectRatio > canvasRatio) {
    const contentH = rect.height;
    const contentW = rect.height * canvasRatio;
    return { contentW, contentH, offsetX: (rect.width - contentW) / 2, offsetY: 0 };
  }
  const contentW = rect.width;
  const contentH = rect.width / canvasRatio;
  return { contentW, contentH, offsetX: 0, offsetY: (rect.height - contentH) / 2 };
}

/** Shared mode-tap dispatch — handles non-game UI taps (game over, options, lobby, etc.). Returns true if consumed. */
export function dispatchModeTap(
  x: number,
  y: number,
  mode: number,
  deps: {
    modeValues: ModeValues;
    gameOverClick: (x: number, y: number) => void;
    closeOptions: () => void;
    closeControls: () => void;
    getControlsState: () => ControlsState;
    getLifeLostDialog: () => LifeLostDialogState | null;
    lifeLostDialogClick: (x: number, y: number) => void;
    isLobbyActive: () => boolean;
    lobbyClick: (x: number, y: number) => boolean;
  },
): boolean {
  const { modeValues, gameOverClick, closeOptions, closeControls, getControlsState, getLifeLostDialog, lifeLostDialogClick, isLobbyActive, lobbyClick } = deps;
  if (mode === modeValues.STOPPED) {
    gameOverClick(x, y);
    return true;
  }
  if (mode === modeValues.OPTIONS) { closeOptions(); return true; }
  if (mode === modeValues.CONTROLS) {
    if (!getControlsState().rebinding) closeControls();
    return true;
  }
  if (mode === modeValues.LIFE_LOST && getLifeLostDialog()) {
    lifeLostDialogClick(x, y);
    return true;
  }
  if (isLobbyActive()) { lobbyClick(x, y); return true; }
  return false;
}

/** Shared tower-selection tap — first tap highlights, same tower again confirms. */
export function dispatchTowerSelect(
  wx: number,
  wy: number,
  state: GameState,
  isReselect: boolean,
  deps: {
    withFirstHuman: (action: (human: PlayerController & InputReceiver) => void) => void;
    getSelectionStates: () => Map<number, SelectionState>;
    highlightTowerForPlayer: (idx: number, zone: number, pid: number) => void;
    confirmSelectionForPlayer: (pid: number, isReselect?: boolean) => boolean;
    isSelectionReady?: () => boolean;
  },
  requireDoubleTap = false,
): void {
  if (deps.isSelectionReady && !deps.isSelectionReady()) return;
  deps.withFirstHuman((human) => {
    const ss = deps.getSelectionStates().get(human.playerId);
    if (!ss || ss.confirmed) return;
    const zone = state.playerZones[human.playerId] ?? 0;
    const idx = towerAtPixel(state.map.towers, wx, wy);
    if (idx !== null && state.map.towers[idx]?.zone === zone) {
      const alreadyHighlighted = ss.highlighted === idx;
      if (alreadyHighlighted && (!requireDoubleTap || ss.tapped)) {
        deps.confirmSelectionForPlayer(human.playerId, isReselect);
      } else {
        deps.highlightTowerForPlayer(idx, zone, human.playerId);
        // Mark tapped only when re-tapping the already-highlighted tower;
        // switching to a different tower resets so you can browse freely.
        ss.tapped = alreadyHighlighted;
      }
    }
  });
}

/** Shared placement dispatch — place piece or cannon for the first human player. */
export function dispatchPlacement(
  state: GameState,
  deps: {
    withFirstHuman: (action: (human: PlayerController & InputReceiver) => void) => void;
    tryPlacePieceAndSend: (human: PlayerController & InputReceiver, state: GameState) => void;
    tryPlaceCannonAndSend: (human: PlayerController & InputReceiver, state: GameState, max: number) => void;
  },
): void {
  deps.withFirstHuman((human) => {
    if (state.phase === Phase.WALL_BUILD) {
      deps.tryPlacePieceAndSend(human, state);
    } else if (state.phase === Phase.CANNON_PLACE) {
      const max = state.cannonLimits[human.playerId] ?? 0;
      deps.tryPlaceCannonAndSend(human, state, max);
    }
  });
}

/** Shared battle-fire dispatch — aim and fire for the first human player. */
export function dispatchBattleFire(
  x: number,
  y: number,
  state: GameState,
  deps: {
    withFirstHuman: (action: (human: PlayerController & InputReceiver) => void) => void;
    screenToWorld: (x: number, y: number) => WorldPos;
    fireAndSend: (ctrl: PlayerController, gameState: GameState) => void;
  },
): void {
  if (state.phase !== Phase.BATTLE || state.timer <= 0 || state.battleCountdown > 0) return;
  deps.withFirstHuman((human) => {
    const w = deps.screenToWorld(x, y);
    human.setCrosshair(w.wx, w.wy);
    deps.fireAndSend(human, state);
  });
}

/** Shared pointer-move dispatch — updates cursor/crosshair based on current phase. */
export function dispatchPointerMove(
  x: number,
  y: number,
  state: GameState,
  deps: {
    withFirstHuman: (action: (human: PlayerController & InputReceiver) => void) => void;
    getSelectionStates: () => Map<number, SelectionState>;
    screenToWorld: (x: number, y: number) => WorldPos;
    highlightTowerForPlayer: (idx: number, zone: number, pid: number) => void;
    pixelToTile: (x: number, y: number) => { row: number; col: number };
    maybeSendAimUpdate: (x: number, y: number) => void;
    isSelectionReady?: () => boolean;
  },
): void {
  const { withFirstHuman, getSelectionStates, screenToWorld, highlightTowerForPlayer, pixelToTile, maybeSendAimUpdate } = deps;
  if (isSelectionPhase(state.phase)) {
    if (deps.isSelectionReady && !deps.isSelectionReady()) return;
    withFirstHuman((human) => {
      const ss = getSelectionStates().get(human.playerId);
      if (!ss || ss.confirmed) return;
      const zone = state.playerZones[human.playerId] ?? 0;
      const w = screenToWorld(x, y);
      const idx = towerAtPixel(state.map.towers, w.wx, w.wy);
      if (idx !== null && idx !== ss.highlighted && state.map.towers[idx]?.zone === zone) {
        highlightTowerForPlayer(idx, zone, human.playerId);
        ss.tapped = false;
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
    });
  } else if (state.phase === Phase.BATTLE) {
    withFirstHuman((human) => {
      const w = screenToWorld(x, y);
      human.setCrosshair(w.wx, w.wy);
      maybeSendAimUpdate(w.wx, w.wy);
    });
  }
}
