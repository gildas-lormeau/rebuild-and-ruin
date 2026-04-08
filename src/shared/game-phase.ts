export enum Phase {
  CASTLE_SELECT = "CASTLE_SELECT",
  CASTLE_RESELECT = "CASTLE_RESELECT",
  WALL_BUILD = "WALL_BUILD",
  CANNON_PLACE = "CANNON_PLACE",
  BATTLE = "BATTLE",
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
