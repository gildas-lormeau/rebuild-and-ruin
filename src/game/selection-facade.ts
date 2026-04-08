/**
 * Selection facade — explicit contract boundary between game/ and runtime/
 * for the selection subsystem (tower selection, castle building, reselection).
 *
 * Runtime subsystems import this single facade instead of reaching into
 * individual game/ files.
 */

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
import { snapshotEntities } from "./phase-banner.ts";
import {
  completeReselection,
  prepareCastleWallsForPlayer,
  processReselectionQueue,
} from "./phase-setup.ts";
import {
  allSelectionsConfirmed,
  confirmTowerSelection,
  finishSelectionPhase,
  highlightTowerSelection,
  initTowerSelection,
  tickSelectionPhase,
} from "./selection.ts";

export const selectionFacade = {
  recheckTerritoryOnly,
  createCastleBuildState,
  tickCastleBuildAnimation,
  enterCannonPlacePhase,
  enterCastleReselectPhase,
  finalizeAndEnterCannonPhase,
  markPlayerReselected,
  snapshotEntities,
  completeReselection,
  prepareCastleWallsForPlayer,
  processReselectionQueue,
  allSelectionsConfirmed,
  confirmTowerSelection,
  finishSelectionPhase,
  highlightTowerSelection,
  initTowerSelection,
  tickSelectionPhase,
};
