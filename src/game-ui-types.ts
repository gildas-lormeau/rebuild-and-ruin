/**
 * Shared types, enums, and constants for the game UI.
 * Used by both main.ts (local play) and online-client.ts (online play).
 */

import type { KeyBindings, RGB } from "./player-config.ts";
import { PLAYER_KEY_BINDINGS, MAX_PLAYERS } from "./player-config.ts";
import type { BalloonFlight } from "./battle-system.ts";
import type { Impact } from "./types.ts";
import type { Crosshair, PhantomPiece } from "./player-controller.ts";
import type { GameMap } from "./map-generation.ts";

// ---------------------------------------------------------------------------
// Mode enum
// ---------------------------------------------------------------------------

export enum Mode {
  LOBBY,
  OPTIONS,
  CONTROLS,
  SELECTION,
  BANNER,
  BALLOON_ANIM,
  CASTLE_BUILD,
  LIFE_LOST,
  GAME,
  STOPPED,
}

// ---------------------------------------------------------------------------
// Timer accumulators
// ---------------------------------------------------------------------------

export interface TimerAccums {
  battle: number;
  cannon: number;
  select: number;
  build: number;
  grunt: number;
}

export function createTimerAccums(): TimerAccums {
  return { battle: 0, cannon: 0, select: 0, build: 0, grunt: 0 };
}

// ---------------------------------------------------------------------------
// Game settings
// ---------------------------------------------------------------------------

export interface GameSettings {
  difficulty: number;
  rounds: number;
  cannonHp: number;
  haptics: number; // 0=off, 1=phase changes only, 2=all
  seed: string;
  seedMode: "random" | "custom";
  keyBindings: KeyBindings[];
}

export const DIFFICULTY_LABELS = ["Easy", "Normal", "Hard", "Very Hard"];
export const ROUNDS_OPTIONS = [
  { value: 3, label: "3" },
  { value: 5, label: "5" },
  { value: 8, label: "8" },
  { value: 12, label: "12" },
  { value: 0, label: "To The Death" },
];
export const CANNON_HP_OPTIONS = [
  { value: 3, label: "3 hits" },
  { value: 6, label: "6 hits" },
  { value: 9, label: "9 hits" },
  { value: 12, label: "12 hits" },
];
export const HAPTICS_LABELS = ["Off", "Phase changes", "All"];
export const OPTION_NAMES = ["Difficulty", "Rounds", "Cannon Kill", "Haptics", "Seed", "Controls"];
export const SETTINGS_KEY = "castles99_settings";
export const DEFAULT_SETTINGS: GameSettings = {
  difficulty: 1,
  rounds: 4,
  cannonHp: 0,
  haptics: 2, // default: all
  seed: "",
  seedMode: "random",
  keyBindings: [],
};

// ---------------------------------------------------------------------------
// Controls screen state
// ---------------------------------------------------------------------------

export interface ControlsState {
  playerIdx: number;
  actionIdx: number;
  rebinding: boolean;
}

export function createControlsState(): ControlsState {
  return { playerIdx: 0, actionIdx: 0, rebinding: false };
}

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

function deepCopyBindings(): KeyBindings[] {
  return PLAYER_KEY_BINDINGS.map(kb => ({ ...kb }));
}

export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<GameSettings>;
      return {
        difficulty: saved.difficulty ?? DEFAULT_SETTINGS.difficulty,
        rounds: saved.rounds ?? DEFAULT_SETTINGS.rounds,
        cannonHp: saved.cannonHp ?? DEFAULT_SETTINGS.cannonHp,
        haptics: saved.haptics ?? DEFAULT_SETTINGS.haptics,
        seed: saved.seed ?? DEFAULT_SETTINGS.seed,
        seedMode: saved.seedMode === "custom" ? "custom" : "random",
        keyBindings:
          Array.isArray(saved.keyBindings) && saved.keyBindings.length === MAX_PLAYERS
            ? saved.keyBindings.map(kb => ({ ...PLAYER_KEY_BINDINGS[0]!, ...kb }))
            : deepCopyBindings(),
      };
    }
  } catch { /* ignore corrupt data */ }
  return { ...DEFAULT_SETTINGS, keyBindings: deepCopyBindings() };
}

export function saveSettings(settings: GameSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* storage full or unavailable */ }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export function formatKeyName(key: string): string {
  if (key === "ArrowUp") return "\u2191";
  if (key === "ArrowDown") return "\u2193";
  if (key === "ArrowLeft") return "\u2190";
  if (key === "ArrowRight") return "\u2192";
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

// ---------------------------------------------------------------------------
// cycleOption — shared between main.ts and online-client.ts
// ---------------------------------------------------------------------------

export function cycleOption(
  dir: number,
  optionsCursor: number,
  settings: GameSettings,
  optionsReturnMode: unknown,
  state: { round: number; battleLength: number } | null,
): void {
  if (optionsCursor === 0) {
    settings.difficulty =
      (settings.difficulty + dir + DIFFICULTY_LABELS.length) %
      DIFFICULTY_LABELS.length;
  } else if (optionsCursor === 1) {
    let next =
      (settings.rounds + dir + ROUNDS_OPTIONS.length) % ROUNDS_OPTIONS.length;
    // In-game: only allow values >= current round (so players can shorten, not extend past current)
    if (optionsReturnMode !== null && state) {
      const minRound = state.round;
      // Skip options whose value is > 0 (not "To The Death") and < current round
      for (let attempts = 0; attempts < ROUNDS_OPTIONS.length; attempts++) {
        const val = ROUNDS_OPTIONS[next]!.value;
        if (val === 0 || val >= minRound) break; // 0 = "To The Death" is always valid
        next = (next + dir + ROUNDS_OPTIONS.length) % ROUNDS_OPTIONS.length;
      }
    }
    settings.rounds = next;
    // Apply immediately to the live game
    if (optionsReturnMode !== null && state) {
      const val = ROUNDS_OPTIONS[settings.rounds]!.value;
      state.battleLength = val > 0 ? val : Infinity;
    }
  } else if (optionsCursor === 2) {
    settings.cannonHp =
      (settings.cannonHp + dir + CANNON_HP_OPTIONS.length) %
      CANNON_HP_OPTIONS.length;
  } else if (optionsCursor === 3) {
    settings.haptics =
      (settings.haptics + dir + HAPTICS_LABELS.length) %
      HAPTICS_LABELS.length;
  }
  // optionsCursor === 4 (Seed) — handled via direct keyboard input in options handler
  // optionsCursor === 5 (Controls) — no left/right value, opened via confirm
}

// ---------------------------------------------------------------------------
// Shared frame / animation / lobby types
// ---------------------------------------------------------------------------

/** Per-frame data written by tick functions, read by render(). */
export interface FrameData {
  crosshairs: Crosshair[];
  phantoms: {
    aiPhantoms?: {
      offsets: [number, number][];
      row: number;
      col: number;
      playerId: number;
    }[];
    humanPhantoms?: PhantomPiece[];
    aiCannonPhantoms?: {
      row: number;
      col: number;
      valid: boolean;
      isSuper?: boolean;
      isBalloon?: boolean;
      playerId: number;
      facing?: number;
    }[];
    phantomPiece?: {
      offsets: [number, number][];
      row: number;
      col: number;
      valid: boolean;
      playerId?: number;
    } | null;
  };
  announcement?: string;
  gameOver?: {
    winner: string;
    scores: { name: string; score: number; color: RGB; eliminated: boolean; territory?: number; stats?: { wallsDestroyed: number; cannonsKilled: number } }[];
    focused: "rematch" | "menu";
  };
}

/** Battle animation state — snapshots and effects. */
export interface BattleAnimState {
  territory: Set<number>[];
  walls: Set<number>[];
  flights: { flight: BalloonFlight; progress: number }[];
  impacts: Impact[];
}

export function createBattleAnimState(): BattleAnimState {
  return { territory: [], walls: [], flights: [], impacts: [] };
}

/** Player selection lobby state. */
export interface LobbyState {
  joined: boolean[];
  active: boolean;
  /** Accumulator for lobby countdown timer (local play). */
  timerAccum?: number;
  map: GameMap | null;
}
