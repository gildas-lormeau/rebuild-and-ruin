import { isPlacementPhase } from "../shared/game-phase.ts";
import { FOCUS_MENU, FOCUS_REMATCH } from "../shared/interaction-types.ts";
import {
  IS_TOUCH_DEVICE,
  KEY_DOWN,
  KEY_ENTER,
  KEY_ESCAPE,
  KEY_LEFT,
  KEY_RIGHT,
  KEY_UP,
} from "../shared/platform/platform.ts";
import {
  ACTION_KEYS,
  type KeyBindings,
  MAX_PLAYERS,
  MAX_SEED_LENGTH,
  SEED_CUSTOM,
  SEED_RANDOM,
} from "../shared/player-config.ts";
import { type GameState } from "../shared/types.ts";
import type { RegisterOnlineInputDeps } from "../shared/ui-contracts.ts";
import { isGameplayMode, Mode } from "../shared/ui-mode.ts";
import {
  dispatchGameAction,
  dispatchQuit,
  shouldHandleGameInput,
} from "./input-dispatch.ts";

// Function type export — consumed as type-only import by runtime/
// Note: keyboard uses per-handler mode checks because different keys are valid
// in different modes (e.g., arrows in lobby vs game, ESC always available).
// Mouse handlers check mode at event-handler level instead (see input-mouse.ts).
export function registerKeyboardHandlers(deps: RegisterOnlineInputDeps): void {
  const { getState, getMode, keyboardEventSource } = deps;

  keyboardEventSource.addEventListener("keydown", async (e) => {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLSelectElement
    )
      return;
    const mode = getMode();

    if (await handleKeyF1(e, mode, deps)) return;
    if (mode === Mode.STOPPED) {
      void handleKeyStopped(e, deps);
      return;
    }
    if (handleKeyEscape(e, mode, deps)) return;
    if (mode === Mode.CONTROLS) {
      handleKeyControls(e, deps);
      return;
    }
    if (mode === Mode.OPTIONS) {
      handleKeyOptions(e, deps);
      return;
    }
    if (deps.lobby.isActive()) {
      if (deps.lobby.keyJoin?.(e.key)) e.preventDefault();
      return;
    }

    const state = getState();
    if (!state) return;
    if (handleKeyDialog(e, deps)) return;
    if ((e.key === "p" || e.key === "P") && deps.options.togglePause()) {
      e.preventDefault();
      return;
    }
    if (shouldHandleGameInput(mode, state)) {
      handleKeyGame(e, state, deps);
      return;
    }
  });

  keyboardEventSource.addEventListener("keyup", (e) => {
    for (const ctrl of deps.getControllers()) {
      if (!deps.isHuman(ctrl)) continue;
      const action = ctrl.matchKey(e.key);
      if (!action) continue;
      ctrl.handleKeyUp(action);
    }
  });
}

async function handleKeyF1(
  e: KeyboardEvent,
  mode: Mode,
  deps: RegisterOnlineInputDeps,
): Promise<boolean> {
  if (e.key !== "F1") return false;
  if (mode === Mode.LOBBY) {
    await deps.options.show();
  } else if (mode === Mode.OPTIONS) {
    deps.options.close();
  } else if (mode === Mode.CONTROLS) {
    deps.options.closeControls();
  } else if (isGameplayMode(mode)) {
    deps.options.setReturnMode(mode);
    await deps.options.show();
  } else {
    // Unlisted modes (e.g. STOPPED): consume F1 without action or preventDefault
    return true;
  }
  e.preventDefault();
  return true;
}

async function handleKeyStopped(
  e: KeyboardEvent,
  deps: RegisterOnlineInputDeps,
): Promise<void> {
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
    if (gameOver.getFocused() === FOCUS_REMATCH) await rematch();
    else showLobby();
  } else if (e.key === KEY_ESCAPE) {
    showLobby();
  }
  e.preventDefault();
}

function handleKeyEscape(
  e: KeyboardEvent,
  mode: Mode,
  deps: RegisterOnlineInputDeps,
): boolean {
  if (e.key !== KEY_ESCAPE) return false;
  if (mode === Mode.LOBBY || mode === Mode.OPTIONS || mode === Mode.CONTROLS)
    return false;
  dispatchQuit(
    {
      getPending: deps.quit.getPending,
      setPending: deps.quit.setPending,
      setTimer: deps.quit.setTimer,
      setMessage: deps.quit.setMessage,
      showLobby: deps.showLobby,
      getControllers: deps.getControllers,
      isHuman: deps.isHuman,
    },
    "Press ESC or \u2715 again to quit",
  );
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
      // Reserved keys — silently ignore during rebinding (P=pause, F1=options).
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
      const colCount = IS_TOUCH_DEVICE ? 1 : MAX_PLAYERS;
      controlsState.playerIdx =
        (controlsState.playerIdx - 1 + colCount) % colCount;
      e.preventDefault();
    } else if (e.key === KEY_RIGHT) {
      const colCount = IS_TOUCH_DEVICE ? 1 : MAX_PLAYERS;
      controlsState.playerIdx = (controlsState.playerIdx + 1) % colCount;
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
  if (handleKeyOptionsSeedMode(e, deps)) return;
  handleKeyOptionsNavigation(e, deps.options);
}

/** Handle seed-entry keys when the seed option row is focused. Returns true if consumed. */
function handleKeyOptionsSeedMode(
  e: KeyboardEvent,
  deps: RegisterOnlineInputDeps,
): boolean {
  const { options, settings } = deps;
  const isSeedEditDisabled = options.getReturnMode() !== null;
  if (isSeedEditDisabled || deps.isOnline || options.getRealIdx() !== 4)
    return false;

  if (e.key === KEY_LEFT || e.key === KEY_RIGHT) {
    if (settings.seedMode === SEED_RANDOM) {
      settings.seedMode = SEED_CUSTOM;
      settings.seed = "";
    } else {
      settings.seedMode = SEED_RANDOM;
      settings.seed = "";
    }
    e.preventDefault();
    return true;
  }
  if (settings.seedMode === SEED_CUSTOM) {
    const currentSeed = settings.seed;
    if (e.key >= "0" && e.key <= "9" && currentSeed.length < MAX_SEED_LENGTH) {
      settings.seed = currentSeed + e.key;
      e.preventDefault();
      return true;
    } else if (e.key === "Backspace") {
      settings.seed = currentSeed.slice(0, -1);
      e.preventDefault();
      return true;
    } else if (e.key === "Delete") {
      settings.seed = "";
      e.preventDefault();
      return true;
    }
  }
  return false;
}

/** Handle general navigation keys in the options menu. */
function handleKeyOptionsNavigation(
  e: KeyboardEvent,
  options: RegisterOnlineInputDeps["options"],
): void {
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
    options.confirmOption();
    e.preventDefault();
  }
}

/** Per-player dialog keyboard dispatch. Iterates all human controllers,
 *  matches the key to each player's bindings, and delegates to the
 *  centralized dialogAction(playerId, action). */
function handleKeyDialog(
  e: KeyboardEvent,
  deps: RegisterOnlineInputDeps,
): boolean {
  let consumed = false;
  for (const ctrl of deps.getControllers()) {
    if (!deps.isHuman(ctrl)) continue;
    const action = ctrl.matchKey(e.key);
    if (!action) continue;
    if (deps.dialogAction(ctrl.playerId, action)) {
      e.preventDefault();
      consumed = true;
    }
  }
  return consumed;
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

/** Apply a key rebinding with conflict resolution (swap conflicting key). */
function applyKeyRebinding(
  keyBindings: KeyBindings,
  actionKey: string,
  newKey: string,
): void {
  for (const otherAction of ACTION_KEYS) {
    if (otherAction === actionKey) continue;
    if (keyBindings[otherAction as keyof KeyBindings] === newKey) {
      (keyBindings as unknown as Record<string, string>)[otherAction] =
        keyBindings[actionKey as keyof KeyBindings];
      break;
    }
  }
  (keyBindings as unknown as Record<string, string>)[actionKey] = newKey;
}
