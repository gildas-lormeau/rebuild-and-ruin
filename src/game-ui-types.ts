/**
 * Shared types, enums, and constants for the game UI.
 * Used by both main.ts (local play) and online-client.ts (online play).
 */

/** Per-player battle stats accumulated during a game. */

import type { GameMap } from "./geometry-types.ts";
import { type KeyBindings, type SeedMode } from "./player-config.ts";

export type { ControlsState } from "./types.ts";
export { createControlsState } from "./types.ts";

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
}

/** Player selection lobby state. */
export interface LobbyState {
  joined: boolean[];
  active: boolean;
  /** Accumulator for lobby countdown timer (local play). */
  timerAccum?: number;
  /** Pre-computed seed for the next game (also used for lobby map preview). */
  seed: number;
  map: GameMap | null;
}

/** CSS class toggled on #game-container to show/hide it. */
export const GAME_CONTAINER_ACTIVE = "active";
/** Custom event dispatched when the router navigates away from the game. */
export const GAME_EXIT_EVENT = "game-exit";
export const DIFFICULTY_LABELS = ["Easy", "Normal", "Hard", "Very Hard"];
export const DIFFICULTY_PARAMS = [
  { buildTimer: 30, cannonPlaceTimer: 20, firstRoundCannons: 4 }, // Easy
  { buildTimer: 25, cannonPlaceTimer: 15, firstRoundCannons: 3 }, // Normal
  { buildTimer: 20, cannonPlaceTimer: 12, firstRoundCannons: 2 }, // Hard
  { buildTimer: 15, cannonPlaceTimer: 10, firstRoundCannons: 1 }, // Very Hard
];
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
export const SOUND_LABELS = ["Off", "Phase changes", "All"];
export const DPAD_LABELS = ["Right-handed", "Left-handed"];
export const OPTION_NAMES = [
  "Difficulty",
  "Rounds",
  "Cannon Kill",
  "Haptics",
  "Seed",
  "Controls",
  "D-Pad",
  "Sound",
];
