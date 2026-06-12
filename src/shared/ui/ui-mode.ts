/** Top-level UI mode — which screen/phase the main loop renders.
 *  Gameplay (ticks): SELECTION, TRANSITION, BALLOON_ANIM,
 *  LIFE_LOST, UPGRADE_PICK, GAME. Interactive: SELECTION, GAME only.
 *  TRANSITION = "a phase transition is in flight" (held from pre-banner
 *  unzoom through postDisplay). Banner visibility is tracked separately
 *  via `banner !== null` (authoritative). See `isGameplayMode` /
 *  `isInteractiveMode` / `isTransitionMode` predicates below. */

export enum Mode {
  LOBBY,
  OPTIONS,
  CONTROLS,
  SELECTION,
  TRANSITION,
  BALLOON_ANIM,
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
 *  Use this instead of `mode === Mode.GAME || mode === Mode.SELECTION`.
 *  TRANSITION is NOT interactive — the mode itself reflects that
 *  a transition is in flight, no external boolean needed. */
export function isInteractiveMode(mode: Mode): boolean {
  return mode === Mode.GAME || mode === Mode.SELECTION;
}

/** True when a phase transition is in flight (unzoom window + banner chain)
 *  or a subsystem dialog / balloon-anim overlay is on screen. Drives
 *  `FrameContext.isTransition` for camera / HUD gating. */
export function isTransitionMode(mode: Mode): boolean {
  return (
    mode === Mode.TRANSITION ||
    mode === Mode.BALLOON_ANIM ||
    mode === Mode.UPGRADE_PICK
  );
}
