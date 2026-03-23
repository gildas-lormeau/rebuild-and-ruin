import { towerAtPixel, findNearestTower } from "./spatial.ts";

import { Phase, Action, isMovementAction } from "./types.ts";
import { ACTION_KEYS, MAX_PLAYERS } from "./player-config.ts";
import type { GameState } from "./types.ts";
import type { PlayerController } from "./player-controller.ts";
import type { KeyBindings } from "./player-config.ts";
import type { SelectionState } from "./selection.ts";
import type { WorldPos } from "./geometry-types.ts";

interface ControlsState {
  playerIdx: number;
  actionIdx: number;
  rebinding: boolean;
}

interface LifeLostDialogEntry {
  playerId: number;
  choice: "pending" | "continue" | "abandon";
  focused: number;
}

interface LifeLostDialogState {
  entries: LifeLostDialogEntry[];
}

interface ModeValues {
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
  getGameOverFocused: () => "rematch" | "menu";
  setGameOverFocused: (f: "rematch" | "menu") => void;
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
  isHuman: (ctrl: PlayerController) => boolean;
  withFirstHuman: (action: (human: PlayerController) => void) => void;
  pixelToTile: (x: number, y: number) => { row: number; col: number };
  screenToWorld: (x: number, y: number) => WorldPos;
  maybeSendAimUpdate: (x: number, y: number) => void;
  tryPlaceCannonAndSend: (
    ctrl: PlayerController,
    gameState: GameState,
    max: number,
  ) => boolean;
  tryPlacePieceAndSend: (
    ctrl: PlayerController,
    gameState: GameState,
  ) => boolean;
  fireAndSend: (ctrl: PlayerController, gameState: GameState) => void;
  getSelectionStates: () => Map<number, SelectionState>;
  highlightTowerForPlayer: (idx: number, zone: number, pid: number) => void;
  confirmSelectionForPlayer: (pid: number, isReselect?: boolean) => boolean;
  finishReselection: () => void;
  finishSelection: () => void;
  isHost: () => boolean;
  togglePause: () => boolean;
  getQuitPending: () => boolean;
  setQuitPending: (value: boolean) => void;
  setQuitTimer: (seconds: number) => void;
  setQuitMessage: (text: string) => void;
  render: () => void;
  sendLifeLostChoice: (
    choice: "continue" | "abandon",
    playerId: number,
  ) => void;
  settings: {
    keyBindings: KeyBindings[];
    seedMode: "random" | "custom";
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
    setMode,
    modeValues,
    isLobbyActive,
    lobbyKeyJoin,
    lobbyClick,
    showLobby,
    rematch,
    getGameOverFocused,
    setGameOverFocused,
    showOptions,
    closeOptions,
    showControls,
    closeControls,
    getOptionsCursor,
    setOptionsCursor,
    getOptionsCount,
    getRealOptionIdx,
    getOptionsReturnMode,
    setOptionsReturnMode,
    changeOption,
    getControlsState,
    getLifeLostDialog,
    lifeLostDialogClick,
    getControllers,
    isHuman,
    withFirstHuman,
    pixelToTile,
    screenToWorld,
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
    togglePause,
    getQuitPending,
    setQuitPending,
    setQuitTimer,
    setQuitMessage,
    render,
    sendLifeLostChoice,
    settings,
  } = deps;

  canvas.addEventListener("mousemove", (e) => {
    const mode = getMode();
    // Update cursor based on mode
    if (mode === modeValues.LOBBY) {
      canvas.style.cursor = "pointer";
    } else if (mode === modeValues.STOPPED) {
      canvas.style.cursor = "pointer";
    } else if (mode === modeValues.GAME) {
      const state = getState();
      canvas.style.cursor = state?.phase === Phase.BATTLE ? "none" : "default";
    } else {
      canvas.style.cursor = "default";
    }

    const state = getState();
    if (!state || isLobbyActive()) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);

    if (
      state.phase === Phase.CASTLE_SELECT ||
      state.phase === Phase.CASTLE_RESELECT
    ) {
      withFirstHuman((human) => {
        const ss = getSelectionStates().get(human.playerId);
        if (!ss || ss.confirmed) return;
        const zone = state.playerZones[human.playerId] ?? 0;
        const tw = screenToWorld(x, y);
        const idx = towerAtPixel(state.map.towers, tw.wx, tw.wy);
        if (idx !== null && idx !== ss.highlighted) {
          highlightTowerForPlayer(idx, zone, human.playerId);
        }
      });
    } else if (state.phase === Phase.CANNON_PLACE) {
      withFirstHuman((human) => {
        const { row, col } = pixelToTile(x, y);
        human.setCannonCursor(row, col);
        render();
      });
    } else if (state.phase === Phase.WALL_BUILD) {
      withFirstHuman((human) => {
        const { row, col } = pixelToTile(x, y);
        human.setBuildCursor(row, col);
      });
    } else if (state.phase === Phase.BATTLE) {
      withFirstHuman((human) => {
        const w = screenToWorld(x, y);
        human.setCrosshair(w.wx, w.wy);
        maybeSendAimUpdate(w.wx, w.wy);
      });
    }
  });

  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);

    const mode = getMode();
    const state = getState();

    if (mode === modeValues.STOPPED) {
      if (getGameOverFocused() === "rematch") rematch();
      else showLobby();
      return;
    }

    if (mode === modeValues.OPTIONS) {
      closeOptions();
      return;
    }

    if (mode === modeValues.CONTROLS) {
      if (!getControlsState().rebinding) closeControls();
      return;
    }

    if (mode === modeValues.LIFE_LOST && getLifeLostDialog()) {
      lifeLostDialogClick(x, y);
      return;
    }

    if (isLobbyActive()) {
      lobbyClick(x, y);
      return;
    }

    if (!state) return;

    if (
      state.phase === Phase.CASTLE_SELECT ||
      state.phase === Phase.CASTLE_RESELECT
    ) {
      const isReselect = state.phase === Phase.CASTLE_RESELECT;
      withFirstHuman((human) => {
        const ss = getSelectionStates().get(human.playerId);
        if (!ss || ss.confirmed) return;
        const zone = state.playerZones[human.playerId] ?? 0;
        const tw = screenToWorld(x, y);
        const idx = towerAtPixel(state.map.towers, tw.wx, tw.wy);
        if (idx !== null && state.map.towers[idx]?.zone === zone) {
          highlightTowerForPlayer(idx, zone, human.playerId);
          if (
            confirmSelectionForPlayer(human.playerId, isReselect) &&
            isHost()
          ) {
            if (isReselect) finishReselection();
            else finishSelection();
          }
        }
      });
    } else if (state.phase === Phase.CANNON_PLACE) {
      withFirstHuman((human) => {
        const { row, col } = pixelToTile(x, y);
        human.setCannonCursor(row, col);
        const max = state.cannonLimits[human.playerId] ?? 0;
        tryPlaceCannonAndSend(human, state, max);
        render();
      });
    } else if (state.phase === Phase.WALL_BUILD) {
      withFirstHuman((human) => {
        const { row, col } = pixelToTile(x, y);
        human.setBuildCursor(row, col);
        tryPlacePieceAndSend(human, state);
      });
    } else if (
      state.phase === Phase.BATTLE &&
      state.timer > 0 &&
      state.battleCountdown <= 0
    ) {
      withFirstHuman((human) => {
        const w = screenToWorld(x, y);
        human.setCrosshair(w.wx, w.wy);
        fireAndSend(human, state);
      });
    }
  });

  document.addEventListener("keydown", (e) => {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLSelectElement
    ) {
      return;
    }

    const mode = getMode();

    if (e.key === "F1") {
      if (mode === modeValues.LOBBY) {
        showOptions();
        e.preventDefault();
      } else if (mode === modeValues.OPTIONS) {
        closeOptions();
        e.preventDefault();
      } else if (mode === modeValues.CONTROLS) {
        closeControls();
        e.preventDefault();
      } else if (
        mode === modeValues.SELECTION ||
        mode === modeValues.BANNER ||
        mode === modeValues.BALLOON_ANIM ||
        mode === modeValues.CASTLE_BUILD ||
        mode === modeValues.LIFE_LOST ||
        mode === modeValues.GAME
      ) {
        setOptionsReturnMode(mode);
        setMode(modeValues.OPTIONS);
        e.preventDefault();
      }
      return;
    }

    if (mode === modeValues.STOPPED) {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "a" || e.key === "d") {
        setGameOverFocused(getGameOverFocused() === "rematch" ? "menu" : "rematch");
        e.preventDefault();
        return;
      }
      if (e.key === "Enter" || e.key === " " || e.key === "n" || e.key === "f") {
        if (getGameOverFocused() === "rematch") rematch();
        else showLobby();
        e.preventDefault();
        return;
      }
      if (e.key === "Escape") {
        showLobby();
        e.preventDefault();
        return;
      }
      e.preventDefault();
      return;
    }

    if (
      e.key === "Escape" &&
      mode !== modeValues.LOBBY &&
      mode !== modeValues.OPTIONS &&
      mode !== modeValues.CONTROLS
    ) {
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
      return;
    }

    if (mode === modeValues.CONTROLS) {
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
          const newKey = e.key;
          const kb = settings.keyBindings[pIdx]!;

          for (const otherAction of ACTION_KEYS) {
            if (otherAction === actionKey) continue;
            if (otherAction === "confirmAlt") continue;
            if (kb[otherAction] === newKey) {
              kb[otherAction] = kb[actionKey];
              if (otherAction === "confirm") {
                kb.confirmAlt = kb[actionKey];
              }
              break;
            }
            if (otherAction === "confirm" && kb.confirmAlt === newKey) {
              kb.confirmAlt = kb[actionKey];
            }
          }

          kb[actionKey] = newKey;
          if (actionKey === "confirm") {
            kb.confirmAlt = newKey;
          }
          controlsState.rebinding = false;
        }
      } else {
        if (e.key === "ArrowUp") {
          controlsState.actionIdx =
            (controlsState.actionIdx - 1 + ACTION_KEYS.length) %
            ACTION_KEYS.length;
          e.preventDefault();
        } else if (e.key === "ArrowDown") {
          controlsState.actionIdx =
            (controlsState.actionIdx + 1) % ACTION_KEYS.length;
          e.preventDefault();
        } else if (e.key === "ArrowLeft") {
          controlsState.playerIdx =
            (controlsState.playerIdx - 1 + MAX_PLAYERS) % MAX_PLAYERS;
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
      return;
    }

    if (mode === modeValues.OPTIONS) {
      const readOnly = getOptionsReturnMode() !== null;
      const seedMode = settings.seedMode;

      if (!readOnly && getRealOptionIdx() === 4) {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          if (seedMode === "random") {
            settings.seedMode = "custom";
            settings.seed = "";
          } else {
            settings.seedMode = "random";
            settings.seed = "";
          }
          e.preventDefault();
          return;
        }
        if (seedMode === "custom") {
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
        setOptionsCursor(
          (getOptionsCursor() - 1 + getOptionsCount()) % getOptionsCount(),
        );
        e.preventDefault();
      } else if (e.key === "ArrowDown" || e.key === "s" || e.key === "k") {
        setOptionsCursor((getOptionsCursor() + 1) % getOptionsCount());
        e.preventDefault();
      } else if (
        (!readOnly || getRealOptionIdx() === 1) &&
        (e.key === "ArrowLeft" || e.key === "a" || e.key === "j")
      ) {
        changeOption(-1);
        e.preventDefault();
      } else if (
        (!readOnly || getRealOptionIdx() === 1) &&
        (e.key === "ArrowRight" || e.key === "d" || e.key === "l")
      ) {
        changeOption(1);
        e.preventDefault();
      } else if (e.key === "Escape") {
        closeOptions();
        e.preventDefault();
      } else if (
        e.key === "Enter" ||
        e.key === " " ||
        e.key === "n" ||
        e.key === "f" ||
        e.key === "h"
      ) {
        if (getRealOptionIdx() === 5) {
          showControls();
        } else {
          closeOptions();
        }
        e.preventDefault();
      }
      return;
    }

    if (isLobbyActive()) {
      if (lobbyKeyJoin?.(e.key)) {
        e.preventDefault();
      }
      return;
    }

    const state = getState();
    if (!state) return;

    if (mode === modeValues.LIFE_LOST && getLifeLostDialog()) {
      const lifeLostDialog = getLifeLostDialog();
      if (!lifeLostDialog) return;
      for (const ctrl of getControllers()) {
        if (!isHuman(ctrl)) continue;
        const entry = lifeLostDialog.entries.find(
          (en) => en.playerId === ctrl.playerId && en.choice === "pending",
        );
        if (!entry) continue;
        const action = ctrl.matchKey(e.key);
        if (action === Action.LEFT || action === Action.RIGHT) {
          entry.focused = entry.focused === 0 ? 1 : 0;
          e.preventDefault();
        } else if (action === Action.CONFIRM) {
          entry.choice = entry.focused === 0 ? "continue" : "abandon";
          sendLifeLostChoice(entry.choice, entry.playerId);
          e.preventDefault();
        }
      }
      return;
    }

    if (e.key === "p" || e.key === "P") {
      if (togglePause()) {
        e.preventDefault();
        return;
      }
    }

    if (
      state.phase === Phase.CASTLE_SELECT ||
      state.phase === Phase.CASTLE_RESELECT
    ) {
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
          const next = findNearestTower(
            state.map.towers,
            current,
            action,
            zone,
          );
          highlightTowerForPlayer(next, zone, ctrl.playerId);
          e.preventDefault();
        } else if (action === Action.CONFIRM) {
          if (confirmSelectionForPlayer(ctrl.playerId, isReselect)) {
            if (isHost()) {
              if (isReselect) finishReselection();
              else finishSelection();
            }
          }
          e.preventDefault();
        }
      }
      return;
    }

    for (const ctrl of getControllers()) {
      if (state.players[ctrl.playerId]?.eliminated) continue;
      const action = ctrl.matchKey(e.key);
      if (!action) continue;

      if (state.phase === Phase.CANNON_PLACE) {
        const player = state.players[ctrl.playerId]!;
        if (!player.castle) continue;

        if (isMovementAction(action)) {
          ctrl.moveCannonCursor(action);
          render();
          e.preventDefault();
        } else if (action === Action.ROTATE) {
          ctrl.cycleCannonMode(state, state.cannonLimits[player.id] ?? 0);
          render();
          e.preventDefault();
        } else if (action === Action.CONFIRM) {
          const max = state.cannonLimits[player.id] ?? 0;
          tryPlaceCannonAndSend(ctrl, state, max);
          render();
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
  });

  document.addEventListener("keyup", (e) => {
    for (const ctrl of getControllers()) {
      const action = ctrl.matchKey(e.key);
      if (!action) continue;
      ctrl.handleKeyUp(action);
    }
  });
}
