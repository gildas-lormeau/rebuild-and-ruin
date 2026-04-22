/** Top-level UI mode — controls which screen/phase main loop renders.
 *
 * Mode.TRANSITION means "no gameplay tick, no player input" — used by
 * the phase-transition machine as a re-entrancy fence (so the caller
 * that dispatched us can't redispatch on its next sub-step) and an
 * input gate (so the user can't interact with the new phase during
 * the unzoom lerp before the banner appears). Its ticker advances the
 * banner sweep when one is live and otherwise just renders.
 *
 * Classification table:
 * | Mode          | Gameplay | Interactive | Transition |
 * |---------------|----------|-------------|------------|
 * | LOBBY         |          |             |            |
 * | OPTIONS       |          |             |            |
 * | CONTROLS      |          |             |            |
 * | SELECTION     | x        | x           |            |
 * | TRANSITION    | x        |             | x          |
 * | BALLOON_ANIM  | x        |             | x          |
 * | CASTLE_BUILD  | x        |             | x          |
 * | LIFE_LOST     | x        |             |            |
 * | UPGRADE_PICK  | x        |             | x          |
 * | GAME          | x        | x           |            |
 * | STOPPED       |          |             |            |
 */

export enum Mode {
  LOBBY,
  OPTIONS,
  CONTROLS,
  SELECTION,
  TRANSITION,
  BALLOON_ANIM,
  CASTLE_BUILD,
  LIFE_LOST,
  UPGRADE_PICK,
  GAME,
  STOPPED,
}

/** Mode represents an in-game screen that should be paused/ticked (not lobby/options/stopped).
 *  Use this instead of negated multi-mode checks. */
export function isGameplayMode(mode: Mode): boolean {
  return (
    mode !== Mode.LOBBY &&
    mode !== Mode.OPTIONS &&
    mode !== Mode.CONTROLS &&
    mode !== Mode.STOPPED
  );
}

/** Mode allows direct gameplay interaction (active game or tower selection).
 *  Use this instead of `mode === Mode.GAME || mode === Mode.SELECTION`. */
export function isInteractiveMode(mode: Mode): boolean {
  return mode === Mode.GAME || mode === Mode.SELECTION;
}

/** True if the mode is a non-interactive transition (phase-transition banner,
 *  balloon anim, castle build, upgrade pick). */
export function isTransitionMode(mode: Mode): boolean {
  return (
    mode === Mode.TRANSITION ||
    mode === Mode.BALLOON_ANIM ||
    mode === Mode.CASTLE_BUILD ||
    mode === Mode.UPGRADE_PICK
  );
}
