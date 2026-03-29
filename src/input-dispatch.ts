/**
 * Shared input dispatch helpers.
 *
 * Pure functions that translate pointer/tap events into game actions.
 * Used by mouse input (input.ts), touch input (input-touch-canvas.ts),
 * and touch UI controls (touch-ui.ts).
 */

import type {
  InputReceiver,
  PlayerController,
} from "./controller-interfaces.ts";
import type { WorldPos } from "./geometry-types.ts";
import { findNearestTower, towerAtPixel } from "./spatial.ts";
import {
  Action,
  type ControlsState,
  type GameState,
  isMovementAction,
  isPlacementPhase,
  isReselectPhase,
  isSelectionPhase,
  type LifeLostDialogState,
  Phase,
  type SelectionState,
} from "./types.ts";

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

export interface OverlayActionDeps {
  options?: {
    isActive: () => boolean;
    navigate: (dir: -1 | 1) => void;
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
  confirmSelectionForPlayer: (pid: number, isReselect?: boolean) => boolean;
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

const TOUCH_CLICK_SUPPRESS_MS = 500;

/** Timestamp of last touchend; suppresses synthetic click events on mobile. */
let lastTouchTime = 0;

export function markTouchTime(): void {
  lastTouchTime = performance.now();
}

/** Whether a recent touch should suppress the current synthetic click. */
export function isTouchSuppressed(): boolean {
  return performance.now() - lastTouchTime < TOUCH_CLICK_SUPPRESS_MS;
}

/** Whether the current mode allows gameplay interaction (tower selection or active game). */
export function isGameInteractionMode(
  mode: number,
  mv: { GAME: number; SELECTION: number },
): boolean {
  return mode === mv.GAME || mode === mv.SELECTION;
}

/** Shared mode-tap dispatch — handles non-game UI taps (game over, options, lobby, etc.). Returns true if consumed. */
export function dispatchModeTap(
  x: number,
  y: number,
  mode: number,
  deps: {
    modeValues: ModeValues;
    gameOver: { click: (x: number, y: number) => void };
    options: {
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
  const { modeValues, gameOver, options, lifeLost, lobby } = deps;
  if (mode === modeValues.STOPPED) {
    gameOver.click(x, y);
    return true;
  }
  if (mode === modeValues.OPTIONS) {
    options.close();
    return true;
  }
  if (mode === modeValues.CONTROLS) {
    if (!options.getControlsState().rebinding) options.closeControls();
    return true;
  }
  if (mode === modeValues.LIFE_LOST && lifeLost.get()) {
    lifeLost.click(x, y);
    return true;
  }
  if (lobby.isActive()) {
    lobby.click(x, y);
    return true;
  }
  return false;
}

/** Shared tower-selection tap — first tap highlights, same tower again confirms. */
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
      | "confirmSelectionForPlayer"
      | "isSelectionReady"
    >;
  },
  requireDoubleTap = false,
): void {
  const { gameAction } = deps;
  if (gameAction.isSelectionReady && !gameAction.isSelectionReady()) return;
  deps.withFirstHuman((human) => {
    const ss = gameAction.getSelectionStates().get(human.playerId);
    if (!ss || ss.confirmed) return;
    const zone = state.playerZones[human.playerId] ?? 0;
    const idx = towerAtPixel(state.map.towers, wx, wy);
    if (idx !== null && state.map.towers[idx]?.zone === zone) {
      const alreadyHighlighted = ss.highlighted === idx;
      if (alreadyHighlighted && (!requireDoubleTap || ss.tapped)) {
        gameAction.confirmSelectionForPlayer(human.playerId, isReselect);
      } else {
        gameAction.highlightTowerForPlayer(idx, zone, human.playerId);
        ss.tapped = alreadyHighlighted;
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
    dispatchConfirmForCtrl(human, state, deps.gameAction);
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

/** Dispatch a UI action to the active overlay (options, life-lost, game-over). Returns true if consumed. */
export function dispatchOverlayAction(
  action: Action,
  deps: OverlayActionDeps,
): boolean {
  if (deps.options?.isActive()) {
    if (action === Action.UP) {
      deps.options.navigate(-1);
      return true;
    }
    if (action === Action.DOWN) {
      deps.options.navigate(1);
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

/** Dispatch a game action for a single controller. Returns true if handled. */
export function dispatchGameAction(
  ctrl: PlayerController & InputReceiver,
  action: Action,
  state: GameState,
  deps: GameActionDeps,
): boolean {
  if (state.players[ctrl.playerId]?.eliminated) return false;

  if (isSelectionPhase(state.phase)) {
    if (deps.isSelectionReady && !deps.isSelectionReady()) return false;
    const ss = deps.getSelectionStates().get(ctrl.playerId);
    if (!ss || ss.confirmed) return false;
    if (isMovementAction(action)) {
      const zone = state.playerZones[ctrl.playerId] ?? 0;
      const next = findNearestTower(
        state.map.towers,
        ss.highlighted,
        action,
        zone,
      );
      deps.highlightTowerForPlayer(next, zone, ctrl.playerId);
      return true;
    }
    if (action === Action.CONFIRM) {
      deps.confirmSelectionForPlayer(
        ctrl.playerId,
        isReselectPhase(state.phase),
      );
      return true;
    }
    return false;
  }

  if (isPlacementPhase(state.phase)) {
    if (
      state.phase === Phase.CANNON_PLACE &&
      !state.players[ctrl.playerId]?.castle
    )
      return false;
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

/** Shared pointer-move dispatch — updates cursor/crosshair based on current phase. */
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
  const { withFirstHuman, coords, gameAction, maybeSendAimUpdate } = deps;
  if (isSelectionPhase(state.phase)) {
    if (gameAction.isSelectionReady && !gameAction.isSelectionReady()) return;
    withFirstHuman((human) => {
      const ss = gameAction.getSelectionStates().get(human.playerId);
      if (!ss || ss.confirmed) return;
      const zone = state.playerZones[human.playerId] ?? 0;
      const w = coords.screenToWorld(x, y);
      const idx = towerAtPixel(state.map.towers, w.wx, w.wy);
      if (
        idx !== null &&
        idx !== ss.highlighted &&
        state.map.towers[idx]?.zone === zone
      ) {
        gameAction.highlightTowerForPlayer(idx, zone, human.playerId);
        ss.tapped = false;
      }
    });
  } else if (state.phase === Phase.WALL_BUILD) {
    withFirstHuman((human) => {
      const { row, col } = coords.pixelToTile(x, y);
      human.setBuildCursor(row, col);
    });
  } else if (state.phase === Phase.CANNON_PLACE) {
    withFirstHuman((human) => {
      const { row, col } = coords.pixelToTile(x, y);
      human.setCannonCursor(row, col);
    });
  } else if (state.phase === Phase.BATTLE) {
    withFirstHuman((human) => {
      const w = coords.screenToWorld(x, y);
      human.setCrosshair(w.wx, w.wy);
      maybeSendAimUpdate(w.wx, w.wy);
    });
  }
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
    dispatchConfirmForCtrl(ctrl, state, deps);
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
export function dispatchConfirmForCtrl(
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
