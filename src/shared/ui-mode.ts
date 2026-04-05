/** Top-level UI mode — controls which screen/phase main loop renders. */

export enum Mode {
  LOBBY,
  OPTIONS,
  CONTROLS,
  SELECTION,
  BANNER,
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

/** True if the mode is a non-interactive transition (banner, balloon anim, castle build, upgrade pick). */
export function isTransitionMode(mode: Mode): boolean {
  return (
    mode === Mode.BANNER ||
    mode === Mode.BALLOON_ANIM ||
    mode === Mode.CASTLE_BUILD ||
    mode === Mode.UPGRADE_PICK
  );
}
