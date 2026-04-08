/**
 * Phase-tick facade — explicit contract boundary between game/ and runtime/
 * for the phase-ticks subsystem (battle, cannon, build phase ticking).
 *
 * Runtime subsystems import this single facade instead of reaching into
 * individual game/ files.
 */

import { clearImpacts } from "../shared/battle-types.ts";
import { snapshotAllWalls } from "../shared/board-occupancy.ts";
import { modifierDef } from "../shared/modifier-defs.ts";
import {
  collectLocalCrosshairs,
  resolveBalloons,
  snapshotTerritory,
  tickCannonballs,
} from "./battle-system.ts";
import { applyDefaultFacings } from "./cannon-system.ts";
import { localFire, localPlacePiece } from "./game-actions.ts";
import { isCeasefireActive, nextPhase } from "./game-engine.ts";
import { tickGrunts } from "./grunt-movement.ts";
import { gruntAttackTowers, tickBreachSpawnQueue } from "./grunt-system.ts";
import {
  advanceBattleCountdown,
  collectBattleFrameEvents,
  initBattleControllers,
} from "./host-battle-ticks.ts";
import {
  finalizeCannonControllers,
  tickHostBuildPhase,
} from "./host-phase-ticks.ts";
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
  initBuildPhaseControllers,
  initControllerForCannonPhase,
  prepareCannonPhase,
} from "./phase-setup.ts";
import {
  BATTLE_START_STEPS,
  BUILD_START_STEPS,
  CANNON_START_STEPS,
  executeTransition,
  gateUpgradePick,
  NOOP_STEP,
  showBattlePhaseBanner,
  showBuildPhaseBanner,
  showCannonPhaseBanner,
  showModifierRevealBanner,
} from "./phase-transition-steps.ts";

export type {
  BuildEndPayload,
  CannonPhantomPayload,
  CannonPlacedPayload,
  PiecePhantomPayload,
  PiecePlacedPayload,
} from "../shared/phantom-types.ts";

export const phaseTickFacade = {
  clearImpacts,
  collectLocalCrosshairs,
  resolveBalloons,
  snapshotTerritory,
  tickCannonballs,
  applyDefaultFacings,
  isCeasefireActive,
  localFire,
  localPlacePiece,
  nextPhase,
  tickGrunts,
  gruntAttackTowers,
  tickBreachSpawnQueue,
  advanceBattleCountdown,
  collectBattleFrameEvents,
  initBattleControllers,
  snapshotAllWalls,
  modifierDef,
  enterBattleFromCannon,
  enterBuildSkippingBattle,
  finalizeCannonControllers,
  tickHostBuildPhase,
  BANNER_BATTLE,
  BANNER_BUILD,
  capturePrevBattleScene,
  computeScoreDeltas,
  finalizeBuildPhase,
  initBuildPhaseControllers,
  initControllerForCannonPhase,
  prepareCannonPhase,
  BATTLE_START_STEPS,
  BUILD_START_STEPS,
  CANNON_START_STEPS,
  executeTransition,
  gateUpgradePick,
  NOOP_STEP,
  showBattlePhaseBanner,
  showBuildPhaseBanner,
  showCannonPhaseBanner,
  showModifierRevealBanner,
};
