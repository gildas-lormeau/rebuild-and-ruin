/**
 * Default AiBrain assembly — bundles the phase modules (selection / build /
 * cannon / battle), life-lost auto-resolve, and upgrade-pick tick into the
 * `AiBrain` interface that `AiController` consumes. Phase state holders are
 * captured in the closure so the controller never touches them directly.
 */

import type { AiBrain } from "./ai-brain-types.ts";
import { aiChooseLifeLost } from "./ai-life-lost.ts";
import {
  createBattlePhase,
  initBattle,
  onBattleFireResult,
  resetBattlePhaseKeepOrbit,
  tickBattle,
} from "./ai-phase-battle.ts";
import {
  BUILD_CURSOR_SPEEDS,
  createBuildPhase,
  finalizeBuild,
  initBuild,
  onBuildPlaceResult,
  resetBuildPhase,
  tickBuild,
} from "./ai-phase-build.ts";
import {
  CANNON_CURSOR_SPEEDS,
  createCannonPhase,
  flushCannon,
  initCannon,
  isCannonDone,
  resetCannonPhase,
  tickCannon,
} from "./ai-phase-cannon.ts";
import {
  createSelectionPhase,
  initSelection,
  resetSelectionPhase,
  tickSelection,
} from "./ai-phase-select.ts";
import { tickAiUpgradePickEntry } from "./ai-upgrade-pick.ts";
import { traitLookup } from "./ai-utils.ts";

/** Build a fresh default brain. Caller owns the returned object; each
 *  controller instance must get its own brain (the closure captures
 *  phase state, which is per-controller). */
export function createDefaultAiBrain(): AiBrain {
  const selectionPhase = createSelectionPhase();
  const buildPhase = createBuildPhase();
  const cannonPhase = createCannonPhase();
  const battlePhase = createBattlePhase();

  return {
    selection: {
      init: (host, state, zone) =>
        initSelection(host, selectionPhase, state, zone),
      tick: (host, state) => tickSelection(host, selectionPhase, state),
      reset: () => resetSelectionPhase(selectionPhase),
    },
    build: {
      init: (host, state) => initBuild(host, buildPhase, state),
      tick: (host, state) => tickBuild(host, buildPhase, state),
      onPlaceResult: (host, _state, success) =>
        onBuildPlaceResult(host, buildPhase, success),
      finalize: (host, state) => finalizeBuild(host, buildPhase, state),
      reset: () => resetBuildPhase(buildPhase),
      cursorSpeedFor: (skill) => traitLookup(skill, BUILD_CURSOR_SPEEDS),
    },
    cannon: {
      init: (host, state, maxSlots) =>
        initCannon(host, cannonPhase, state, maxSlots),
      tick: (host, state) => tickCannon(host, cannonPhase, state),
      flush: (host, state) => flushCannon(host, cannonPhase, state),
      isDone: () => isCannonDone(cannonPhase),
      reset: () => resetCannonPhase(cannonPhase),
      get maxSlots() {
        return cannonPhase.maxSlots;
      },
      cursorSpeedFor: (skill) => traitLookup(skill, CANNON_CURSOR_SPEEDS),
    },
    battle: {
      init: (host, state) => initBattle(host, battlePhase, state),
      tick: (host, state) => tickBattle(host, battlePhase, state),
      onFireResult: (host, state, success) =>
        onBattleFireResult(host, battlePhase, state, success),
      resetKeepOrbit: () => resetBattlePhaseKeepOrbit(battlePhase),
      setOrbitAngle: (angle) => {
        battlePhase.orbitAngle = angle;
      },
    },
    chooseLifeLost: aiChooseLifeLost,
    tickUpgradePick: tickAiUpgradePickEntry,
  };
}
