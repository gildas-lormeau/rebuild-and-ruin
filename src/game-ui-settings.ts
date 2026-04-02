/**
 * Settings persistence and option mutation helpers.
 * Extracted from game-ui-types.ts to keep that file pure types/constants.
 */

import { GAME_MODE_CLASSIC, GAME_MODE_MODERN } from "./game-constants.ts";
import {
  CANNON_HP_OPTIONS,
  DIFFICULTY_LABELS,
  HAPTICS_LABELS,
  ROUNDS_OPTIONS,
  SOUND_LABELS,
} from "./game-ui-types.ts";
import type { GameSettings } from "./player-config.ts";
import {
  KEY_DOWN,
  KEY_LEFT,
  KEY_RIGHT,
  KEY_UP,
  type KeyBindings,
  MAX_PLAYERS,
  PLAYER_KEY_BINDINGS,
  SEED_CUSTOM,
  SEED_RANDOM,
} from "./player-config.ts";

const SETTINGS_KEY = "castles99_settings";
const DEFAULT_SETTINGS: GameSettings = {
  difficulty: 1,
  rounds: 4,
  cannonHp: 0,
  haptics: 2, // default: all
  sound: 0, // default: off (experimental)
  seed: "",
  seedMode: SEED_RANDOM,
  keyBindings: [],
  leftHanded: false,
  gameMode: GAME_MODE_CLASSIC,
};

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

export function formatKeyName(key: string): string {
  if (key === KEY_UP) return "\u2191";
  if (key === KEY_DOWN) return "\u2193";
  if (key === KEY_LEFT) return "\u2190";
  if (key === KEY_RIGHT) return "\u2192";
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

export function cycleOption(
  dir: number,
  optionsCursor: number,
  settings: GameSettings,
  optionsReturnMode: unknown,
  state: { round: number; maxRounds: number } | null,
  isOnline?: boolean,
): void {
  if (optionsCursor === 0) {
    if (optionsReturnMode !== null) return; // locked in-game
    settings.difficulty =
      (settings.difficulty + dir + DIFFICULTY_LABELS.length) %
      DIFFICULTY_LABELS.length;
  } else if (optionsCursor === 1) {
    if (isOnline) return; // set by room host
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
      state.maxRounds = val > 0 ? val : Infinity;
    }
  } else if (optionsCursor === 2) {
    if (optionsReturnMode !== null || isOnline) return; // locked in-game and online
    settings.cannonHp =
      (settings.cannonHp + dir + CANNON_HP_OPTIONS.length) %
      CANNON_HP_OPTIONS.length;
  } else if (optionsCursor === 3) {
    settings.haptics =
      (settings.haptics + dir + HAPTICS_LABELS.length) % HAPTICS_LABELS.length;
  } else if (optionsCursor === 6) {
    settings.leftHanded = !settings.leftHanded;
  } else if (optionsCursor === 7) {
    settings.sound =
      (settings.sound + dir + SOUND_LABELS.length) % SOUND_LABELS.length;
  } else if (optionsCursor === 8) {
    if (optionsReturnMode !== null || isOnline) return; // locked in-game and online
    settings.gameMode =
      settings.gameMode === GAME_MODE_MODERN
        ? GAME_MODE_CLASSIC
        : GAME_MODE_MODERN;
  }
  // optionsCursor === 4 (Seed) — handled via direct keyboard input in options handler
  // optionsCursor === 5 (Controls) — no left/right value, opened via confirm
}

function deepCopyBindings(): KeyBindings[] {
  return PLAYER_KEY_BINDINGS.map((kb) => ({ ...kb }));
}
