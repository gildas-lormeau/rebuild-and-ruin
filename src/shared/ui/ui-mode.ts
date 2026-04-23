/** Top-level UI mode — controls which screen/phase main loop renders.
 *
 * `Mode.TRANSITION` means "a phase transition is in flight" — set at
 * `runTransition` entry during the pre-banner unzoom and held through
 * every banner/display step until postDisplay flips to the terminal mode.
 * Banner visibility is tracked separately via `banner.status` (authoritative).
 *
 * Classification table:
 * | Mode          | Gameplay | Interactive |
 * |---------------|----------|-------------|
 * | LOBBY         |          |             |
 * | OPTIONS       |          |             |
 * | CONTROLS      |          |             |
 * | SELECTION     | x        | x           |
 * | TRANSITION    | x        |             |
 * | BALLOON_ANIM  | x        |             |
 * | CASTLE_BUILD  | x        |             |
 * | LIFE_LOST     | x        |             |
 * | UPGRADE_PICK  | x        |             |
 * | GAME          | x        | x           |
 * | STOPPED       |          |             |
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
    mode === Mode.CASTLE_BUILD ||
    mode === Mode.UPGRADE_PICK
  );
}
