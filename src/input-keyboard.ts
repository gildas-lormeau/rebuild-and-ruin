import type {
  InputReceiver,
  PlayerController,
} from "./controller-interfaces.ts";
import type { RegisterOnlineInputDeps } from "./input.ts";
import {
  dispatchGameAction,
  dispatchOverlayAction,
  type OverlayActionDeps,
} from "./input-dispatch.ts";
import {
  ACTION_KEYS,
  applyKeyRebinding,
  KEY_DOWN,
  KEY_ENTER,
  KEY_ESCAPE,
  KEY_LEFT,
  KEY_RIGHT,
  KEY_UP,
  MAX_PLAYERS,
  SEED_CUSTOM,
  SEED_RANDOM,
} from "./player-config.ts";
import {
  FOCUS_MENU,
  FOCUS_REMATCH,
  type GameState,
  isPlacementPhase,
  LifeLostChoice,
} from "./types.ts";

export function registerKeyboardHandlers(deps: RegisterOnlineInputDeps): void {
  const { getState, getMode, modeValues } = deps;

  document.addEventListener("keydown", (e) => {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLSelectElement
    )
      return;
    const mode = getMode();

    if (handleKeyF1(e, mode, deps)) return;
    if (mode === modeValues.STOPPED) {
      handleKeyStopped(e, deps);
      return;
    }
    if (handleKeyEscape(e, mode, deps)) return;
    if (mode === modeValues.CONTROLS) {
      handleKeyControls(e, deps);
      return;
    }
    if (mode === modeValues.OPTIONS) {
      handleKeyOptions(e, deps);
      return;
    }
    if (deps.lobby.isActive()) {
      if (deps.lobby.keyJoin?.(e.key)) e.preventDefault();
      return;
    }

    const state = getState();
    if (!state) return;
    if (mode === modeValues.LIFE_LOST && deps.lifeLost.get()) {
      handleKeyLifeLost(e, deps);
      return;
    }
    if ((e.key === "p" || e.key === "P") && deps.options.togglePause()) {
      e.preventDefault();
      return;
    }
    if (mode === modeValues.GAME || mode === modeValues.SELECTION) {
      handleKeyGame(e, state, deps);
      return;
    }
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

function handleKeyF1(
  e: KeyboardEvent,
  mode: number,
  deps: RegisterOnlineInputDeps,
): boolean {
  if (e.key !== "F1") return false;
  const { modeValues, setMode } = deps;
  if (mode === modeValues.LOBBY) {
    deps.options.show();
  } else if (mode === modeValues.OPTIONS) {
    deps.options.close();
  } else if (mode === modeValues.CONTROLS) {
    deps.options.closeControls();
  } else if (
    mode === modeValues.SELECTION ||
    mode === modeValues.BANNER ||
    mode === modeValues.BALLOON_ANIM ||
    mode === modeValues.CASTLE_BUILD ||
    mode === modeValues.LIFE_LOST ||
    mode === modeValues.GAME
  ) {
    deps.options.setReturnMode(mode);
    setMode(modeValues.OPTIONS);
  } else {
    // Unlisted modes (e.g. STOPPED): consume F1 without action or preventDefault
    return true;
  }
  e.preventDefault();
  return true;
}

function handleKeyStopped(
  e: KeyboardEvent,
  deps: RegisterOnlineInputDeps,
): void {
  const { gameOver, rematch, showLobby } = deps;
  if (
    e.key === KEY_LEFT ||
    e.key === KEY_RIGHT ||
    e.key === "a" ||
    e.key === "d"
  ) {
    gameOver.setFocused(
      gameOver.getFocused() === FOCUS_REMATCH ? FOCUS_MENU : FOCUS_REMATCH,
    );
  } else if (
    e.key === KEY_ENTER ||
    e.key === " " ||
    e.key === "n" ||
    e.key === "f"
  ) {
    if (gameOver.getFocused() === FOCUS_REMATCH) rematch();
    else showLobby();
  } else if (e.key === KEY_ESCAPE) {
    showLobby();
  }
  e.preventDefault();
}

function handleKeyEscape(
  e: KeyboardEvent,
  mode: number,
  deps: RegisterOnlineInputDeps,
): boolean {
  if (e.key !== KEY_ESCAPE) return false;
  const { modeValues, showLobby, getControllers, isHuman, quit } = deps;
  if (
    mode === modeValues.LOBBY ||
    mode === modeValues.OPTIONS ||
    mode === modeValues.CONTROLS
  )
    return false;
  const hasHumans = getControllers().some((c) => isHuman(c));
  if (!hasHumans) {
    showLobby();
  } else if (quit.getPending()) {
    showLobby();
  } else {
    quit.setPending(true);
    quit.setTimer(2);
    quit.setMessage("Press ESC or ✕ again to quit");
  }
  e.preventDefault();
  return true;
}

function handleKeyControls(
  e: KeyboardEvent,
  deps: RegisterOnlineInputDeps,
): void {
  const controlsState = deps.options.getControlsState();
  if (controlsState.rebinding) {
    e.preventDefault();
    if (e.key === KEY_ESCAPE) {
      controlsState.rebinding = false;
    } else if (e.key === "p" || e.key === "P" || e.key === "F1") {
      // Reserved keys.
    } else {
      const pIdx = controlsState.playerIdx;
      const aIdx = controlsState.actionIdx;
      const actionKey = ACTION_KEYS[aIdx]!;
      applyKeyRebinding(deps.settings.keyBindings[pIdx]!, actionKey, e.key);
      controlsState.rebinding = false;
    }
  } else {
    if (e.key === KEY_UP) {
      controlsState.actionIdx =
        (controlsState.actionIdx - 1 + ACTION_KEYS.length) % ACTION_KEYS.length;
      e.preventDefault();
    } else if (e.key === KEY_DOWN) {
      controlsState.actionIdx =
        (controlsState.actionIdx + 1) % ACTION_KEYS.length;
      e.preventDefault();
    } else if (e.key === KEY_LEFT) {
      controlsState.playerIdx =
        (controlsState.playerIdx - 1 + MAX_PLAYERS) % MAX_PLAYERS;
      e.preventDefault();
    } else if (e.key === KEY_RIGHT) {
      controlsState.playerIdx = (controlsState.playerIdx + 1) % MAX_PLAYERS;
      e.preventDefault();
    } else if (e.key === KEY_ENTER || e.key === " ") {
      controlsState.rebinding = true;
      e.preventDefault();
    } else if (e.key === KEY_ESCAPE) {
      deps.options.closeControls();
      e.preventDefault();
    }
  }
}

function handleKeyOptions(
  e: KeyboardEvent,
  deps: RegisterOnlineInputDeps,
): void {
  const { options, settings } = deps;
  const readOnly = options.getReturnMode() !== null;
  const seedMode = settings.seedMode;

  if (!readOnly && !deps.isOnline && options.getRealIdx() === 4) {
    if (e.key === KEY_LEFT || e.key === KEY_RIGHT) {
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

  if (e.key === KEY_UP || e.key === "w" || e.key === "i") {
    options.setCursor(
      (options.getCursor() - 1 + options.getCount()) % options.getCount(),
    );
    e.preventDefault();
  } else if (e.key === KEY_DOWN || e.key === "s" || e.key === "k") {
    options.setCursor((options.getCursor() + 1) % options.getCount());
    e.preventDefault();
  } else if (e.key === KEY_LEFT || e.key === "a" || e.key === "j") {
    options.changeValue(-1);
    e.preventDefault();
  } else if (e.key === KEY_RIGHT || e.key === "d" || e.key === "l") {
    options.changeValue(1);
    e.preventDefault();
  } else if (e.key === KEY_ESCAPE) {
    options.close();
    e.preventDefault();
  } else if (
    e.key === KEY_ENTER ||
    e.key === " " ||
    e.key === "n" ||
    e.key === "f" ||
    e.key === "h"
  ) {
    if (options.getRealIdx() === 5) options.showControls();
    else options.close();
    e.preventDefault();
  }
}

function handleKeyLifeLost(
  e: KeyboardEvent,
  deps: RegisterOnlineInputDeps,
): void {
  for (const ctrl of deps.getControllers()) {
    if (!deps.isHuman(ctrl)) continue;
    const action = ctrl.matchKey(e.key);
    if (!action) continue;
    if (dispatchOverlayAction(action, buildLifeLostOverlayDeps(ctrl, deps))) {
      e.preventDefault();
    }
  }
}

function buildLifeLostOverlayDeps(
  ctrl: PlayerController & InputReceiver,
  deps: RegisterOnlineInputDeps,
): OverlayActionDeps {
  return {
    lifeLost: {
      isActive: () => {
        const dialog = deps.lifeLost.get();
        return (
          dialog?.entries.some(
            (en) =>
              en.playerId === ctrl.playerId &&
              en.choice === LifeLostChoice.PENDING,
          ) ?? false
        );
      },
      toggleFocus: () => {
        const dialog = deps.lifeLost.get();
        const entry = dialog?.entries.find(
          (en) =>
            en.playerId === ctrl.playerId &&
            en.choice === LifeLostChoice.PENDING,
        );
        if (entry) entry.focused = entry.focused === 0 ? 1 : 0;
      },
      confirm: () => {
        const dialog = deps.lifeLost.get();
        const entry = dialog?.entries.find(
          (en) =>
            en.playerId === ctrl.playerId &&
            en.choice === LifeLostChoice.PENDING,
        );
        if (entry) {
          entry.choice =
            entry.focused === 0
              ? LifeLostChoice.CONTINUE
              : LifeLostChoice.ABANDON;
          deps.lifeLost.sendChoice(entry.choice, entry.playerId);
        }
      },
    },
  };
}

function handleKeyGame(
  e: KeyboardEvent,
  state: GameState,
  deps: RegisterOnlineInputDeps,
): void {
  for (const ctrl of deps.getControllers()) {
    if (!deps.isHuman(ctrl)) continue;
    const action = ctrl.matchKey(e.key);
    if (!action) continue;
    if (isPlacementPhase(state.phase)) deps.setDirectTouchActive?.(false);
    if (dispatchGameAction(ctrl, action, state, deps.gameAction)) {
      e.preventDefault();
    }
  }
}
