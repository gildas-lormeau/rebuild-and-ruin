/**
 * Phase-tick facade — explicit contract boundary between game/ and runtime/
 * for the phase-ticks subsystem (battle, cannon, build phase ticking).
 *
 * Runtime subsystems import this single facade instead of reaching into
 * individual game/ files.
 */

import { ageImpacts, clearImpacts } from "../shared/battle-types.ts";
import {
  accumulateBattleStats,
  collectLocalCrosshairs,
  resolveBalloons,
  snapshotTerritory,
  tickCannonballs,
} from "./battle-system.ts";
import { applyDefaultFacings } from "./cannon-system.ts";
import { isCeasefireActive, nextPhase, tickGameCore } from "./game-engine.ts";
import { tickGrunts } from "./grunt-movement.ts";
import { gruntAttackTowers, tickBreachSpawnQueue } from "./grunt-system.ts";
import {
  beginHostBattle,
  LOCAL_BATTLE_START_NET,
  startHostBattleLifecycle,
  tickHostBalloonAnim,
  tickHostBattleCountdown,
  tickHostBattlePhase,
} from "./host-battle-ticks.ts";
import { tickHostBuildPhase, tickHostCannonPhase } from "./host-phase-ticks.ts";
import { BANNER_BUILD, capturePrevBattleScene } from "./phase-banner.ts";
import {
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
} from "./host-phase-ticks.ts";

export const phaseTickFacade = {
  ageImpacts,
  clearImpacts,
  accumulateBattleStats,
  collectLocalCrosshairs,
  resolveBalloons,
  snapshotTerritory,
  tickCannonballs,
  applyDefaultFacings,
  isCeasefireActive,
  nextPhase,
  tickGameCore,
  tickGrunts,
  gruntAttackTowers,
  tickBreachSpawnQueue,
  beginHostBattle,
  LOCAL_BATTLE_START_NET,
  startHostBattleLifecycle,
  tickHostBalloonAnim,
  tickHostBattleCountdown,
  tickHostBattlePhase,
  tickHostBuildPhase,
  tickHostCannonPhase,
  BANNER_BUILD,
  capturePrevBattleScene,
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
