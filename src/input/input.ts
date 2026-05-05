/**
 * Shared input types.
 *
 * Pure type definitions consumed by mouse, keyboard, and touch input handlers.
 * No runtime code — avoids circular dependencies between handler modules.
 *
 * ### Mode vs Phase (glossary)
 *
 * **Mode** (`getMode()` / `setMode()`) — UI state set at the app level (`Mode` enum).
 * Values: STOPPED, LOBBY, OPTIONS, GAME, SELECTION, TRANSITION, etc.
 * Controls which input handlers are active and which screen is drawn.
 * Use `isInteractiveMode(mode)` to check if gameplay interaction is allowed.
 *
 * **Phase** (`state.phase`, `Phase` enum) — gameplay state within GAME mode.
 * Values: CASTLE_SELECT, WALL_BUILD, CANNON_PLACE, BATTLE.
 * Controls which game actions are valid and which tick functions run.
 *
 * They are independent: Mode gates top-level input routing; Phase gates
 * game-action semantics. An LLM editing input code should check Mode first,
 * then Phase only when Mode === GAME.
 */

/** Max CSS pixel distance for a touch to count as a tap (not a drag). */

export const TAP_MAX_DIST = 20;
/** Max milliseconds for a touch to count as a tap. */
export const TAP_MAX_TIME = 300;
