export enum Phase {
  /** Castle selection — players pick (or rebuild) their home tower. Used
   *  for both round 1's initial selection (every active player) and any
   *  mid-game reselect cycle (round > 1, only the players who lost a life).
   *  Consumers that need to distinguish the two cycles read `state.round`. */
  CASTLE_SELECT = "CASTLE_SELECT",
  WALL_BUILD = "WALL_BUILD",
  CANNON_PLACE = "CANNON_PLACE",
  /** Transient display phase: modern-mode modifier banner announces the
   *  rolled environmental effect (wildfire / frozen river / etc.) between
   *  CANNON_PLACE and BATTLE. Non-interactive; transitions drive
   *  themselves. Reached only when a modifier was actually rolled. */
  MODIFIER_REVEAL = "MODIFIER_REVEAL",
  BATTLE = "BATTLE",
  /** Transient display phase: modern-mode upgrade-draft dialog sits between
   *  BATTLE end (or CEASEFIRE) and WALL_BUILD. Players pick one offer
   *  each; once all have resolved the machine flips to WALL_BUILD.
   *  Reached only when `pendingUpgradeOffers` is populated. */
  UPGRADE_PICK = "UPGRADE_PICK",
  /** Round-close window: WALL_BUILD's timer expired and the round is
   *  finalizing. Self-driving like UPGRADE_PICK — `tickRoundEndPhase`
   *  drives the two display beats (score overlay in Mode.TRANSITION, then
   *  the life-lost dialog in Mode.LIFE_LOST) and dispatches the exit
   *  (game-over / reselect / advance-to-cannon) re-derived from state, so
   *  a host-promoted peer resumes without a repair hatch. `finalizeRound`
   *  already ran when this phase was entered (from `tickBuildPhase` at
   *  `timer <= 0`); the round number stays at the closing value through
   *  the whole window (advance is deferred to the exit). */
  ROUND_END = "ROUND_END",
}

/** True if the phase is castle selection (initial or reselect). */
export function isSelectionPhase(phase: Phase): boolean {
  return phase === Phase.CASTLE_SELECT;
}

/** True if the phase has a countdown timer (placement phases + battle). */
export function isTimedPhase(phase: Phase): boolean {
  return isPlacementPhase(phase) || phase === Phase.BATTLE;
}

/** True if the phase is a placement phase (walls or cannons). */
export function isPlacementPhase(phase: Phase): boolean {
  return phase === Phase.WALL_BUILD || phase === Phase.CANNON_PLACE;
}
