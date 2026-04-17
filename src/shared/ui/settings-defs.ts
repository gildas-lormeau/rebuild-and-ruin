/**
 * Settings option labels, arrays, and index constants.
 */

/** Display labels for difficulty levels. Index must match DIFFICULTY_* constants
 *  in game-constants.ts: 0=Easy, 1=Normal, 2=Hard, 3=Very Hard.
 *  Length must equal DIFFICULTY_PARAMS.length in game-constants.ts. */

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
  "Game Mode",
];
/** Option indices — positions in the OPTION_NAMES / visible-options arrays.
 *  INVARIANT: Indices must match the order in OPTION_NAMES above. */
export const OPT_DIFFICULTY = 0;
export const OPT_ROUNDS = 1;
export const OPT_CANNON_HP = 2;
export const OPT_HAPTICS = 3;
export const OPT_SEED = 4;
export const OPT_CONTROLS = 5;
export const OPT_DPAD = 6;
export const OPT_GAME_MODE = 7;
/** Hit-test discriminators for options/controls screens.
 *  Shared between render (producer) and runtime (consumer). */
export const HIT_CLOSE = "close";
export const HIT_ARROW = "arrow";
