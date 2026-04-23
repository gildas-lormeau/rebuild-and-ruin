export enum Phase {
  CASTLE_SELECT = "CASTLE_SELECT",
  CASTLE_RESELECT = "CASTLE_RESELECT",
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
}

/** True if the phase is castle selection (initial or reselect). */
export function isSelectionPhase(phase: Phase): boolean {
  return phase === Phase.CASTLE_SELECT || phase === Phase.CASTLE_RESELECT;
}

/** True if the phase is castle reselection specifically (not initial selection). */
export function isReselectPhase(phase: Phase): boolean {
  return phase === Phase.CASTLE_RESELECT;
}

/** True if the phase has a countdown timer (placement phases + battle). */
export function isTimedPhase(phase: Phase): boolean {
  return isPlacementPhase(phase) || phase === Phase.BATTLE;
}

/** True if the phase is a placement phase (walls or cannons). */
export function isPlacementPhase(phase: Phase): boolean {
  return phase === Phase.WALL_BUILD || phase === Phase.CANNON_PLACE;
}
