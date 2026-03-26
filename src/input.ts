import { applyKeyRebinding, FOCUS_MENU, FOCUS_REMATCH, type GameOverFocus, SEED_CUSTOM, SEED_RANDOM, type SeedMode } from "./game-ui-types.ts";
import type { WorldPos } from "./geometry-types.ts";
import type { ControlsState, LifeLostDialogState, ModeValues } from "./input-dispatch.ts";
import { clientToCanvas, dispatchBattleFire, dispatchModeTap, dispatchPlacement, dispatchPointerMove, dispatchTowerSelect, isGameInteractionMode, isTouchSuppressed } from "./input-dispatch.ts";
import { CHOICE_ABANDON, CHOICE_CONTINUE, CHOICE_PENDING, type ResolvedChoice } from "./life-lost.ts";
import type { KeyBindings } from "./player-config.ts";
import { ACTION_KEYS, MAX_PLAYERS } from "./player-config.ts";
import type { InputReceiver, PlayerController } from "./player-controller.ts";
import type { SelectionState } from "./selection.ts";
import { findNearestTower } from "./spatial.ts";
import type { GameState } from "./types.ts";
import { Action, isMovementAction, isPlacementPhase, isSelectionPhase, Phase } from "./types.ts";

export interface RegisterOnlineInputDeps {
  canvas: HTMLCanvasElement;
  getState: () => GameState | undefined;
  getMode: () => number;
  setMode: (mode: number) => void;
  modeValues: ModeValues;
  isLobbyActive: () => boolean;
  lobbyKeyJoin?: (key: string) => boolean;
  lobbyClick: (x: number, y: number) => boolean;
  showLobby: () => void;
  rematch: () => void;
  getGameOverFocused: () => GameOverFocus;
  setGameOverFocused: (f: GameOverFocus) => void;
  gameOverClick: (x: number, y: number) => void;
  showOptions: () => void;
  closeOptions: () => void;
  showControls: () => void;
  closeControls: () => void;
  getOptionsCursor: () => number;
  setOptionsCursor: (cursor: number) => void;
  getOptionsCount: () => number;
  getRealOptionIdx: () => number;
  getOptionsReturnMode: () => number | null;
  setOptionsReturnMode: (mode: number | null) => void;
  changeOption: (dir: number) => void;
  getControlsState: () => ControlsState;
  getLifeLostDialog: () => LifeLostDialogState | null;
  lifeLostDialogClick: (x: number, y: number) => void;
  getControllers: () => PlayerController[];
  isHuman: (ctrl: PlayerController) => ctrl is PlayerController & InputReceiver;
  withFirstHuman: (action: (human: PlayerController & InputReceiver) => void) => void;
  pixelToTile: (x: number, y: number) => { row: number; col: number };
  screenToWorld: (x: number, y: number) => WorldPos;
  onPinchStart?: (midX: number, midY: number) => void;
  onPinchUpdate?: (midX: number, midY: number, scale: number) => void;
  onPinchEnd?: () => void;
  maybeSendAimUpdate: (x: number, y: number) => void;
  tryPlaceCannonAndSend: (
    ctrl: PlayerController & InputReceiver,
    gameState: GameState,
    max: number,
  ) => boolean;
  tryPlacePieceAndSend: (
    ctrl: PlayerController & InputReceiver,
    gameState: GameState,
  ) => boolean;
  fireAndSend: (ctrl: PlayerController, gameState: GameState) => void;
  getSelectionStates: () => Map<number, SelectionState>;
  highlightTowerForPlayer: (idx: number, zone: number, pid: number) => void;
  confirmSelectionForPlayer: (pid: number, isReselect?: boolean) => boolean;
  /** True after the "Select your home castle" announcement has finished. */
  isSelectionReady?: () => boolean;
  isOnline?: boolean;
  togglePause: () => boolean;
  getQuitPending: () => boolean;
  setQuitPending: (value: boolean) => void;
  setQuitTimer: (seconds: number) => void;
  setQuitMessage: (text: string) => void;
  sendLifeLostChoice: (
    choice: ResolvedChoice,
    playerId: number,
  ) => void;
  /** Mark direct-touch-active state (shows floating buttons near phantom). */
  setDirectTouchActive?: (active: boolean) => void;
  /** True when floating buttons are active — suppresses canvas tap-to-place. */
  isDirectTouchActive?: () => boolean;
  settings: {
    keyBindings: KeyBindings[];
    seedMode: SeedMode;
    seed: string;
  };
}

export function registerOnlineInputHandlers(
  deps: RegisterOnlineInputDeps,
): void {
  const {
    canvas,
    getState,
    getMode,
    modeValues,
    isLobbyActive,
    lobbyKeyJoin,
    togglePause,
    screenToWorld,
  } = deps;

  canvas.addEventListener("mousemove", (e) => {
    const mode = getMode();
    if (mode === modeValues.LOBBY || mode === modeValues.STOPPED) {
      canvas.style.cursor = "pointer";
    } else if (mode === modeValues.GAME) {
      const state = getState();
      canvas.style.cursor = state?.phase === Phase.BATTLE ? "none" : "default";
    } else {
      canvas.style.cursor = "default";
    }

    const state = getState();
    if (!state || isLobbyActive()) return;
    const { x, y } = clientToCanvas(e.clientX, e.clientY, canvas);
    dispatchPointerMove(x, y, state, deps);
  });

  canvas.addEventListener("click", (e) => {
    if (isTouchSuppressed()) return;
    const { x, y } = clientToCanvas(e.clientX, e.clientY, canvas);
    const mode = getMode();
    const state = getState();

    if (dispatchModeTap(x, y, mode, deps)) return;
    if (!state || !isGameInteractionMode(mode, modeValues)) return;

    if (isSelectionPhase(state.phase)) {
      const tw = screenToWorld(x, y);
      dispatchTowerSelect(tw.wx, tw.wy, state, state.phase === Phase.CASTLE_RESELECT, deps);
    } else if (isPlacementPhase(state.phase)) {
      dispatchPlacement(state, deps);
    } else {
      dispatchBattleFire(x, y, state, deps);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const mode = getMode();

    if (handleKeyF1(e, mode, deps)) return;
    if (mode === modeValues.STOPPED) { handleKeyStopped(e, deps); return; }
    if (handleKeyEscape(e, mode, deps)) return;
    if (mode === modeValues.CONTROLS) { handleKeyControls(e, deps); return; }
    if (mode === modeValues.OPTIONS) { handleKeyOptions(e, deps); return; }
    if (isLobbyActive()) { if (lobbyKeyJoin?.(e.key)) e.preventDefault(); return; }

    const state = getState();
    if (!state) return;
    if (mode === modeValues.LIFE_LOST && deps.getLifeLostDialog()) { handleKeyLifeLost(e, state, deps); return; }
    if ((e.key === "p" || e.key === "P") && togglePause()) { e.preventDefault(); return; }
    if (isSelectionPhase(state.phase)) { handleKeySelection(e, state, deps); return; }
    if (mode !== modeValues.GAME) return;
    handleKeyGame(e, state, deps);
  });

  document.addEventListener("keyup", (e) => {
    for (const ctrl of deps.getControllers()) {
      if (!deps.isHuman(ctrl)) continue;
      const action = ctrl.matchKey(e.key);
      if (!action) continue;
      ctrl.handleKeyUp(action);
    }
  });
}

function handleKeyF1(e: KeyboardEvent, mode: number, deps: RegisterOnlineInputDeps): boolean {
  if (e.key !== "F1") return false;
  const { modeValues, showOptions, closeOptions, closeControls, setOptionsReturnMode, setMode } = deps;
  if (mode === modeValues.LOBBY) {
    showOptions();
  } else if (mode === modeValues.OPTIONS) {
    closeOptions();
  } else if (mode === modeValues.CONTROLS) {
    closeControls();
  } else if (
    mode === modeValues.SELECTION || mode === modeValues.BANNER ||
    mode === modeValues.BALLOON_ANIM || mode === modeValues.CASTLE_BUILD ||
    mode === modeValues.LIFE_LOST || mode === modeValues.GAME
  ) {
    setOptionsReturnMode(mode);
    setMode(modeValues.OPTIONS);
  } else {
    // Unlisted modes (e.g. STOPPED): consume F1 without action or preventDefault
    return true;
  }
  e.preventDefault();
  return true;
}

function handleKeyStopped(e: KeyboardEvent, deps: RegisterOnlineInputDeps): void {
  const { getGameOverFocused, setGameOverFocused, rematch, showLobby } = deps;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "a" || e.key === "d") {
    setGameOverFocused(getGameOverFocused() === FOCUS_REMATCH ? FOCUS_MENU : FOCUS_REMATCH);
  } else if (e.key === "Enter" || e.key === " " || e.key === "n" || e.key === "f") {
    if (getGameOverFocused() === FOCUS_REMATCH) rematch();
    else showLobby();
  } else if (e.key === "Escape") {
    showLobby();
  }
  e.preventDefault();
}

function handleKeyEscape(e: KeyboardEvent, mode: number, deps: RegisterOnlineInputDeps): boolean {
  if (e.key !== "Escape") return false;
  const { modeValues, showLobby, getControllers, isHuman, getQuitPending, setQuitPending, setQuitTimer, setQuitMessage } = deps;
  if (mode === modeValues.LOBBY || mode === modeValues.OPTIONS || mode === modeValues.CONTROLS) return false;
  const hasHumans = getControllers().some((c) => isHuman(c));
  if (!hasHumans) {
    showLobby();
  } else if (getQuitPending()) {
    showLobby();
  } else {
    setQuitPending(true);
    setQuitTimer(2);
    setQuitMessage("Press ESC or ✕ again to quit");
  }
  e.preventDefault();
  return true;
}

function handleKeyControls(e: KeyboardEvent, deps: RegisterOnlineInputDeps): void {
  const { getControlsState, closeControls, settings } = deps;
  const controlsState = getControlsState();
  if (controlsState.rebinding) {
    e.preventDefault();
    if (e.key === "Escape") {
      controlsState.rebinding = false;
    } else if (e.key === "p" || e.key === "P" || e.key === "F1") {
      // Reserved keys.
    } else {
      const pIdx = controlsState.playerIdx;
      const aIdx = controlsState.actionIdx;
      const actionKey = ACTION_KEYS[aIdx]!;
      applyKeyRebinding(settings.keyBindings[pIdx]!, actionKey, e.key);
      controlsState.rebinding = false;
    }
  } else {
    if (e.key === "ArrowUp") {
      controlsState.actionIdx = (controlsState.actionIdx - 1 + ACTION_KEYS.length) % ACTION_KEYS.length;
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      controlsState.actionIdx = (controlsState.actionIdx + 1) % ACTION_KEYS.length;
      e.preventDefault();
    } else if (e.key === "ArrowLeft") {
      controlsState.playerIdx = (controlsState.playerIdx - 1 + MAX_PLAYERS) % MAX_PLAYERS;
      e.preventDefault();
    } else if (e.key === "ArrowRight") {
      controlsState.playerIdx = (controlsState.playerIdx + 1) % MAX_PLAYERS;
      e.preventDefault();
    } else if (e.key === "Enter" || e.key === " ") {
      controlsState.rebinding = true;
      e.preventDefault();
    } else if (e.key === "Escape") {
      closeControls();
      e.preventDefault();
    }
  }
}

function handleKeyOptions(e: KeyboardEvent, deps: RegisterOnlineInputDeps): void {
  const {
    getOptionsCursor, setOptionsCursor, getOptionsCount, getRealOptionIdx,
    getOptionsReturnMode, changeOption, closeOptions, showControls, settings,
  } = deps;
  const readOnly = getOptionsReturnMode() !== null;
  const seedMode = settings.seedMode;

  if (!readOnly && !deps.isOnline && getRealOptionIdx() === 4) {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (seedMode === SEED_RANDOM) {
        settings.seedMode = SEED_CUSTOM;
        settings.seed = "";
      } else {
        settings.seedMode = SEED_RANDOM;
        settings.seed = "";
      }
      e.preventDefault();
      return;
    }
    if (seedMode === SEED_CUSTOM) {
      const currentSeed = settings.seed;
      if (e.key >= "0" && e.key <= "9" && currentSeed.length < 9) {
        settings.seed = currentSeed + e.key;
        e.preventDefault();
        return;
      } else if (e.key === "Backspace") {
        settings.seed = currentSeed.slice(0, -1);
        e.preventDefault();
        return;
      } else if (e.key === "Delete") {
        settings.seed = "";
        e.preventDefault();
        return;
      }
    }
  }

  if (e.key === "ArrowUp" || e.key === "w" || e.key === "i") {
    setOptionsCursor((getOptionsCursor() - 1 + getOptionsCount()) % getOptionsCount());
    e.preventDefault();
  } else if (e.key === "ArrowDown" || e.key === "s" || e.key === "k") {
    setOptionsCursor((getOptionsCursor() + 1) % getOptionsCount());
    e.preventDefault();
  } else if (e.key === "ArrowLeft" || e.key === "a" || e.key === "j") {
    changeOption(-1);
    e.preventDefault();
  } else if (e.key === "ArrowRight" || e.key === "d" || e.key === "l") {
    changeOption(1);
    e.preventDefault();
  } else if (e.key === "Escape") {
    closeOptions();
    e.preventDefault();
  } else if (e.key === "Enter" || e.key === " " || e.key === "n" || e.key === "f" || e.key === "h") {
    if (getRealOptionIdx() === 5) showControls();
    else closeOptions();
    e.preventDefault();
  }
}

function handleKeyLifeLost(e: KeyboardEvent, state: GameState, deps: RegisterOnlineInputDeps): void {
  const { getLifeLostDialog, getControllers, isHuman, sendLifeLostChoice } = deps;
  const lifeLostDialog = getLifeLostDialog();
  if (!lifeLostDialog) return;
  for (const ctrl of getControllers()) {
    if (!isHuman(ctrl)) continue;
    const entry = lifeLostDialog.entries.find(
      (en) => en.playerId === ctrl.playerId && en.choice === CHOICE_PENDING,
    );
    if (!entry) continue;
    const action = ctrl.matchKey(e.key);
    if (action === Action.LEFT || action === Action.RIGHT) {
      entry.focused = entry.focused === 0 ? 1 : 0;
      e.preventDefault();
    } else if (action === Action.CONFIRM) {
      entry.choice = entry.focused === 0 ? CHOICE_CONTINUE : CHOICE_ABANDON;
      sendLifeLostChoice(entry.choice, entry.playerId);
      e.preventDefault();
    }
  }
}

function handleKeySelection(e: KeyboardEvent, state: GameState, deps: RegisterOnlineInputDeps): void {
  const { isSelectionReady, getControllers, isHuman, getSelectionStates, highlightTowerForPlayer, confirmSelectionForPlayer } = deps;
  if (isSelectionReady && !isSelectionReady()) return;
  const isReselect = state.phase === Phase.CASTLE_RESELECT;
  for (const ctrl of getControllers()) {
    if (!isHuman(ctrl)) continue;
    const ss = getSelectionStates().get(ctrl.playerId);
    if (!ss || ss.confirmed) continue;

    const action = ctrl.matchKey(e.key);
    if (!action) continue;

    const zone = state.playerZones[ctrl.playerId] ?? 0;
    const current = ss.highlighted;

    if (isMovementAction(action)) {
      const next = findNearestTower(state.map.towers, current, action, zone);
      highlightTowerForPlayer(next, zone, ctrl.playerId);
      e.preventDefault();
    } else if (action === Action.CONFIRM) {
      confirmSelectionForPlayer(ctrl.playerId, isReselect);
      e.preventDefault();
    }
  }
}

function handleKeyGame(e: KeyboardEvent, state: GameState, deps: RegisterOnlineInputDeps): void {
  const { getControllers, isHuman, tryPlaceCannonAndSend, tryPlacePieceAndSend, fireAndSend } = deps;
  for (const ctrl of getControllers()) {
    if (state.players[ctrl.playerId]?.eliminated) continue;
    if (!isHuman(ctrl)) continue;
    const action = ctrl.matchKey(e.key);
    if (!action) continue;

    if (state.phase === Phase.CANNON_PLACE) {
      const player = state.players[ctrl.playerId]!;
      if (!player.castle) continue;
      if (isMovementAction(action)) {
        ctrl.moveCannonCursor(action);
        e.preventDefault();
      } else if (action === Action.ROTATE) {
        ctrl.cycleCannonMode(state, state.cannonLimits[player.id] ?? 0);
        e.preventDefault();
      } else if (action === Action.CONFIRM) {
        const max = state.cannonLimits[player.id] ?? 0;
        tryPlaceCannonAndSend(ctrl, state, max);
        e.preventDefault();
      }
    } else if (state.phase === Phase.WALL_BUILD) {
      if (isMovementAction(action)) {
        ctrl.moveBuildCursor(action);
        e.preventDefault();
      } else if (action === Action.ROTATE) {
        ctrl.rotatePiece();
        e.preventDefault();
      } else if (action === Action.CONFIRM) {
        tryPlacePieceAndSend(ctrl, state);
        e.preventDefault();
      }
    } else if (state.phase === Phase.BATTLE) {
      if (isMovementAction(action) || action === Action.ROTATE) {
        ctrl.handleKeyDown(action);
        e.preventDefault();
      } else if (action === Action.CONFIRM && state.battleCountdown <= 0) {
        fireAndSend(ctrl, state);
        e.preventDefault();
      }
    }
  }
}
