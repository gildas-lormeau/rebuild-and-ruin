/**
 * Shared options/controls/lobby screen rendering.
 * Used by both main.ts and online-client.ts.
 */

import { createLobbyConfirmKeys, formatKeyHint } from "./game-ui-runtime.ts";
import { formatKeyName, saveSettings } from "./game-ui-settings.ts";
import type { LobbyState } from "./game-ui-types.ts";
import {
  CANNON_HP_OPTIONS,
  type ControlsState,
  DIFFICULTY_LABELS,
  DPAD_LABELS,
  type GameSettings,
  HAPTICS_LABELS,
  OPTION_NAMES,
  ROUNDS_OPTIONS,
} from "./game-ui-types.ts";
import type { GameMap } from "./geometry-types.ts";
import { generateMap } from "./map-generation.ts";
import { IS_TOUCH_DEVICE } from "./platform.ts";
import { ACTION_KEYS, getPlayerColor, type KeyBindings, PLAYER_NAMES, SEED_CUSTOM } from "./player-config.ts";
import type { OptionEntry, RenderOverlay } from "./render-types.ts";
import { type GameState, LOBBY_SKIP_LOCKOUT, LOBBY_SKIP_STEP, type Mode } from "./types.ts";

export interface UIContext {
  getState: () => GameState | undefined;
  getOverlay: () => RenderOverlay;
  settings: GameSettings;
  getMode: () => Mode;
  setMode: (m: Mode) => void;
  getPaused: () => boolean;
  setPaused: (v: boolean) => void;
  optionsCursor: { value: number };
  controlsState: ControlsState;
  getOptionsReturnMode: () => Mode | null;
  setOptionsReturnMode: (m: Mode | null) => void;
  lobby: LobbyState;
  getFrame: () => { announcement?: string };
  getLobbyRemaining: () => number;
  isOnline?: boolean;
}

const CONTROL_ACTION_NAMES: readonly string[] = ["Up", "Down", "Left", "Right", "Confirm", "Rotate"];

export function buildOptionsOverlay(ctx: UIContext): { map: GameMap; overlay: RenderOverlay } {
  const lobbyMap = ctx.lobby.map ?? generateMap(ctx.lobby.seed);
  const readOnly = ctx.getOptionsReturnMode() !== null;
  const visible = visibleOptions(ctx);
  const options: OptionEntry[] = visible.map((i) => {
    // Seed is typed, Controls is opened via confirm — neither uses left/right cycling
    if (i === 4 || i === 5) return { name: OPTION_NAMES[i]!, value: optionValue(ctx, i), editable: false };
    // Online: Rounds, Cannon HP, Seed are locked by room host
    if (ctx.isOnline && (i === 1 || i === 2)) return { name: OPTION_NAMES[i]!, value: optionValue(ctx, i), editable: false };
    // In-game: Difficulty and Cannon HP are locked (only Rounds, Haptics, D-Pad remain editable)
    if (readOnly && (i === 0 || i === 2)) return { name: OPTION_NAMES[i]!, value: optionValue(ctx, i), editable: false };
    return { name: OPTION_NAMES[i]!, value: optionValue(ctx, i), editable: true };
  });
  const overlay: RenderOverlay = {
    selection: { highlighted: null, selected: null },
    ui: {
      optionsScreen: {
        options,
        cursor: ctx.optionsCursor.value,
        readOnly,
      },
    },
  };
  return { map: ctx.getState()?.map ?? lobbyMap, overlay };
}

export function showOptions(ctx: UIContext, modeValues: { OPTIONS: Mode }): void {
  ctx.optionsCursor.value = 0;
  ctx.setMode(modeValues.OPTIONS);
}

export function closeOptions(ctx: UIContext, modeValues: { LOBBY: Mode; GAME: Mode }): void {
  const returnMode = ctx.getOptionsReturnMode();
  if (returnMode !== null) {
    // Returning to game — read-only view, don't save settings
    ctx.setMode(returnMode);
    ctx.setOptionsReturnMode(null);
  } else {
    ctx.setMode(modeValues.LOBBY);
    saveSettings(ctx.settings);
  }
}

export function buildControlsOverlay(ctx: UIContext): { map: GameMap; overlay: RenderOverlay } {
  const lobbyMap = ctx.lobby.map ?? generateMap(ctx.lobby.seed);
  const cs = ctx.controlsState;
  const players = PLAYER_NAMES.map((name, p) => {
    const kb = ctx.settings.keyBindings[p]!;
    return {
      name: name!,
      color: getPlayerColor(p).wall,
      bindings: ACTION_KEYS.map(key => formatKeyName(kb[key as keyof KeyBindings])),
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
  return { map: ctx.getState()?.map ?? lobbyMap, overlay };
}

export function showControls(ctx: UIContext, modeValues: { CONTROLS: Mode }): void {
  ctx.controlsState.playerIdx = 0;
  ctx.controlsState.actionIdx = 0;
  ctx.controlsState.rebinding = false;
  ctx.setMode(modeValues.CONTROLS);
}

export function closeControls(ctx: UIContext, modeValues: { OPTIONS: Mode }): void {
  saveSettings(ctx.settings);
  ctx.setMode(modeValues.OPTIONS);
}

export function togglePause(ctx: UIContext, modeValues: { GAME: Mode; SELECTION: Mode }): boolean {
  const mode = ctx.getMode();
  if (mode !== modeValues.GAME && mode !== modeValues.SELECTION) return false;
  const next = !ctx.getPaused();
  ctx.setPaused(next);
  ctx.getFrame().announcement = next ? "PAUSED" : undefined;
  return true;
}

/** Tick the lobby — check expiry. Calls `onExpired` when timer runs out or all slots are filled. */
export function tickLobby(ctx: UIContext, onExpired: () => void): void {
  if (!ctx.lobby.active) return;
  const allJoined = ctx.lobby.joined.every(Boolean);
  if (ctx.getLobbyRemaining() <= 0 || allJoined) {
    ctx.lobby.active = false;
    onExpired();
  }
}

export function buildLobbyOverlay(ctx: UIContext): { map: GameMap; overlay: RenderOverlay } {
  const remaining = Math.max(0, ctx.getLobbyRemaining());
  const overlay: RenderOverlay = {
    selection: { highlighted: null, selected: null },
    ui: {
      playerSelect: {
        players: PLAYER_NAMES.map((name, i) => ({
          name: `${name} Player`,
          color: getPlayerColor(i).wall,
          joined: ctx.lobby.joined[i]!,
          keyHint: ctx.settings.keyBindings[i]
            ? formatKeyHint(ctx.settings.keyBindings[i])
            : undefined,
        })),
        timer: remaining,
      },
    },
  };
  if (!ctx.lobby.map) ctx.lobby.map = generateMap(ctx.lobby.seed);
  return { map: ctx.getState()?.map ?? ctx.lobby.map, overlay };
}

/** Handle a lobby key press — resolve slot from key bindings, call `onJoin` if valid. */
export function lobbyKeyJoin(
  ctx: UIContext,
  key: string,
  onJoin: (pid: number) => void,
): boolean {
  if (!ctx.lobby.active) return false;
  const m = createLobbyConfirmKeys(ctx.settings.keyBindings);
  const pid = m.get(key);
  if (pid === undefined) return false;
  if (ctx.lobby.joined[pid]) {
    lobbySkipStep(ctx);
    return true;
  }
  onJoin(pid);
  return true;
}

/** Speed up lobby timer by one step if allowed. Returns true if timer was advanced. */
export function lobbySkipStep(ctx: UIContext): boolean {
  if (ctx.lobby.timerAccum === undefined) return false;
  if (ctx.getLobbyRemaining() <= LOBBY_SKIP_LOCKOUT) return false;
  ctx.lobby.timerAccum += LOBBY_SKIP_STEP;
  return true;
}

export function visibleOptions(ctx: UIContext): number[] {
  // 0=Difficulty, 1=Rounds, 2=Cannon HP, 3=Haptics, 4=Seed, 5=Controls, 6=D-Pad
  if (ctx.isOnline) return IS_TOUCH_DEVICE ? [1, 2, 3, 4, 5, 6] : [1, 2, 4, 5];
  return IS_TOUCH_DEVICE ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 4, 5];
}

function optionValue(ctx: UIContext, idx: number): string {
  const s = ctx.settings;
  const state = ctx.getState();
  if (idx === 0) return DIFFICULTY_LABELS[s.difficulty]!;
  if (idx === 1) {
    const opt = ROUNDS_OPTIONS[s.rounds]!;
    if (ctx.getOptionsReturnMode() !== null && state) {
      return `${opt.label} (round ${state.round})`;
    }
    return opt.label;
  }
  if (idx === 2) return CANNON_HP_OPTIONS[s.cannonHp]!.label;
  if (idx === 3) return HAPTICS_LABELS[s.haptics] ?? "All";
  if (idx === 4) {
    if (ctx.isOnline) return s.seed || "—";
    return s.seedMode === SEED_CUSTOM ? (s.seed || "_") : "Random";
  }
  if (idx === 6) return DPAD_LABELS[s.leftHanded ? 1 : 0]!;
  return "";
}
