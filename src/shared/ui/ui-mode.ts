/** Top-level UI mode — controls which screen/phase main loop renders.
 *
 * Mode.BANNER means "a phase-transition banner is actively on screen".
 * The BANNER-mode ticker advances the banner sweep; input checks gate
 * on BANNER via `isInteractiveMode`. The re-entrancy fence that used
 * to be baked into this mode now lives on `runtimeState.transitionInFlight`
 * — see `runTransition` in `runtime-phase-machine.ts`.
 *
 * Classification table:
 * | Mode          | Gameplay | Interactive |
 * |---------------|----------|-------------|
 * | LOBBY         |          |             |
 * | OPTIONS       |          |             |
 * | CONTROLS      |          |             |
 * | SELECTION     | x        | x           |
 * | BANNER        | x        |             |
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
 *  Use this instead of `mode === Mode.GAME || mode === Mode.SELECTION`.
 *
 *  Note: this does NOT gate on `transitionInFlight` — the unzoom window
 *  before a banner shows leaves the mode on its prior gameplay value
 *  (GAME / SELECTION) but should still block input. Callers that need
 *  that guard must combine this with `!runtimeState.transitionInFlight`
 *  (see `runtime-state.ts` → `FrameContext.isTransition`). */
export function isInteractiveMode(mode: Mode): boolean {
  return mode === Mode.GAME || mode === Mode.SELECTION;
}

/** True if the mode means a phase-transition overlay is on screen
 *  (banner, balloon-anim, castle-build, upgrade-pick). Used by the
 *  frame-context derivation to set `isTransition` for camera / HUD.
 *  Pre-banner unzoom is NOT covered here (the mode is still its prior
 *  gameplay value); `FrameContext.isTransition` also OR's in
 *  `transitionInFlight`. */
export function isBannerMode(mode: Mode): boolean {
  return (
    mode === Mode.BANNER ||
    mode === Mode.BALLOON_ANIM ||
    mode === Mode.CASTLE_BUILD ||
    mode === Mode.UPGRADE_PICK
  );
}
