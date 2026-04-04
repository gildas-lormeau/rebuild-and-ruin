/**
 * Shared player-facing configuration.
 *
 * Keep player names, colors, and bindings in one place so they cannot drift.
 */

import {
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
  type GameMode,
  type PlayerSlotId,
  type ValidPlayerSlot,
} from "./game-constants.ts";
import type { RGB } from "./geometry-types.ts";

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

export type SeedMode = typeof SEED_RANDOM | typeof SEED_CUSTOM;

export interface GameSettings {
  difficulty: number;
  rounds: number;
  cannonHp: number;
  haptics: number; // 0=off, 1=phase changes only, 2=all
  sound: number; // 0=off, 1=phase changes only, 2=all
  seed: string;
  seedMode: SeedMode;
  keyBindings: KeyBindings[];
  leftHanded: boolean; // true = d-pad on right, action buttons on left
  gameMode: GameMode;
}

export interface AutoResolveDeps {
  readonly hostAtFrameStart: boolean;
  readonly myPlayerId: PlayerSlotId;
  readonly remoteHumanSlots: ReadonlySet<number>;
  readonly isHumanController: (playerId: ValidPlayerSlot) => boolean;
}

const SOUND_OFF = 0;
/** Index into ROUNDS_OPTIONS (not the value itself — value is 0 = infinite). */
const ROUNDS_TO_THE_DEATH_INDEX = 4;
/** Index into CANNON_HP_OPTIONS (not the HP value itself — value is 3 hits). */
const CANNON_HP_DEFAULT_INDEX = 0;
const SETTINGS_KEY = "castles99_settings";
export const KEY_UP = "ArrowUp";
export const KEY_DOWN = "ArrowDown";
export const KEY_LEFT = "ArrowLeft";
export const KEY_RIGHT = "ArrowRight";
export const KEY_ENTER = "Enter";
export const KEY_ESCAPE = "Escape";
/** Indices into DIFFICULTY_PARAMS — not difficulty values, but array positions. */
export const DIFFICULTY_EASY = 0;
export const DIFFICULTY_NORMAL = 1;
export const DIFFICULTY_HARD = 2;
export const DIFFICULTY_VERY_HARD = 3;
export const DIFFICULTY_PARAMS = [
  { buildTimer: 30, cannonPlaceTimer: 20, firstRoundCannons: 4 }, // DIFFICULTY_EASY
  { buildTimer: 25, cannonPlaceTimer: 15, firstRoundCannons: 3 }, // DIFFICULTY_NORMAL
  { buildTimer: 20, cannonPlaceTimer: 12, firstRoundCannons: 2 }, // DIFFICULTY_HARD
  { buildTimer: 15, cannonPlaceTimer: 10, firstRoundCannons: 1 }, // DIFFICULTY_VERY_HARD
];
/** Haptics/sound level encoding shared across settings UI and subsystems.
 *  0=off (implicit — handled by >= checks), 1=phase changes only, 2=all. */
export const HAPTICS_PHASE_ONLY = 1;
export const HAPTICS_ALL = 2;
export const SOUND_PHASE_ONLY = 1;
export const SOUND_ALL = 2;
export const PLAYER_NAMES = ["Red", "Blue", "Gold"] as const;
// Player castle colors: wall and interior (checkerboard light/dark)
export const PLAYER_COLORS: readonly PlayerColor[] = [
  {
    wall: [150, 110, 110],
    interiorLight: [170, 30, 30],
    interiorDark: [50, 10, 10],
  }, // Red (stone-tinted)
  {
    wall: [100, 105, 140],
    interiorLight: [30, 50, 170],
    interiorDark: [10, 15, 50],
  }, // Blue (stone-tinted)
  {
    wall: [170, 145, 90],
    interiorLight: [190, 130, 20],
    interiorDark: [55, 40, 10],
  }, // Orange/Gold (stone-tinted)
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
/** Ordered action keys for the controls screen (matches KeyBindings fields). */
export const ACTION_CONFIRM = "confirm" as const;
export const ACTION_KEYS: readonly (keyof KeyBindings)[] = [
  "up",
  "down",
  "left",
  "right",
  ACTION_CONFIRM,
  "rotate",
];
export const SEED_RANDOM = "random" as const;
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
export const SEED_CUSTOM = "custom" as const;
/** Maximum character length for user-entered seeds. */
export const MAX_SEED_LENGTH = 9;

/** Get player color with safe modulo wrapping. */
export function getPlayerColor(playerId: ValidPlayerSlot): PlayerColor {
  return PLAYER_COLORS[playerId % PLAYER_COLORS.length]!;
}

/** Apply a key rebinding with conflict resolution (swap conflicting key). */
export function applyKeyRebinding(
  kb: KeyBindings,
  actionKey: string,
  newKey: string,
): void {
  for (const otherAction of ACTION_KEYS) {
    if (otherAction === actionKey) continue;
    if (kb[otherAction as keyof KeyBindings] === newKey) {
      (kb as unknown as Record<string, string>)[otherAction] =
        kb[actionKey as keyof KeyBindings];
      break;
    }
  }
  (kb as unknown as Record<string, string>)[actionKey] = newKey;
}

/** Format a key binding as a short hint string (e.g. "Arrows + N (B rotate)"). */
export function formatKeyHint(kb: KeyBindings): string {
  const arrows =
    kb.up === KEY_UP
      ? "Arrows"
      : kb.up.toUpperCase() +
        kb.left.toUpperCase() +
        kb.down.toUpperCase() +
        kb.right.toUpperCase();
  return `${arrows} + ${kb.confirm.toUpperCase()} (${kb.rotate.toUpperCase()} rotate)`;
}

/** Build a map from confirm key → player slot index for lobby joining. */
export function createLobbyConfirmKeys(
  keyBindings: readonly KeyBindings[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < keyBindings.length; i++) {
    const kb = keyBindings[i]!;
    map.set(kb.confirm, i);
    map.set(kb.confirm.toUpperCase(), i);
  }
  return map;
}

/** True when this player's dialog entry should auto-resolve (no local input needed).
 *  Host checks controller identity; non-host only resolves its own slot. */
export function shouldAutoResolve(
  playerId: ValidPlayerSlot,
  deps: AutoResolveDeps,
): boolean {
  return deps.hostAtFrameStart
    ? !deps.isHumanController(playerId) && !deps.remoteHumanSlots.has(playerId)
    : playerId !== deps.myPlayerId;
}

/** Compute the game seed from current settings (custom seed or random). */
export function computeGameSeed(settings: GameSettings): number {
  if (settings.seedMode === SEED_CUSTOM && settings.seed) {
    const parsed = parseInt(settings.seed, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return Math.floor(Math.random() * 1000000);
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
            ? saved.keyBindings.map((kb) => ({
                ...PLAYER_KEY_BINDINGS[0]!,
                ...kb,
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
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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
  return PLAYER_KEY_BINDINGS.map((kb) => ({ ...kb }));
}
