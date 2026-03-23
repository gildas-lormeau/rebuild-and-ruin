/**
 * Shared options/controls/lobby screen rendering.
 * Used by both main.ts and online-client.ts.
 */

import { renderMap } from "./map-renderer.ts";
import type { RenderOverlay } from "./map-renderer.ts";
import type { GameState } from "./types.ts";
import { LOBBY_SKIP_LOCKOUT, LOBBY_SKIP_STEP } from "./types.ts";

/** Speed up lobby timer by one step if allowed. Returns true if timer was advanced. */
export function lobbySkipStep(ctx: UIContext): boolean {
  if (ctx.lobby.timerAccum === undefined) return false;
  if (ctx.getLobbyRemaining() <= LOBBY_SKIP_LOCKOUT) return false;
  ctx.lobby.timerAccum += LOBBY_SKIP_STEP;
  return true;
}
import type { GameMap } from "./map-generation.ts";
import { generateMap } from "./map-generation.ts";
import { PLAYER_NAMES, PLAYER_COLORS } from "./player-config.ts";
import {
  DIFFICULTY_LABELS, ROUNDS_OPTIONS, CANNON_HP_OPTIONS, HAPTICS_LABELS, DPAD_LABELS, OPTION_NAMES,
  formatKeyName, saveSettings,
  type GameSettings, type ControlsState,
} from "./game-ui-types.ts";
import { formatKeyHint, buildLobbyConfirmKeys } from "./game-ui-runtime.ts";
import type { Mode } from "./game-ui-types.ts";

// ---------------------------------------------------------------------------
// UI Context — mutable state shared by all screen functions
// ---------------------------------------------------------------------------

export interface UIContext {
  canvas: HTMLCanvasElement;
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
  lobby: { joined: boolean[]; active: boolean; map: GameMap | null; timerAccum?: number };
  getFrame: () => { announcement?: string };
  getLobbyRemaining: () => number;
  render: () => void;
  isOnline?: boolean;
}

// ---------------------------------------------------------------------------
// Option value display
// ---------------------------------------------------------------------------

import { IS_TOUCH_DEVICE } from "./platform.ts";
import { FONT_TITLE, FONT_HEADING, FONT_BODY } from "./render-theme.ts";

/** Which option indices are visible in the current mode. */

export function visibleOptions(ctx: UIContext): number[] {
  // 0=Difficulty, 1=Rounds, 2=Cannon HP, 3=Haptics, 4=Seed, 5=Controls, 6=D-Pad
  if (ctx.isOnline) return IS_TOUCH_DEVICE ? [1, 2, 3, 4, 5, 6] : [1, 2, 4, 5];
  return IS_TOUCH_DEVICE ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 4, 5];
}

export function optionValue(ctx: UIContext, idx: number): string {
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
  if (idx === 4) return s.seedMode === "custom" ? (s.seed || "_") : "Random";
  if (idx === 6) return DPAD_LABELS[s.leftHanded ? 1 : 0]!;
  return "";
}

// ---------------------------------------------------------------------------
// Options screen
// ---------------------------------------------------------------------------

export function buildOptionsUi(ctx: UIContext): void {
  const oc = ctx.canvas.getContext("2d")!;
  oc.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const readOnly = ctx.getOptionsReturnMode() !== null;
  const visible = visibleOptions(ctx);
  for (let row = 0; row < visible.length; row++) {
    const i = visible[row]!;
    const sel = row === ctx.optionsCursor.value;
    const val = optionValue(ctx, i);
    const y = 80 + row * 40;
    // In online mode, Rounds and Cannon HP are always read-only (set by room host)
    const isReadOnly = readOnly || (ctx.isOnline && (i === 1 || i === 2 || i === 4));
    oc.fillStyle = sel ? "#fff" : "#aaa";
    oc.font = sel ? FONT_TITLE : FONT_HEADING;
    const prefix = (isReadOnly && i !== 4) ? "  " : (sel ? "> " : "  ");
    oc.fillText(`${prefix}${OPTION_NAMES[i]}: ${val}`, 40, y);
  }
}

export function renderOptions(ctx: UIContext): void {
  const lobbyMap = ctx.lobby.map ?? generateMap(0);
  ctx.lobby.map = lobbyMap;
  const overlay: RenderOverlay = { selection: { highlighted: null, selected: null } };
  renderMap(ctx.getState()?.map ?? lobbyMap, ctx.canvas, overlay);
  buildOptionsUi(ctx);
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

// ---------------------------------------------------------------------------
// Controls screen
// ---------------------------------------------------------------------------

export function buildControlsUi(ctx: UIContext): void {
  const oc = ctx.canvas.getContext("2d")!;
  oc.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const cs = ctx.controlsState;
  for (let p = 0; p < PLAYER_NAMES.length; p++) {
    const colors = PLAYER_COLORS[p % PLAYER_COLORS.length]!;
    const sel = p === cs.playerIdx;
    oc.fillStyle = sel ? `rgb(${colors.wall[0]},${colors.wall[1]},${colors.wall[2]})` : "#888";
    oc.font = sel ? FONT_HEADING : FONT_BODY;
    oc.fillText(PLAYER_NAMES[p]!, 40 + p * 200, 40);
  }
  const kb = ctx.settings.keyBindings[cs.playerIdx]!;
  const keys = ["up", "down", "left", "right", "confirm", "rotate"] as const;
  const names = ["Up", "Down", "Left", "Right", "Confirm", "Rotate"];
  for (let a = 0; a < keys.length; a++) {
    const sel = a === cs.actionIdx;
    const keyVal = kb[keys[a]!];
    oc.fillStyle = sel ? "#fff" : "#aaa";
    oc.font = sel ? FONT_HEADING : FONT_BODY;
    const rebindStr = sel && cs.rebinding ? " [press key]" : "";
    oc.fillText(`  ${names[a]}: ${formatKeyName(keyVal)}${rebindStr}`, 40, 80 + a * 32);
  }
}

export function renderControls(ctx: UIContext): void {
  const lobbyMap = ctx.lobby.map ?? generateMap(0);
  ctx.lobby.map = lobbyMap;
  const overlay: RenderOverlay = { selection: { highlighted: null, selected: null } };
  renderMap(ctx.getState()?.map ?? lobbyMap, ctx.canvas, overlay);
  buildControlsUi(ctx);
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

// ---------------------------------------------------------------------------
// Pause
// ---------------------------------------------------------------------------

export function togglePause(ctx: UIContext, modeValues: { GAME: Mode; SELECTION: Mode }): boolean {
  const mode = ctx.getMode();
  if (mode !== modeValues.GAME && mode !== modeValues.SELECTION) return false;
  const next = !ctx.getPaused();
  ctx.setPaused(next);
  ctx.getFrame().announcement = next ? "PAUSED" : undefined;
  return true;
}

// ---------------------------------------------------------------------------
// Lobby rendering
// ---------------------------------------------------------------------------

export function renderLobby(ctx: UIContext): void {
  const remaining = Math.max(0, ctx.getLobbyRemaining());
  const lobbyOverlay: RenderOverlay = {
    selection: { highlighted: null, selected: null },
    ui: {
      playerSelect: {
        players: PLAYER_NAMES.map((name, i) => ({
          name: `${name} Player`,
          color: PLAYER_COLORS[i % PLAYER_COLORS.length]!.wall,
          joined: ctx.lobby.joined[i]!,
          keyHint: ctx.settings.keyBindings[i]
            ? formatKeyHint(ctx.settings.keyBindings[i])
            : undefined,
        })),
        timer: remaining,
      },
    },
  };
  if (!ctx.lobby.map) ctx.lobby.map = generateMap(0);
  renderMap(ctx.getState()?.map ?? ctx.lobby.map, ctx.canvas, lobbyOverlay);
}

/** Tick the lobby — render + check expiry. Calls `onExpired` when timer runs out or all slots are filled. */
export function tickLobby(ctx: UIContext, onExpired: () => void): void {
  if (!ctx.lobby.active) return;
  renderLobby(ctx);
  const allJoined = ctx.lobby.joined.every(Boolean);
  if (ctx.getLobbyRemaining() <= 0 || allJoined) {
    ctx.lobby.active = false;
    onExpired();
  }
}

/** Handle a lobby key press — resolve slot from key bindings, call `onJoin` if valid. */
export function lobbyKeyJoin(
  ctx: UIContext,
  key: string,
  onJoin: (pid: number) => void,
): boolean {
  if (!ctx.lobby.active) return false;
  const m = buildLobbyConfirmKeys(ctx.settings.keyBindings);
  const pid = m.get(key);
  if (pid === undefined) return false;
  if (ctx.lobby.joined[pid]) {
    lobbySkipStep(ctx);
    return true;
  }
  onJoin(pid);
  return true;
}
