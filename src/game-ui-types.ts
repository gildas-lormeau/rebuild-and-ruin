/**
 * UI-only labels and option arrays for the settings screens.
 * Used by game-ui-screens.ts and game-ui-settings.ts.
 */

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
export const SOUND_LABELS = ["Off", "Phase changes", "All"];
export const DPAD_LABELS = ["Right-handed", "Left-handed"];
export const GAME_MODE_LABELS = ["Classic", "Modern"];
export const OPTION_NAMES = [
  "Difficulty",
  "Rounds",
  "Cannon Kill",
  "Haptics",
  "Seed",
  "Controls",
  "D-Pad",
  "Sound",
  "Game Mode",
];
