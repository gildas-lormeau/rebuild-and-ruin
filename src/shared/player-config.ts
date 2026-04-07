/**
 * Shared player-facing configuration.
 *
 * Keep player names, colors, and bindings in one place so they cannot drift.
 */

import {
  DIFFICULTY_NORMAL,
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
  type GameMode,
  HAPTICS_ALL,
} from "./game-constants.ts";
import { KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_UP } from "./platform.ts";
import type { ValidPlayerSlot } from "./player-slot.ts";
import type { RGB } from "./theme.ts";

export interface KeyBindings {
  up: string;
  down: string;
  left: string;
  right: string;
  confirm: string; // place / fire / select
  rotate: string; // rotate piece / cycle cannon mode / accelerate crosshair
}

interface PlayerColor {
  wall: RGB;
  interiorLight: RGB;
  interiorDark: RGB;
}

export type SeedMode = "random" | "custom";

export interface GameSettings {
  difficulty: number;
  /** Index into ROUNDS_OPTIONS — not the round-count value itself. */
  rounds: number;
  /** Index into CANNON_HP_OPTIONS — not the HP value itself. */
  cannonHp: number;
  haptics: number; // 0=off, 1=phase changes only, 2=all
  sound: number; // 0=off, 1=phase changes only, 2=all
  seed: string;
  seedMode: SeedMode;
  keyBindings: KeyBindings[];
  leftHanded: boolean; // true = d-pad on right, action buttons on left
  gameMode: GameMode;
}

const SOUND_OFF = 0;
/** Index into ROUNDS_OPTIONS (not the value itself — value is 0 = infinite). */
const ROUNDS_TO_THE_DEATH_INDEX = 4;
/** Index into CANNON_HP_OPTIONS (not the HP value itself — value is 3 hits). */
const CANNON_HP_DEFAULT_INDEX = 0;
const SETTINGS_KEY = "castles99_settings";
// Player castle colors: wall (stone-tinted) and interior (checkerboard light/dark)
const RED_WALL: RGB = [150, 110, 110];
const RED_INTERIOR_LIGHT: RGB = [170, 30, 30];
const RED_INTERIOR_DARK: RGB = [50, 10, 10];
const BLUE_WALL: RGB = [100, 105, 140];
const BLUE_INTERIOR_LIGHT: RGB = [30, 50, 170];
const BLUE_INTERIOR_DARK: RGB = [10, 15, 50];
const GOLD_WALL: RGB = [170, 145, 90];
const GOLD_INTERIOR_LIGHT: RGB = [190, 130, 20];
const GOLD_INTERIOR_DARK: RGB = [55, 40, 10];
/** Ordered action keys for the controls screen (matches KeyBindings fields). */
const ACTION_UP = "up";
const ACTION_DOWN = "down";
const ACTION_LEFT = "left";
const ACTION_RIGHT = "right";
const ACTION_ROTATE = "rotate";
const ACTION_CONFIRM = "confirm";
export const PLAYER_NAMES = ["Red", "Blue", "Gold"] as const;
export const PLAYER_COLORS: readonly PlayerColor[] = [
  {
    wall: RED_WALL,
    interiorLight: RED_INTERIOR_LIGHT,
    interiorDark: RED_INTERIOR_DARK,
  },
  {
    wall: BLUE_WALL,
    interiorLight: BLUE_INTERIOR_LIGHT,
    interiorDark: BLUE_INTERIOR_DARK,
  },
  {
    wall: GOLD_WALL,
    interiorLight: GOLD_INTERIOR_LIGHT,
    interiorDark: GOLD_INTERIOR_DARK,
  },
];
export const PLAYER_KEY_BINDINGS: readonly KeyBindings[] = [
  {
    up: KEY_UP,
    down: KEY_DOWN,
    left: KEY_LEFT,
    right: KEY_RIGHT,
    confirm: "n",
    rotate: "b",
  },
  {
    up: "w",
    down: "s",
    left: "a",
    right: "d",
    confirm: "f",
    rotate: "e",
  },
  {
    up: "i",
    down: "k",
    left: "j",
    right: "l",
    confirm: "h",
    rotate: "u",
  },
];
export const MAX_PLAYERS = PLAYER_NAMES.length;
export const ACTION_KEYS: readonly (keyof KeyBindings)[] = [
  ACTION_UP,
  ACTION_DOWN,
  ACTION_LEFT,
  ACTION_RIGHT,
  ACTION_CONFIRM,
  ACTION_ROTATE,
];
export const SEED_RANDOM = "random";
const DEFAULT_SETTINGS: GameSettings = {
  difficulty: DIFFICULTY_NORMAL,
  rounds: ROUNDS_TO_THE_DEATH_INDEX,
  cannonHp: CANNON_HP_DEFAULT_INDEX,
  haptics: HAPTICS_ALL,
  sound: SOUND_OFF,
  seed: "",
  seedMode: SEED_RANDOM,
  keyBindings: [],
  leftHanded: false,
  gameMode: GAME_MODE_CLASSIC,
};
export const SEED_CUSTOM = "custom";
/** Maximum character length for user-entered seeds. */
export const MAX_SEED_LENGTH = 9;

/** Get player color with safe modulo wrapping. */
export function getPlayerColor(playerId: ValidPlayerSlot): PlayerColor {
  return PLAYER_COLORS[playerId % PLAYER_COLORS.length]!;
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
        sound: saved.sound ?? DEFAULT_SETTINGS.sound,
        seed: saved.seed ?? DEFAULT_SETTINGS.seed,
        seedMode: saved.seedMode === SEED_CUSTOM ? SEED_CUSTOM : SEED_RANDOM,
        leftHanded: saved.leftHanded ?? DEFAULT_SETTINGS.leftHanded,
        gameMode:
          saved.gameMode === GAME_MODE_MODERN
            ? GAME_MODE_MODERN
            : GAME_MODE_CLASSIC,
        keyBindings:
          Array.isArray(saved.keyBindings) &&
          saved.keyBindings.length === MAX_PLAYERS
            ? saved.keyBindings.map((keyBindings) => ({
                ...PLAYER_KEY_BINDINGS[0]!,
                ...keyBindings,
              }))
            : deepCopyBindings(),
      };
    }
  } catch {
    /* ignore corrupt data */
  }
  return { ...DEFAULT_SETTINGS, keyBindings: deepCopyBindings() };
}

export function saveSettings(settings: GameSettings): void {
  try {
    const { seed: _seed, seedMode: _seedMode, ...rest } = settings;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(rest));
  } catch {
    /* storage full or unavailable */
  }
}

if (
  PLAYER_COLORS.length !== PLAYER_NAMES.length ||
  PLAYER_KEY_BINDINGS.length !== PLAYER_NAMES.length
) {
  throw new Error(
    "PLAYER_NAMES / PLAYER_COLORS / PLAYER_KEY_BINDINGS must have the same length",
  );
}

function deepCopyBindings(): KeyBindings[] {
  return PLAYER_KEY_BINDINGS.map((keyBindings) => ({ ...keyBindings }));
}
