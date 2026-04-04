/**
 * Settings option labels, arrays, and index constants.
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
  "Cannon HP",
  "Haptics",
  "Seed",
  "Controls",
  "D-Pad",
  "Sound",
  "Game Mode",
];
/** Option indices — positions in the OPTION_NAMES / visible-options arrays. */
export const OPT_DIFFICULTY = 0;
export const OPT_ROUNDS = 1;
export const OPT_CANNON_HP = 2;
export const OPT_HAPTICS = 3;
export const OPT_SEED = 4;
export const OPT_CONTROLS = 5;
export const OPT_DPAD = 6;
export const OPT_SOUND = 7;
export const OPT_GAME_MODE = 8;
