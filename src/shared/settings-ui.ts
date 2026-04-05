/**
 * Option mutation helpers for the settings UI.
 * Settings persistence (load/save) lives in player-config.ts alongside GameSettings.
 */

import { GAME_MODE_CLASSIC, GAME_MODE_MODERN } from "./game-constants";
import { KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_UP } from "./platform";
import { type GameSettings } from "./player-config";
import {
  CANNON_HP_OPTIONS,
  DIFFICULTY_LABELS,
  HAPTICS_LABELS,
  OPT_CANNON_HP,
  OPT_DIFFICULTY,
  OPT_DPAD,
  OPT_GAME_MODE,
  OPT_HAPTICS,
  OPT_ROUNDS,
  OPT_SOUND,
  ROUNDS_OPTIONS,
  SOUND_LABELS,
} from "./settings-defs";

export type CycleOptionFn = (
  dir: number,
  optionsCursor: number,
  settings: GameSettings,
  optionsReturnMode: unknown,
  state: { round: number; maxRounds: number } | null,
  isOnline?: boolean,
) => void;

export function formatKeyName(key: string): string {
  if (key === KEY_UP) return "\u2191";
  if (key === KEY_DOWN) return "\u2193";
  if (key === KEY_LEFT) return "\u2190";
  if (key === KEY_RIGHT) return "\u2192";
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** Cycle a settings option value left/right.
 *  @param optionsReturnMode — null = lobby (editable), non-null = in-game (read-only for some options). */
export function cycleOption(
  dir: number,
  optionsCursor: number,
  settings: GameSettings,
  optionsReturnMode: unknown,
  state: { round: number; maxRounds: number } | null,
  isOnline?: boolean,
): void {
  if (optionsCursor === OPT_DIFFICULTY) {
    if (optionsReturnMode !== null) return; // locked in-game
    settings.difficulty =
      (settings.difficulty + dir + DIFFICULTY_LABELS.length) %
      DIFFICULTY_LABELS.length;
  } else if (optionsCursor === OPT_ROUNDS) {
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
  } else if (optionsCursor === OPT_CANNON_HP) {
    if (optionsReturnMode !== null || isOnline) return; // locked in-game and online
    settings.cannonHp =
      (settings.cannonHp + dir + CANNON_HP_OPTIONS.length) %
      CANNON_HP_OPTIONS.length;
  } else if (optionsCursor === OPT_HAPTICS) {
    settings.haptics =
      (settings.haptics + dir + HAPTICS_LABELS.length) % HAPTICS_LABELS.length;
  } else if (optionsCursor === OPT_DPAD) {
    settings.leftHanded = !settings.leftHanded;
  } else if (optionsCursor === OPT_SOUND) {
    settings.sound =
      (settings.sound + dir + SOUND_LABELS.length) % SOUND_LABELS.length;
  } else if (optionsCursor === OPT_GAME_MODE) {
    if (optionsReturnMode !== null || isOnline) return; // locked in-game and online
    settings.gameMode =
      settings.gameMode === GAME_MODE_MODERN
        ? GAME_MODE_CLASSIC
        : GAME_MODE_MODERN;
  }
  // optionsCursor === 4 (Seed) — handled via direct keyboard input in options handler
  // optionsCursor === 5 (Controls) — no left/right value, opened via confirm
}
