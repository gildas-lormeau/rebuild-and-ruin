/**
 * Shared input types — consumed by mouse, keyboard, and touch handlers.
 * Mode (`Mode` enum, app-level UI: LOBBY/OPTIONS/GAME/...) gates top-level
 * input routing; Phase (`state.phase`, gameplay state inside GAME) gates
 * game-action semantics. Check Mode first, Phase only when Mode === GAME.
 */

/** Max CSS pixel distance for a touch to count as a tap (not a drag). */

export const TAP_MAX_DIST = 20;
/** Max milliseconds for a touch to count as a tap. */
export const TAP_MAX_TIME = 300;
