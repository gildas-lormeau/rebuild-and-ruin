/**
 * Phase-tick facade — explicit contract boundary between game/ and runtime/
 * for the phase-ticks subsystem (battle, cannon, build phase ticking).
 *
 * Runtime subsystems import this single facade instead of reaching into
 * individual game/ files.
 */

import { clearImpacts } from "../shared/battle-types.ts";
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
  initBattleControllers,
  startHostBattleLifecycle,
  tickHostBattlePhase,
} from "./host-battle-ticks.ts";
import { tickHostBuildPhase, tickHostCannonPhase } from "./host-phase-ticks.ts";
import { BANNER_BUILD, capturePrevBattleScene } from "./phase-banner.ts";
import {
  computeScoreDeltas,
  finalizeBuildPhase,
  initBuildPhaseControllers,
  initControllerForCannonPhase,
  prepareCannonPhase,
} from "./phase-setup.ts";
import {
  BUILD_START_STEPS,
  CANNON_START_STEPS,
  executeTransition,
  gateUpgradePick,
  NOOP_STEP,
  showBuildPhaseBanner,
  showCannonPhaseBanner,
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
  initBattleControllers,
  startHostBattleLifecycle,
  tickHostBattlePhase,
  tickHostBuildPhase,
  tickHostCannonPhase,
  BANNER_BUILD,
  capturePrevBattleScene,
  computeScoreDeltas,
  finalizeBuildPhase,
  initBuildPhaseControllers,
  initControllerForCannonPhase,
  prepareCannonPhase,
  BUILD_START_STEPS,
  CANNON_START_STEPS,
  executeTransition,
  gateUpgradePick,
  NOOP_STEP,
  showBuildPhaseBanner,
  showCannonPhaseBanner,
};
