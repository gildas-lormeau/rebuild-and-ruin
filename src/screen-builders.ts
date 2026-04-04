/**
 * Shared options/controls/lobby screen rendering.
 * Used by both main.ts and online-client.ts.
 */

import {
  GAME_MODE_MODERN,
  LOBBY_SKIP_LOCKOUT,
  LOBBY_SKIP_STEP,
} from "./game-constants.ts";
import type { GameMap } from "./geometry-types.ts";
import type { OptionEntry, RenderOverlay } from "./overlay-types.ts";
import { IS_TOUCH_DEVICE } from "./platform.ts";
import {
  ACTION_KEYS,
  createLobbyConfirmKeys,
  formatKeyHint,
  type GameSettings,
  getPlayerColor,
  type KeyBindings,
  PLAYER_NAMES,
  SEED_CUSTOM,
  saveSettings,
} from "./player-config.ts";
import type { ValidPlayerSlot } from "./player-slot.ts";
import {
  CANNON_HP_OPTIONS,
  DIFFICULTY_LABELS,
  DPAD_LABELS,
  GAME_MODE_LABELS,
  HAPTICS_LABELS,
  OPT_CANNON_HP,
  OPT_CONTROLS,
  OPT_DIFFICULTY,
  OPT_DPAD,
  OPT_GAME_MODE,
  OPT_HAPTICS,
  OPT_ROUNDS,
  OPT_SEED,
  OPT_SOUND,
  OPTION_NAMES,
  ROUNDS_OPTIONS,
  SOUND_LABELS,
} from "./settings-defs.ts";
import { formatKeyName } from "./settings-ui.ts";
import {
  type ControlsState,
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

export function createOptionsOverlay(frameCtx: UIContext): {
  map: GameMap;
  overlay: RenderOverlay;
} {
  const lobbyMap = frameCtx.lobby.map!;
  const readOnly = frameCtx.getOptionsReturnMode() !== null;
  const visible = visibleOptions(frameCtx);
  const options: OptionEntry[] = visible.map((i) => {
    // Seed is typed, Controls is opened via confirm — neither uses left/right cycling
    if (i === OPT_SEED || i === OPT_CONTROLS)
      return {
        name: OPTION_NAMES[i]!,
        value: optionValue(frameCtx, i),
        editable: false,
      };
    // Online: Rounds, Cannon HP, Game Mode are locked by room host
    if (
      frameCtx.isOnline &&
      (i === OPT_ROUNDS || i === OPT_CANNON_HP || i === OPT_GAME_MODE)
    )
      return {
        name: OPTION_NAMES[i]!,
        value: optionValue(frameCtx, i),
        editable: false,
      };
    // In-game: Difficulty, Cannon HP, Game Mode are locked
    if (
      readOnly &&
      (i === OPT_DIFFICULTY || i === OPT_CANNON_HP || i === OPT_GAME_MODE)
    )
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
  const lobbyMap = frameCtx.lobby.map!;
  const cs = frameCtx.controlsState;
  const playerCount = IS_TOUCH_DEVICE ? 1 : PLAYER_NAMES.length;
  const players = PLAYER_NAMES.slice(0, playerCount).map((name, player) => {
    const kb = frameCtx.settings.keyBindings[player]!;
    return {
      name: name!,
      color: getPlayerColor(player as ValidPlayerSlot).wall,
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
          color: getPlayerColor(i as ValidPlayerSlot).wall,
          joined: frameCtx.lobby.joined[i]!,
          keyHint: frameCtx.settings.keyBindings[i]
            ? formatKeyHint(frameCtx.settings.keyBindings[i])
            : undefined,
        })),
        timer: remaining,
      },
    },
  };
  return { map: frameCtx.getState()?.map ?? frameCtx.lobby.map!, overlay };
}

/** Handle a lobby key press — resolve slot from key bindings, call `onJoin` if valid. */
export function lobbyKeyJoin(
  frameCtx: UIContext,
  key: string,
  onJoin: (pid: ValidPlayerSlot) => void,
): boolean {
  if (!frameCtx.lobby.active) return false;
  const map = createLobbyConfirmKeys(frameCtx.settings.keyBindings);
  const pid = map.get(key);
  if (pid === undefined) return false;
  if (frameCtx.lobby.joined[pid]) {
    lobbySkipStep(frameCtx);
    return true;
  }
  onJoin(pid as ValidPlayerSlot);
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
  if (frameCtx.isOnline)
    return IS_TOUCH_DEVICE
      ? [
          OPT_ROUNDS,
          OPT_CANNON_HP,
          OPT_GAME_MODE,
          OPT_HAPTICS,
          OPT_SOUND,
          OPT_SEED,
          OPT_CONTROLS,
          OPT_DPAD,
        ]
      : [
          OPT_ROUNDS,
          OPT_CANNON_HP,
          OPT_GAME_MODE,
          OPT_SOUND,
          OPT_SEED,
          OPT_CONTROLS,
        ];
  return IS_TOUCH_DEVICE
    ? [
        OPT_DIFFICULTY,
        OPT_ROUNDS,
        OPT_CANNON_HP,
        OPT_GAME_MODE,
        OPT_HAPTICS,
        OPT_SOUND,
        OPT_SEED,
        OPT_CONTROLS,
        OPT_DPAD,
      ]
    : [
        OPT_DIFFICULTY,
        OPT_ROUNDS,
        OPT_CANNON_HP,
        OPT_GAME_MODE,
        OPT_SOUND,
        OPT_SEED,
        OPT_CONTROLS,
      ];
}

function optionValue(frameCtx: UIContext, idx: number): string {
  const settings = frameCtx.settings;
  const state = frameCtx.getState();
  if (idx === OPT_DIFFICULTY) return DIFFICULTY_LABELS[settings.difficulty]!;
  if (idx === OPT_ROUNDS) {
    const opt = ROUNDS_OPTIONS[settings.rounds]!;
    if (frameCtx.getOptionsReturnMode() !== null && state) {
      return `${opt.label} (round ${state.round})`;
    }
    return opt.label;
  }
  if (idx === OPT_CANNON_HP) return CANNON_HP_OPTIONS[settings.cannonHp]!.label;
  if (idx === OPT_HAPTICS) return HAPTICS_LABELS[settings.haptics] ?? "All";
  if (idx === OPT_SOUND) return SOUND_LABELS[settings.sound] ?? "All";
  if (idx === OPT_SEED) {
    if (frameCtx.isOnline) return settings.seed || "—";
    if (frameCtx.getOptionsReturnMode() !== null && state) {
      return String(state.rng.seed);
    }
    return settings.seedMode === SEED_CUSTOM ? settings.seed || "_" : "Random";
  }
  if (idx === OPT_DPAD) return DPAD_LABELS[settings.leftHanded ? 1 : 0]!;
  if (idx === OPT_GAME_MODE)
    return GAME_MODE_LABELS[settings.gameMode === GAME_MODE_MODERN ? 1 : 0]!;
  return "";
}
