/**
 * Shared input dispatch helpers.
 *
 * Pure functions that translate pointer/tap events into game actions.
 * Used by mouse input (input.ts), touch input (input-touch-canvas.ts),
 * and touch UI controls (touch-ui.ts).
 *
 * ### Pointer-player convention
 *
 * Touch and mouse dispatchers target the pointer player only
 * (via `withPointerPlayer`). Keyboard input loops over ALL controllers
 * to support local multiplayer with distinct key bindings.
 *
 * ### Selection-confirmed guard convention
 *
 * The selection system self-guards: highlightTowerSelection() and
 * confirmTowerSelection() both early-return when already confirmed.
 * Caller-side `isSelectionPending()` checks are redundant safety nets
 * but kept for defense-in-depth.
 *
 * ### Touch-suppression pairing
 *
 * Mobile browsers fire synthetic click events after touchend.
 * To prevent double-actions: touch handlers call `markTouchTime()`
 * on touchend, and mouse/click handlers call `isTouchSuppressed()`
 * at entry. Both sides of the pair are required — adding a new
 * mouse handler without the suppression check causes ghost clicks.
 */

import { canBuildThisFrame } from "../game/index.ts";
import {
  isPlacementPhase,
  isReselectPhase,
  isSelectionPhase,
  Phase,
} from "../shared/core/game-phase.ts";
import type { WorldPos } from "../shared/core/geometry-types.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import { findNearestTower, towerAtPixel } from "../shared/core/spatial.ts";
import {
  type InputReceiver,
  isMovementAction,
  type PlayerController,
} from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import { Action } from "../shared/ui/input-action.ts";
import type {
  ControlsState,
  LifeLostDialogState,
  UpgradePickDialogState,
} from "../shared/ui/interaction-types.ts";
import type {
  GameActionDeps,
  OverlayActionDeps,
  PointerMoveDeps,
} from "../shared/ui/ui-contracts.ts";
import { isInteractiveMode, Mode } from "../shared/ui/ui-mode.ts";

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
// Negative-infinity sentinel so the very first click after module load is
// never suppressed. `lastTouchTime = 0` would suppress every click that
// fires within `TOUCH_CLICK_SUPPRESS_MS` of `performance.now() === 0`,
// which is harmless in a browser (page load takes longer than that) but
// breaks headless tests where the process clock starts near zero.
let lastTouchTime = Number.NEGATIVE_INFINITY;

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

/** Record that a touch just ended. Paired with `isTouchSuppressed()` in mouse
 *  handlers to prevent synthetic click events on mobile. Both sides are required:
 *  - Touch handlers (input-touch-canvas.ts): call markTouchTime() on touchend
 *  - Mouse handlers (input-mouse.ts): call isTouchSuppressed() before dispatching */
export function markTouchTime(): void {
  lastTouchTime = performance.now();
}

/** Whether a recent touch should suppress the current synthetic click.
 *  Must be checked in ALL mouse/click handlers — see markTouchTime() for the pairing. */
export function isTouchSuppressed(): boolean {
  return performance.now() - lastTouchTime < TOUCH_CLICK_SUPPRESS_MS;
}

/** Canonical guard for "this pointer/key event should reach live gameplay
 *  (tower select, piece placement, fire, grunt targeting, rotate)."
 *
 *  Returns `true` only when:
 *    1. `state` exists (game is loaded, not lobby bootstrap), and
 *    2. `mode` is an interactive gameplay mode (Mode.GAME / Mode.SELECTION).
 *
 *  Lobby/options/controls/banner/transition/stopped modes all return false.
 *  The type predicate narrows `state` to `GameState` for the caller.
 *
 *  All three input layers — mouse (click/contextmenu), keyboard (handleKeyGame
 *  dispatch), and touch (touchend / pinch-tap rotate) — MUST route their
 *  "is this a game input?" check through this helper. Do NOT inline
 *  `!!state && isInteractiveMode(mode)` at new call sites; copy-paste drift
 *  across the three input types is exactly what this helper exists to prevent.
 *
 *  Note: this helper is SEPARATE from the looser `!state || lobby.isActive()`
 *  gate used by mousemove/touchmove for cursor position updates. Those sites
 *  intentionally fire in non-interactive modes and don't go through here. */
export function shouldHandleGameInput(
  mode: Mode,
  state: GameState | undefined,
): state is GameState {
  return !!state && isInteractiveMode(mode);
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
    upgradePick: {
      get: () => UpgradePickDialogState | null;
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
  if (mode === Mode.UPGRADE_PICK && deps.upgradePick.get()) {
    deps.upgradePick.click(x, y);
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
    withPointerPlayer: (
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
  deps.withPointerPlayer((human) => {
    const selectionState = gameAction.getSelectionStates().get(human.playerId);
    if (!selectionState) return;
    const zone = state.playerZones[human.playerId] ?? 0;
    const idx = towerAtPixel(state.map.towers, wx, wy);
    if (idx !== undefined && state.map.towers[idx]?.zone === zone) {
      const alreadyHighlighted = selectionState.highlighted === idx;
      if (
        alreadyHighlighted &&
        (!requireSecondTapToConfirm || selectionState.towerAlreadyHighlighted)
      ) {
        gameAction.confirmSelectionAndStartBuild(human.playerId, isReselect);
      } else {
        gameAction.highlightTowerForPlayer(idx, zone, human.playerId);
        selectionState.towerAlreadyHighlighted = alreadyHighlighted;
      }
    }
  });
}

/** Shared placement dispatch — place piece or cannon for the pointer player. */
export function dispatchPlacement(
  state: GameState,
  deps: {
    withPointerPlayer: (
      action: (human: PlayerController & InputReceiver) => void,
    ) => void;
    gameAction: Pick<
      GameActionDeps,
      | "tryPlacePieceAndSend"
      | "tryPlaceCannonAndSend"
      | "onPiecePlaced"
      | "onPieceFailed"
      | "onCannonPlaced"
    >;
  },
): void {
  deps.withPointerPlayer((human) => {
    dispatchPlacementConfirm(human, state, deps.gameAction);
  });
}

/** Shared battle-fire dispatch — aim and fire for the pointer player. */
export function dispatchBattleFire(
  x: number,
  y: number,
  state: GameState,
  deps: {
    withPointerPlayer: (
      action: (human: PlayerController & InputReceiver) => void,
    ) => void;
    coords: { screenToWorld: (x: number, y: number) => WorldPos };
    gameAction: Pick<GameActionDeps, "fireAndSend">;
  },
): void {
  if (state.phase !== Phase.BATTLE) return;
  deps.withPointerPlayer((human) => {
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
  if (deps.dialogAction?.(action)) return true;
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
  if (isPlayerEliminated(state.players[ctrl.playerId])) return false;

  if (isSelectionPhase(state.phase)) {
    if (deps.isSelectionReady && !deps.isSelectionReady()) return false;
    const selectionState = deps.getSelectionStates().get(ctrl.playerId);
    if (!selectionState) return false;
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
    if (action === Action.CONFIRM) {
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
  deps: PointerMoveDeps,
): void {
  const { coords, gameAction, maybeSendAimUpdate } = deps;
  if (isSelectionPhase(state.phase)) {
    if (gameAction.isSelectionReady && !gameAction.isSelectionReady()) return;
  }
  deps.withPointerPlayer((human) => {
    if (isSelectionPhase(state.phase)) {
      const selectionState = gameAction
        .getSelectionStates()
        .get(human.playerId);
      if (!selectionState) return;
      const zone = state.playerZones[human.playerId] ?? 0;
      const w = coords.screenToWorld(x, y);
      const idx = towerAtPixel(state.map.towers, w.wx, w.wy);
      if (
        idx !== undefined &&
        idx !== selectionState.highlighted &&
        state.map.towers[idx]?.zone === zone
      ) {
        gameAction.highlightTowerForPlayer(idx, zone, human.playerId);
        selectionState.towerAlreadyHighlighted = false;
      }
    } else if (state.phase === Phase.WALL_BUILD) {
      const { row, col } = coords.pixelToTile(x, y);
      human.setBuildCursor(row, col);
    } else if (state.phase === Phase.CANNON_PLACE) {
      const w = coords.screenToWorld(x, y);
      human.setCannonCursor(w.wx, w.wy);
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
  deps: Pick<
    GameActionDeps,
    | "tryPlacePieceAndSend"
    | "tryPlaceCannonAndSend"
    | "onPieceRotated"
    | "onPiecePlaced"
    | "onPieceFailed"
    | "onCannonPlaced"
  >,
): boolean {
  // Build-phase gate: allow cursor movement but block placement + rotation
  // when an upgrade forbids building this frame (e.g. Master Builder lockout).
  const locked =
    state.phase === Phase.WALL_BUILD &&
    !canBuildThisFrame(state, ctrl.playerId);
  if (isMovementAction(action)) {
    dispatchMoveForCtrl(ctrl, action, state);
    return true;
  }
  if (locked) return false;
  if (action === Action.ROTATE) {
    rotatePlacement(ctrl, state, deps.onPieceRotated);
    return true;
  }
  if (action === Action.CONFIRM) {
    dispatchPlacementConfirm(ctrl, state, deps);
    return true;
  }
  return false;
}

/** Place piece or cannon for a single controller. */
export function dispatchPlacementConfirm(
  ctrl: PlayerController & InputReceiver,
  state: GameState,
  deps: Pick<
    GameActionDeps,
    | "tryPlacePieceAndSend"
    | "tryPlaceCannonAndSend"
    | "onPiecePlaced"
    | "onPieceFailed"
    | "onCannonPlaced"
  >,
): void {
  if (state.phase === Phase.WALL_BUILD) {
    if (!canBuildThisFrame(state, ctrl.playerId)) return;
    const placed = deps.tryPlacePieceAndSend(ctrl, state);
    if (placed) deps.onPiecePlaced?.();
    else deps.onPieceFailed?.();
  } else if (state.phase === Phase.CANNON_PLACE) {
    const max = state.cannonLimits[ctrl.playerId] ?? 0;
    const placed = deps.tryPlaceCannonAndSend(ctrl, state, max);
    if (placed) deps.onCannonPlaced?.();
  }
}

/** Rotate piece or cycle cannon mode for a single controller. */
function rotatePlacement(
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
