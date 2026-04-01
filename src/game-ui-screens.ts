/**
 * Shared options/controls/lobby screen rendering.
 * Used by both main.ts and online-client.ts.
 */

import type { ControlsState } from "./controller-interfaces.ts";
import {
  GAME_MODE_MODERN,
  LOBBY_SKIP_LOCKOUT,
  LOBBY_SKIP_STEP,
} from "./game-constants.ts";
import { createLobbyConfirmKeys, formatKeyHint } from "./game-helpers.ts";
import { formatKeyName, saveSettings } from "./game-ui-settings.ts";
import {
  CANNON_HP_OPTIONS,
  DIFFICULTY_LABELS,
  DPAD_LABELS,
  GAME_MODE_LABELS,
  HAPTICS_LABELS,
  OPTION_NAMES,
  ROUNDS_OPTIONS,
  SOUND_LABELS,
} from "./game-ui-types.ts";
import type { GameMap } from "./geometry-types.ts";
import { generateMap } from "./map-generation.ts";
import { IS_TOUCH_DEVICE } from "./platform.ts";
import type { GameSettings } from "./player-config.ts";
import {
  ACTION_KEYS,
  getPlayerColor,
  type KeyBindings,
  PLAYER_NAMES,
  SEED_CUSTOM,
} from "./player-config.ts";
import type { OptionEntry, RenderOverlay } from "./render-types.ts";
import {
  type GameState,
  isInteractiveMode,
  type LobbyState,
  Mode,
} from "./types.ts";

export interface UIContext {
  getState: () => GameState | undefined;
  getOverlay: () => RenderOverlay;
  settings: GameSettings;
  getMode: () => Mode;
  /** Raw field write — assigns runtimeState.mode. Callers (showOptions, closeOptions, etc.)
   *  are responsible for any state-machine side effects around the transition. */
  setMode: (mode: Mode) => void;
  getPaused: () => boolean;
  setPaused: (paused: boolean) => void;
  optionsCursor: { value: number };
  controlsState: ControlsState;
  getOptionsReturnMode: () => Mode | null;
  setOptionsReturnMode: (mode: Mode | null) => void;
  lobby: LobbyState;
  getFrame: () => { announcement?: string };
  getLobbyRemaining: () => number;
  isOnline?: boolean;
}

const CONTROL_ACTION_NAMES: readonly string[] = [
  "Up",
  "Down",
  "Left",
  "Right",
  "Confirm",
  "Rotate",
];
/** Raw option indices — positions in the options list. */
export const OPTION_SEED = 4;
export const OPTION_CONTROLS = 5;

export function createOptionsOverlay(frameCtx: UIContext): {
  map: GameMap;
  overlay: RenderOverlay;
} {
  const lobbyMap = frameCtx.lobby.map ?? generateMap(frameCtx.lobby.seed);
  const readOnly = frameCtx.getOptionsReturnMode() !== null;
  const visible = visibleOptions(frameCtx);
  const options: OptionEntry[] = visible.map((i) => {
    // Seed is typed, Controls is opened via confirm — neither uses left/right cycling
    if (i === 4 || i === 5)
      return {
        name: OPTION_NAMES[i]!,
        value: optionValue(frameCtx, i),
        editable: false,
      };
    // Online: Rounds, Cannon HP, Game Mode, Seed are locked by room host
    if (frameCtx.isOnline && (i === 1 || i === 2 || i === 8))
      return {
        name: OPTION_NAMES[i]!,
        value: optionValue(frameCtx, i),
        editable: false,
      };
    // In-game: Difficulty, Cannon HP, Game Mode are locked
    if (readOnly && (i === 0 || i === 2 || i === 8))
      return {
        name: OPTION_NAMES[i]!,
        value: optionValue(frameCtx, i),
        editable: false,
      };
    return {
      name: OPTION_NAMES[i]!,
      value: optionValue(frameCtx, i),
      editable: true,
    };
  });
  const state = frameCtx.getState();
  const castles = state
    ? state.players
        .filter((player) => player.castle)
        .map((player) => ({
          walls: player.walls,
          interior: player.interior,
          cannons: player.cannons,
          playerId: player.id,
        }))
    : undefined;
  const overlay: RenderOverlay = {
    selection: { highlighted: null, selected: null },
    castles,
    entities: state
      ? {
          houses: state.map.houses,
          towerAlive: state.towerAlive,
          burningPits: state.burningPits,
        }
      : undefined,
    ui: {
      optionsScreen: {
        options,
        cursor: frameCtx.optionsCursor.value,
        readOnly,
      },
    },
  };
  return { map: state?.map ?? lobbyMap, overlay };
}

export function showOptions(frameCtx: UIContext): void {
  frameCtx.optionsCursor.value = 0;
  frameCtx.setMode(Mode.OPTIONS);
}

export function closeOptions(frameCtx: UIContext): void {
  const returnMode = frameCtx.getOptionsReturnMode();
  if (returnMode !== null) {
    // Returning to game — read-only view, don't save settings
    frameCtx.setMode(returnMode);
    frameCtx.setOptionsReturnMode(null);
  } else {
    frameCtx.setMode(Mode.LOBBY);
    saveSettings(frameCtx.settings);
  }
}

export function createControlsOverlay(frameCtx: UIContext): {
  map: GameMap;
  overlay: RenderOverlay;
} {
  const lobbyMap = frameCtx.lobby.map ?? generateMap(frameCtx.lobby.seed);
  const cs = frameCtx.controlsState;
  const playerCount = IS_TOUCH_DEVICE ? 1 : PLAYER_NAMES.length;
  const players = PLAYER_NAMES.slice(0, playerCount).map((name, player) => {
    const kb = frameCtx.settings.keyBindings[player]!;
    return {
      name: name!,
      color: getPlayerColor(player).wall,
      bindings: ACTION_KEYS.map((key) =>
        formatKeyName(kb[key as keyof KeyBindings]),
      ),
    };
  });
  const overlay: RenderOverlay = {
    selection: { highlighted: null, selected: null },
    ui: {
      controlsScreen: {
        players,
        playerIdx: cs.playerIdx,
        actionIdx: cs.actionIdx,
        rebinding: cs.rebinding,
        actionNames: CONTROL_ACTION_NAMES,
      },
    },
  };
  return { map: frameCtx.getState()?.map ?? lobbyMap, overlay };
}

export function showControls(frameCtx: UIContext): void {
  frameCtx.controlsState.playerIdx = 0;
  frameCtx.controlsState.actionIdx = 0;
  frameCtx.controlsState.rebinding = false;
  frameCtx.setMode(Mode.CONTROLS);
}

export function closeControls(frameCtx: UIContext): void {
  saveSettings(frameCtx.settings);
  frameCtx.setMode(Mode.OPTIONS);
}

export function togglePause(frameCtx: UIContext): boolean {
  const mode = frameCtx.getMode();
  if (!isInteractiveMode(mode)) return false;
  const next = !frameCtx.getPaused();
  frameCtx.setPaused(next);
  frameCtx.getFrame().announcement = next ? "PAUSED" : undefined;
  return true;
}

/** Tick the lobby — check expiry. Calls `onExpired` when timer runs out or all slots are filled. */
export function tickLobby(frameCtx: UIContext, onExpired: () => void): void {
  if (!frameCtx.lobby.active) return;
  const allJoined = frameCtx.lobby.joined.every(Boolean);
  if (frameCtx.getLobbyRemaining() <= 0 || allJoined) {
    frameCtx.lobby.active = false;
    onExpired();
  }
}

export function createLobbyOverlay(frameCtx: UIContext): {
  map: GameMap;
  overlay: RenderOverlay;
} {
  const remaining = Math.max(0, frameCtx.getLobbyRemaining());
  const overlay: RenderOverlay = {
    selection: { highlighted: null, selected: null },
    ui: {
      playerSelect: {
        players: PLAYER_NAMES.map((name, i) => ({
          name: `${name} Player`,
          color: getPlayerColor(i).wall,
          joined: frameCtx.lobby.joined[i]!,
          keyHint: frameCtx.settings.keyBindings[i]
            ? formatKeyHint(frameCtx.settings.keyBindings[i])
            : undefined,
        })),
        timer: remaining,
      },
    },
  };
  if (!frameCtx.lobby.map)
    frameCtx.lobby.map = generateMap(frameCtx.lobby.seed);
  return { map: frameCtx.getState()?.map ?? frameCtx.lobby.map, overlay };
}

/** Handle a lobby key press — resolve slot from key bindings, call `onJoin` if valid. */
export function lobbyKeyJoin(
  frameCtx: UIContext,
  key: string,
  onJoin: (pid: number) => void,
): boolean {
  if (!frameCtx.lobby.active) return false;
  const map = createLobbyConfirmKeys(frameCtx.settings.keyBindings);
  const pid = map.get(key);
  if (pid === undefined) return false;
  if (frameCtx.lobby.joined[pid]) {
    lobbySkipStep(frameCtx);
    return true;
  }
  onJoin(pid);
  return true;
}

/** Speed up lobby timer by one step if allowed. Returns true if timer was advanced. */
export function lobbySkipStep(frameCtx: UIContext): boolean {
  if (frameCtx.lobby.timerAccum === undefined) return false;
  if (frameCtx.getLobbyRemaining() <= LOBBY_SKIP_LOCKOUT) return false;
  frameCtx.lobby.timerAccum += LOBBY_SKIP_STEP;
  return true;
}

export function visibleOptions(frameCtx: UIContext): number[] {
  // 0=Difficulty, 1=Rounds, 2=Cannon HP, 3=Haptics, 4=Seed, 5=Controls, 6=D-Pad, 7=Sound, 8=Game Mode
  if (frameCtx.isOnline)
    return IS_TOUCH_DEVICE ? [1, 2, 8, 3, 7, 4, 5, 6] : [1, 2, 8, 7, 4, 5];
  return IS_TOUCH_DEVICE ? [0, 1, 2, 8, 3, 7, 4, 5, 6] : [0, 1, 2, 8, 7, 4, 5];
}

function optionValue(frameCtx: UIContext, idx: number): string {
  const settings = frameCtx.settings;
  const state = frameCtx.getState();
  if (idx === 0) return DIFFICULTY_LABELS[settings.difficulty]!;
  if (idx === 1) {
    const opt = ROUNDS_OPTIONS[settings.rounds]!;
    if (frameCtx.getOptionsReturnMode() !== null && state) {
      return `${opt.label} (round ${state.round})`;
    }
    return opt.label;
  }
  if (idx === 2) return CANNON_HP_OPTIONS[settings.cannonHp]!.label;
  if (idx === 3) return HAPTICS_LABELS[settings.haptics] ?? "All";
  if (idx === 7) return SOUND_LABELS[settings.sound] ?? "All";
  if (idx === 4) {
    if (frameCtx.isOnline) return settings.seed || "—";
    if (frameCtx.getOptionsReturnMode() !== null && state) {
      return String(state.rng.seed);
    }
    return settings.seedMode === SEED_CUSTOM ? settings.seed || "_" : "Random";
  }
  if (idx === 6) return DPAD_LABELS[settings.leftHanded ? 1 : 0]!;
  if (idx === 8)
    return GAME_MODE_LABELS[settings.gameMode === GAME_MODE_MODERN ? 1 : 0]!;
  return "";
}
