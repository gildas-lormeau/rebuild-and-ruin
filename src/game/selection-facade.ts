/**
 * Selection facade — explicit contract boundary between game/ and runtime/
 * for the selection subsystem (tower selection, castle building, reselection).
 *
 * Runtime subsystems import this single facade instead of reaching into
 * individual game/ files.
 */

import type { EntityOverlay } from "../shared/overlay-types.ts";
import type { GameState } from "../shared/types.ts";
import { recheckTerritoryOnly } from "./build-system.ts";
import {
  createCastleBuildState,
  tickCastleBuildAnimation,
} from "./castle-build.ts";
import {
  enterCannonPlacePhase,
  enterCastleReselectPhase,
  finalizeAndEnterCannonPhase,
  markPlayerReselected,
} from "./game-engine.ts";
import { BANNER_SELECT, snapshotEntities } from "./phase-banner.ts";
import {
  finalizeReselectedPlayers,
  prepareCastleWallsForPlayer,
  processReselectionQueue,
} from "./phase-setup.ts";
import {
  allPlayersHaveTerritory,
  allSelectionsConfirmed,
  confirmTowerSelection,
  finishSelectionPhase,
  highlightTowerSelection,
  initSelectionTimer,
  initTowerSelection,
} from "./selection.ts";

export const selectionFacade = {
  BANNER_SELECT,
  allPlayersHaveTerritory,
  initSelectionTimer,
  recheckTerritoryOnly,
  createCastleBuildState,
  tickCastleBuildAnimation,
  enterCannonPlacePhase,
  enterCastleReselectPhase,
  snapshotAndFinalizeForCannonPhase,
  markPlayerReselected,
  finalizeReselectedPlayers,
  prepareCastleWallsForPlayer,
  processReselectionQueue,
  allSelectionsConfirmed,
  confirmTowerSelection,
  finishSelectionPhase,
  highlightTowerSelection,
  initTowerSelection,
};

/** Snapshot entities THEN finalize castle construction and enter cannon phase.
 *  Ordering invariant: snapshot must capture state BEFORE finalize mutates it.
 *  Combined here so callers cannot accidentally reverse the steps. */
function snapshotAndFinalizeForCannonPhase(state: GameState): EntityOverlay {
  const entities = snapshotEntities(state);
  finalizeAndEnterCannonPhase(state);
  return entities;
}
