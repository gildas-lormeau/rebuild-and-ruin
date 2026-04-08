/**
 * Phase-tick facade — explicit contract boundary between game/ and runtime/
 * for the phase-ticks subsystem (battle, cannon, build phase ticking).
 *
 * Runtime subsystems import this single facade instead of reaching into
 * individual game/ files.
 */

import {
  advanceBattleCountdown,
  createCannonFiredMsg,
  nextReadyCombined,
  resolveBalloons,
  snapshotTerritory,
  tickCannonballs,
} from "./battle-system.ts";
import {
  buildTimerMax,
  diffNewWalls,
  snapshotThenFinalize,
  tickMasterBuilderLockout,
} from "./build-phase-helpers.ts";
import {
  applyDefaultFacings,
  prepareCannonPhase,
  prepareControllerCannonPhase,
  resetCannonFacings,
} from "./cannon-system.ts";
import { localFire, localPlacePiece } from "./game-actions.ts";
import { isCeasefireActive, nextPhase } from "./game-engine.ts";
import { tickGrunts } from "./grunt-movement.ts";
import { gruntAttackTowers, tickBreachSpawnQueue } from "./grunt-system.ts";
import {
  BANNER_BATTLE,
  BANNER_BUILD,
  capturePrevBattleScene,
} from "./phase-banner.ts";
import {
  computeScoreDeltas,
  enterBattleFromCannon,
  enterBuildSkippingBattle,
  finalizeBuildPhase,
} from "./phase-setup.ts";

export const phaseTickFacade = {
  createCannonFiredMsg,
  nextReadyCombined,
  resolveBalloons,
  snapshotTerritory,
  tickCannonballs,
  applyDefaultFacings,
  resetCannonFacings,
  isCeasefireActive,
  localFire,
  localPlacePiece,
  nextPhase,
  tickGrunts,
  gruntAttackTowers,
  tickBreachSpawnQueue,
  advanceBattleCountdown,
  enterBattleFromCannon,
  enterBuildSkippingBattle,
  buildTimerMax,
  diffNewWalls,
  snapshotThenFinalize,
  tickMasterBuilderLockout,
  BANNER_BATTLE,
  BANNER_BUILD,
  capturePrevBattleScene,
  computeScoreDeltas,
  finalizeBuildPhase,
  prepareControllerCannonPhase,
  prepareCannonPhase,
};
