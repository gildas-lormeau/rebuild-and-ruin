export enum Phase {
  CASTLE_SELECT = "CASTLE_SELECT",
  CASTLE_RESELECT = "CASTLE_RESELECT",
  WALL_BUILD = "WALL_BUILD",
  CANNON_PLACE = "CANNON_PLACE",
  BATTLE = "BATTLE",
}

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

/** Input action names returned by matchKey / used in key dispatch.
 *  ROTATE is context-dependent: rotates piece in WALL_BUILD,
 *  cycles cannon mode in CANNON_PLACE, and sprints crosshair in BATTLE. */
export enum Action {
  UP = "up",
  DOWN = "down",
  LEFT = "left",
  RIGHT = "right",
  CONFIRM = "confirm",
  /** Rotate piece (build), cycle cannon mode (cannon), sprint crosshair (battle). */
  ROTATE = "rotate",
}

/** True if the phase is castle selection (initial or reselect). */
export function isSelectionPhase(phase: Phase): boolean {
  return phase === Phase.CASTLE_SELECT || phase === Phase.CASTLE_RESELECT;
}

/** True if the phase is castle reselection specifically (not initial selection). */
export function isReselectPhase(phase: Phase): boolean {
  return phase === Phase.CASTLE_RESELECT;
}

/** True if the phase is a placement phase (walls or cannons). */
export function isPlacementPhase(phase: Phase): boolean {
  return phase === Phase.WALL_BUILD || phase === Phase.CANNON_PLACE;
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

/** True if the mode is a non-interactive transition (banner, balloon anim, castle build). */
export function isTransitionMode(mode: Mode): boolean {
  return (
    mode === Mode.BANNER ||
    mode === Mode.BALLOON_ANIM ||
    mode === Mode.CASTLE_BUILD
  );
}
