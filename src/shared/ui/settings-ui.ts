/**
 * Option mutation helpers for the settings UI.
 * Settings persistence (load/save) lives in player-config.ts alongside GameSettings.
 */

import { GAME_MODE_CLASSIC, GAME_MODE_MODERN } from "../core/game-constants.ts";
import { wrapIndex } from "../platform/cyclic.ts";
import { KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_UP } from "../platform/platform.ts";
import type { OptionsContext } from "./interaction-types.ts";
import { type GameSettings } from "./player-config.ts";
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
  ROUNDS_OPTIONS,
} from "./settings-defs.ts";

export type CycleOptionFn = (
  dir: number,
  optionsCursor: number,
  settings: GameSettings,
  optionsContext: OptionsContext,
  state: { round: number; maxRounds: number } | null,
  isOnline?: boolean,
) => void;

export function formatKeyName(key: string): string {
  switch (key) {
    case KEY_UP:
      return "\u2191";
    case KEY_DOWN:
      return "\u2193";
    case KEY_LEFT:
      return "\u2190";
    case KEY_RIGHT:
      return "\u2192";
    case " ":
      return "Space";
  }
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** Cycle a settings option value left/right. Some rows are locked when the
 *  options screen was opened during gameplay (`optionsContext.kind === "gameplay"`). */
export function cycleOption(
  dir: number,
  optionsCursor: number,
  settings: GameSettings,
  optionsContext: OptionsContext,
  state: { round: number; maxRounds: number } | null,
  isOnline?: boolean,
): void {
  const inGame = optionsContext.kind === "gameplay";
  if (optionsCursor === OPT_DIFFICULTY) {
    if (inGame) return; // locked in-game
    settings.difficulty = wrapIndex(
      settings.difficulty,
      dir,
      DIFFICULTY_LABELS.length,
    );
  } else if (optionsCursor === OPT_ROUNDS) {
    if (isOnline) return; // set by room host
    let next = wrapIndex(settings.rounds, dir, ROUNDS_OPTIONS.length);
    // In-game: only allow values >= current round (so players can shorten, not extend past current)
    if (inGame && state) {
      const minRound = state.round;
      // Skip options whose value is > 0 (not "To The Death") and < current round
      for (let attempts = 0; attempts < ROUNDS_OPTIONS.length; attempts++) {
        const val = ROUNDS_OPTIONS[next]!.value;
        if (val === 0 || val >= minRound) break; // 0 = "To The Death" is always valid
        next = wrapIndex(next, dir, ROUNDS_OPTIONS.length);
      }
    }
    settings.rounds = next;
    // Apply immediately to the live game
    if (inGame && state) {
      const val = ROUNDS_OPTIONS[settings.rounds]!.value;
      state.maxRounds = val > 0 ? val : Infinity;
    }
  } else if (optionsCursor === OPT_CANNON_HP) {
    if (inGame || isOnline) return; // locked in-game and online
    settings.cannonHp = wrapIndex(
      settings.cannonHp,
      dir,
      CANNON_HP_OPTIONS.length,
    );
  } else if (optionsCursor === OPT_HAPTICS) {
    settings.haptics = wrapIndex(settings.haptics, dir, HAPTICS_LABELS.length);
  } else if (optionsCursor === OPT_DPAD) {
    settings.leftHanded = !settings.leftHanded;
  } else if (optionsCursor === OPT_GAME_MODE) {
    if (inGame || isOnline) return; // locked in-game and online
    settings.gameMode =
      settings.gameMode === GAME_MODE_MODERN
        ? GAME_MODE_CLASSIC
        : GAME_MODE_MODERN;
  }
  // optionsCursor === 4 (Seed) — handled via direct keyboard input in options handler
  // optionsCursor === 5 (Controls) — no left/right value, opened via confirm
}
