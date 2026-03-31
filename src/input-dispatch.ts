/**
 * Shared input dispatch helpers.
 *
 * Pure functions that translate pointer/tap events into game actions.
 * Used by mouse input (input.ts), touch input (input-touch-canvas.ts),
 * and touch UI controls (touch-ui.ts).
 *
 * ### First-human-player convention
 *
 * Touch and mouse dispatchers target the first human player only
 * (via `withFirstHuman`). Keyboard input loops over ALL controllers
 * to support local multiplayer with distinct key bindings.
 */

import {
  type ControlsState,
  type InputReceiver,
  isMovementAction,
  type PlayerController,
} from "./controller-interfaces.ts";
import type { WorldPos } from "./geometry-types.ts";
import { findNearestTower, towerAtPixel } from "./spatial.ts";
import {
  Action,
  type GameState,
  isPlacementPhase,
  isReselectPhase,
  isSelectionPhase,
  type LifeLostDialogState,
  Mode,
  Phase,
  type SelectionState,
} from "./types.ts";

export interface OverlayActionDeps {
  options?: {
    isActive: () => boolean;
    moveCursor: (dir: -1 | 1) => void;
    changeValue: (dir: -1 | 1) => void;
    confirm: () => void;
  };
  lifeLost?: {
    isActive: () => boolean;
    toggleFocus: () => void;
    confirm: () => void;
  };
  gameOver?: {
    isActive: () => boolean;
    toggleFocus: () => void;
    confirm: () => void;
  };
}

export interface GameActionDeps {
  getSelectionStates: () => Map<number, SelectionState>;
  highlightTowerForPlayer: (idx: number, zone: number, pid: number) => void;
  confirmSelectionAndStartBuild: (pid: number, isReselect?: boolean) => boolean;
  isSelectionReady?: () => boolean;
  tryPlacePieceAndSend: (
    ctrl: PlayerController & InputReceiver,
    state: GameState,
  ) => void;
  tryPlaceCannonAndSend: (
    ctrl: PlayerController & InputReceiver,
    state: GameState,
    max: number,
  ) => void;
  onPieceRotated?: () => void;
  fireAndSend: (ctrl: PlayerController, state: GameState) => void;
}

interface QuitFlowDeps {
  getPending: () => boolean;
  setPending: (pending: boolean) => void;
  setTimer: (seconds: number) => void;
  setMessage: (msg: string) => void;
  showLobby: () => void;
  getControllers: () => PlayerController[];
  isHuman: (ctrl: PlayerController) => boolean;
}

const TOUCH_CLICK_SUPPRESS_MS = 500;
/** Seconds to wait before second ESC/✕ actually quits.
 *  Used by both keyboard (input-keyboard.ts) and touch (input-touch-ui.ts). */
const QUIT_WARNING_SECONDS = 2;

/** Timestamp of last touchend; suppresses synthetic click events on mobile. */
let lastTouchTime = 0;

/** Shared quit flow: if no humans or already pending → quit immediately, else show warning.
 *  Used by both keyboard ESC and touch ✕ button to ensure identical behavior. */
export function dispatchQuit(deps: QuitFlowDeps, warningMessage: string): void {
  const hasHumans = deps.getControllers().some((c) => deps.isHuman(c));
  if (!hasHumans || deps.getPending()) {
    deps.showLobby();
  } else {
    deps.setPending(true);
    deps.setTimer(QUIT_WARNING_SECONDS);
    deps.setMessage(warningMessage);
  }
}

export function markTouchTime(): void {
  lastTouchTime = performance.now();
}

/** Whether a recent touch should suppress the current synthetic click. */
export function isTouchSuppressed(): boolean {
  return performance.now() - lastTouchTime < TOUCH_CLICK_SUPPRESS_MS;
}

/** Shared mode-tap dispatch — handles non-game UI taps (game over, options, lobby, etc.). Returns true if consumed. */
export function dispatchModeTap(
  x: number,
  y: number,
  mode: Mode,
  deps: {
    gameOver: { click: (x: number, y: number) => void };
    options: {
      click: (x: number, y: number) => void;
      clickControls: (x: number, y: number) => void;
      close: () => void;
      closeControls: () => void;
      getControlsState: () => ControlsState;
    };
    lifeLost: {
      get: () => LifeLostDialogState | null;
      click: (x: number, y: number) => void;
    };
    lobby: {
      isActive: () => boolean;
      click: (x: number, y: number) => boolean;
    };
  },
): boolean {
  const { gameOver, options, lifeLost, lobby } = deps;
  if (mode === Mode.STOPPED) {
    gameOver.click(x, y);
    return true;
  }
  if (mode === Mode.OPTIONS) {
    options.click(x, y);
    return true;
  }
  if (mode === Mode.CONTROLS) {
    options.clickControls(x, y);
    return true;
  }
  if (mode === Mode.LIFE_LOST && lifeLost.get()) {
    lifeLost.click(x, y);
    return true;
  }
  if (lobby.isActive()) {
    lobby.click(x, y);
    return true;
  }
  return false;
}

/** Shared tower-selection tap — first tap highlights, same tower again confirms. Does not return consumed status; caller is responsible for event management. */
export function dispatchTowerSelect(
  wx: number,
  wy: number,
  state: GameState,
  isReselect: boolean,
  deps: {
    withFirstHuman: (
      action: (human: PlayerController & InputReceiver) => void,
    ) => void;
    gameAction: Pick<
      GameActionDeps,
      | "getSelectionStates"
      | "highlightTowerForPlayer"
      | "confirmSelectionAndStartBuild"
      | "isSelectionReady"
    >;
  },
  requireSecondTapToConfirm = false,
): void {
  const { gameAction } = deps;
  if (gameAction.isSelectionReady && !gameAction.isSelectionReady()) return;
  deps.withFirstHuman((human) => {
    const selectionState = gameAction.getSelectionStates().get(human.playerId);
    if (!selectionState || selectionState.confirmed) return;
    const zone = state.playerZones[human.playerId] ?? 0;
    const idx = towerAtPixel(state.map.towers, wx, wy);
    if (idx !== null && state.map.towers[idx]?.zone === zone) {
      const alreadyHighlighted = selectionState.highlighted === idx;
      if (
        alreadyHighlighted &&
        (!requireSecondTapToConfirm || selectionState.secondTapReady)
      ) {
        gameAction.confirmSelectionAndStartBuild(human.playerId, isReselect);
      } else {
        gameAction.highlightTowerForPlayer(idx, zone, human.playerId);
        selectionState.secondTapReady = alreadyHighlighted;
      }
    }
  });
}

/** Shared placement dispatch — place piece or cannon for the first human player. */
export function dispatchPlacement(
  state: GameState,
  deps: {
    withFirstHuman: (
      action: (human: PlayerController & InputReceiver) => void,
    ) => void;
    gameAction: Pick<
      GameActionDeps,
      "tryPlacePieceAndSend" | "tryPlaceCannonAndSend"
    >;
  },
): void {
  deps.withFirstHuman((human) => {
    dispatchPlacementConfirm(human, state, deps.gameAction);
  });
}

/** Shared battle-fire dispatch — aim and fire for the first human player. */
export function dispatchBattleFire(
  x: number,
  y: number,
  state: GameState,
  deps: {
    withFirstHuman: (
      action: (human: PlayerController & InputReceiver) => void,
    ) => void;
    coords: { screenToWorld: (x: number, y: number) => WorldPos };
    gameAction: Pick<GameActionDeps, "fireAndSend">;
  },
): void {
  if (
    state.phase !== Phase.BATTLE ||
    state.timer <= 0 ||
    state.battleCountdown > 0
  )
    return;
  deps.withFirstHuman((human) => {
    const w = deps.coords.screenToWorld(x, y);
    human.setCrosshair(w.wx, w.wy);
    deps.gameAction.fireAndSend(human, state);
  });
}

/** Dispatch a UI action to the active overlay (options, life-lost, game-over). Returns true if consumed.
 *  Priority order: options → life-lost → game-over. At most one overlay is active at a time;
 *  the order only matters as a safety net — it does not imply overlays can stack. */
export function dispatchOverlayAction(
  action: Action,
  deps: OverlayActionDeps,
): boolean {
  if (deps.options?.isActive()) {
    if (action === Action.UP) {
      deps.options.moveCursor(-1);
      return true;
    }
    if (action === Action.DOWN) {
      deps.options.moveCursor(1);
      return true;
    }
    if (action === Action.LEFT) {
      deps.options.changeValue(-1);
      return true;
    }
    if (action === Action.RIGHT) {
      deps.options.changeValue(1);
      return true;
    }
    if (action === Action.ROTATE) {
      deps.options.changeValue(1);
      return true;
    }
    if (action === Action.CONFIRM) {
      deps.options.confirm();
      return true;
    }
    return false;
  }
  if (deps.lifeLost?.isActive()) {
    if (action === Action.LEFT || action === Action.RIGHT) {
      deps.lifeLost.toggleFocus();
      return true;
    }
    if (action === Action.CONFIRM) {
      deps.lifeLost.confirm();
      return true;
    }
    return false;
  }
  if (deps.gameOver?.isActive()) {
    if (action === Action.LEFT || action === Action.RIGHT) {
      deps.gameOver.toggleFocus();
      return true;
    }
    if (action === Action.CONFIRM) {
      deps.gameOver.confirm();
      return true;
    }
    return false;
  }
  return false;
}

/** Dispatch a game action for a single controller. Returns true if handled.
 *  Keyboard callers use the return value to call preventDefault(); touch callers
 *  (handleAction in input-touch-ui.ts) ignore it since touch events are already
 *  prevented at the touchstart level. */
export function dispatchGameAction(
  ctrl: PlayerController & InputReceiver,
  action: Action,
  state: GameState,
  deps: GameActionDeps,
): boolean {
  if (state.players[ctrl.playerId]?.eliminated) return false;

  if (isSelectionPhase(state.phase)) {
    if (deps.isSelectionReady && !deps.isSelectionReady()) return false;
    const selectionState = deps.getSelectionStates().get(ctrl.playerId);
    if (!selectionState || selectionState.confirmed) return false;
    if (isMovementAction(action)) {
      const zone = state.playerZones[ctrl.playerId] ?? 0;
      const next = findNearestTower(
        state.map.towers,
        selectionState.highlighted,
        action,
        zone,
      );
      deps.highlightTowerForPlayer(next, zone, ctrl.playerId);
      return true;
    }
    if (action === Action.CONFIRM) {
      deps.confirmSelectionAndStartBuild(
        ctrl.playerId,
        isReselectPhase(state.phase),
      );
      return true;
    }
    return false;
  }

  // Guard: CANNON_PLACE requires a built castle — can't place cannons without one.
  if (
    state.phase === Phase.CANNON_PLACE &&
    !state.players[ctrl.playerId]?.castle
  )
    return false;

  if (isPlacementPhase(state.phase)) {
    return dispatchPlacementAction(ctrl, action, state, deps);
  }

  if (state.phase === Phase.BATTLE) {
    if (isMovementAction(action) || action === Action.ROTATE) {
      ctrl.handleKeyDown(action);
      return true;
    }
    if (
      action === Action.CONFIRM &&
      state.battleCountdown <= 0 &&
      state.timer > 0
    ) {
      deps.fireAndSend(ctrl, state);
      return true;
    }
    return false;
  }

  return false;
}

/** Shared pointer-move dispatch — updates cursor/crosshair based on current phase. Always updates state; never "consumes" the event (returns void). */
export function dispatchPointerMove(
  x: number,
  y: number,
  state: GameState,
  deps: {
    withFirstHuman: (
      action: (human: PlayerController & InputReceiver) => void,
    ) => void;
    coords: {
      screenToWorld: (x: number, y: number) => WorldPos;
      pixelToTile: (x: number, y: number) => { row: number; col: number };
    };
    gameAction: Pick<
      GameActionDeps,
      "getSelectionStates" | "highlightTowerForPlayer" | "isSelectionReady"
    >;
    maybeSendAimUpdate: (x: number, y: number) => void;
  },
): void {
  const { coords, gameAction, maybeSendAimUpdate } = deps;
  if (isSelectionPhase(state.phase)) {
    if (gameAction.isSelectionReady && !gameAction.isSelectionReady()) return;
  }
  deps.withFirstHuman((human) => {
    if (isSelectionPhase(state.phase)) {
      const selectionState = gameAction
        .getSelectionStates()
        .get(human.playerId);
      if (!selectionState || selectionState.confirmed) return;
      const zone = state.playerZones[human.playerId] ?? 0;
      const w = coords.screenToWorld(x, y);
      const idx = towerAtPixel(state.map.towers, w.wx, w.wy);
      if (
        idx !== null &&
        idx !== selectionState.highlighted &&
        state.map.towers[idx]?.zone === zone
      ) {
        gameAction.highlightTowerForPlayer(idx, zone, human.playerId);
        selectionState.secondTapReady = false;
      }
    } else if (state.phase === Phase.WALL_BUILD) {
      const { row, col } = coords.pixelToTile(x, y);
      human.setBuildCursor(row, col);
    } else if (state.phase === Phase.CANNON_PLACE) {
      const { row, col } = coords.pixelToTile(x, y);
      human.setCannonCursor(row, col);
    } else if (state.phase === Phase.BATTLE) {
      const w = coords.screenToWorld(x, y);
      human.setCrosshair(w.wx, w.wy);
      maybeSendAimUpdate(w.wx, w.wy);
    }
  });
}

/** Dispatch any action for a single controller in a placement phase. Returns true if handled. */
function dispatchPlacementAction(
  ctrl: PlayerController & InputReceiver,
  action: Action,
  state: GameState,
  deps: {
    tryPlacePieceAndSend: (
      human: PlayerController & InputReceiver,
      state: GameState,
    ) => void;
    tryPlaceCannonAndSend: (
      human: PlayerController & InputReceiver,
      state: GameState,
      max: number,
    ) => void;
    onPieceRotated?: () => void;
  },
): boolean {
  if (isMovementAction(action)) {
    dispatchMoveForCtrl(ctrl, action, state);
    return true;
  }
  if (action === Action.ROTATE) {
    dispatchRotateForCtrl(ctrl, state, deps.onPieceRotated);
    return true;
  }
  if (action === Action.CONFIRM) {
    dispatchPlacementConfirm(ctrl, state, deps);
    return true;
  }
  return false;
}

/** Rotate piece or cycle cannon mode for a single controller. */
export function dispatchRotateForCtrl(
  ctrl: PlayerController & InputReceiver,
  state: GameState,
  onPieceRotated?: () => void,
): void {
  if (state.phase === Phase.WALL_BUILD) {
    ctrl.rotatePiece();
    onPieceRotated?.();
  } else if (state.phase === Phase.CANNON_PLACE) {
    const max = state.cannonLimits[ctrl.playerId] ?? 0;
    ctrl.cycleCannonMode(state, max);
  }
}

/** Place piece or cannon for a single controller. */
export function dispatchPlacementConfirm(
  ctrl: PlayerController & InputReceiver,
  state: GameState,
  deps: {
    tryPlacePieceAndSend: (
      human: PlayerController & InputReceiver,
      state: GameState,
    ) => void;
    tryPlaceCannonAndSend: (
      human: PlayerController & InputReceiver,
      state: GameState,
      max: number,
    ) => void;
  },
): void {
  if (state.phase === Phase.WALL_BUILD) {
    deps.tryPlacePieceAndSend(ctrl, state);
  } else if (state.phase === Phase.CANNON_PLACE) {
    const max = state.cannonLimits[ctrl.playerId] ?? 0;
    deps.tryPlaceCannonAndSend(ctrl, state, max);
  }
}

/** Move cursor for a single controller based on current phase. */
function dispatchMoveForCtrl(
  ctrl: PlayerController & InputReceiver,
  action: Action,
  state: GameState,
): void {
  if (state.phase === Phase.WALL_BUILD) {
    ctrl.moveBuildCursor(action);
  } else if (state.phase === Phase.CANNON_PLACE) {
    ctrl.moveCannonCursor(action);
  }
}
