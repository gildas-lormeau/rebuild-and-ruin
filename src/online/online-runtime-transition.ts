import { setMode } from "../runtime/runtime-state.ts";
import type { GameRuntime } from "../runtime/runtime-types.ts";
import type { UpgradeId } from "../shared/core/upgrade-defs.ts";
import { LifeLostChoice } from "../shared/ui/interaction-types.ts";
import { PLAYER_COLORS } from "../shared/ui/player-config.ts";
import {
  applyBattleStartCheckpoint,
  applyBuildEndCheckpoint,
  applyBuildStartCheckpoint,
  applyCannonStartCheckpoint,
  type CheckpointDeps,
} from "./online-checkpoints.ts";
import type { TransitionContext } from "./online-phase-transitions.ts";
import type { OnlineSession } from "./online-session.ts";
import type { WatcherState } from "./online-watcher-tick.ts";

interface OnlineRuntimeTransitionDeps {
  getRuntime: () => GameRuntime;
  session: Pick<
    OnlineSession,
    "myPlayerId" | "earlyLifeLostChoices" | "earlyUpgradePickChoices"
  >;
  watcher: Pick<
    WatcherState,
    | "timing"
    | "remoteCrosshairs"
    | "watcherCrosshairPos"
    | "watcherOrbitParams"
    | "watcherOrbitAngles"
  >;
}

export function createOnlineTransitionContext(
  deps: OnlineRuntimeTransitionDeps,
): TransitionContext {
  return {
    getState: () => deps.getRuntime().runtimeState.state,
    session: deps.session,
    getControllers: () => deps.getRuntime().runtimeState.controllers,
    setMode: (mode) => {
      setMode(deps.getRuntime().runtimeState, mode);
    },
    ui: buildTransitionUiCtx(deps),
    checkpoint: buildTransitionCheckpointCtx(deps),
    selection: buildTransitionSelectionCtx(deps),
    battleLifecycle: buildTransitionBattleCtx(deps),
    endPhase: buildTransitionEndPhaseCtx(deps),
    upgradePick: {
      prepare: () => deps.getRuntime().upgradePick.prepare(),
      tryShow: (onDone) => {
        const runtime = deps.getRuntime();
        const shown = runtime.upgradePick.tryShow(onDone);
        if (shown) {
          const dialog = runtime.upgradePick.get();
          if (dialog) {
            for (const [playerId, choice] of deps.session
              .earlyUpgradePickChoices) {
              const entry = dialog.entries.find(
                (dialogEntry) =>
                  dialogEntry.playerId === playerId &&
                  dialogEntry.choice === null &&
                  dialogEntry.offers.includes(choice as UpgradeId),
              );
              if (entry) entry.choice = choice as UpgradeId;
            }
            deps.session.earlyUpgradePickChoices.clear();
          }
        }
        return shown;
      },
    },
    clearUpgradePickDialog: () => {
      deps.getRuntime().upgradePick.set(null);
    },
  };
}

function buildTransitionUiCtx(
  deps: OnlineRuntimeTransitionDeps,
): TransitionContext["ui"] {
  return {
    showBanner: (text, onDone, preservePrevScene?, newBattle?, subtitle?) =>
      deps
        .getRuntime()
        .showBanner(text, onDone, preservePrevScene, newBattle, subtitle),
    get banner() {
      return deps.getRuntime().runtimeState.banner;
    },
    render: () => deps.getRuntime().render(),
    watcherTiming: deps.watcher.timing,
  };
}

function buildTransitionCheckpointCtx(
  deps: OnlineRuntimeTransitionDeps,
): TransitionContext["checkpoint"] {
  return {
    applyCannonStart: (data, capturePreState) =>
      applyCannonStartCheckpoint(
        data,
        buildCheckpointDeps(deps),
        capturePreState,
      ),
    applyBattleStart: (data, capturePreState) =>
      applyBattleStartCheckpoint(
        data,
        buildCheckpointDeps(deps),
        capturePreState,
      ),
    applyBuildStart: (data, capturePreState) =>
      applyBuildStartCheckpoint(
        data,
        buildCheckpointDeps(deps),
        capturePreState,
      ),
    applyBuildEnd: (data, capturePreState) =>
      applyBuildEndCheckpoint(data, buildCheckpointDeps(deps), capturePreState),
  };
}

function buildTransitionSelectionCtx(
  deps: OnlineRuntimeTransitionDeps,
): TransitionContext["selection"] {
  return {
    clearSelectionOverlay: () => {
      const overlay = deps.getRuntime().runtimeState.overlay;
      if (overlay.selection) {
        overlay.selection.highlights = undefined;
        overlay.selection.highlighted = null;
        overlay.selection.selected = null;
      }
    },
    getStates: () => deps.getRuntime().selection.getStates(),
    setCastleBuildFromPlans: (plans, maxTiles, onDone) => {
      const runtime = deps.getRuntime();
      runtime.runtimeState.selection.castleBuilds.push({
        wallPlans: plans,
        maxTiles,
        wallTimelineIdx: 0,
        accum: 0,
      });
      runtime.runtimeState.selection.castleBuildOnDone = onDone;
    },
    setCastleBuildViewport: (plans) =>
      deps.getRuntime().selection.setCastleBuildViewport(plans),
  };
}

function buildTransitionBattleCtx(
  deps: OnlineRuntimeTransitionDeps,
): TransitionContext["battleLifecycle"] {
  return {
    setFlights: (flights) => {
      deps.getRuntime().runtimeState.battleAnim.flights = flights;
    },
    snapshotTerritory: () => deps.getRuntime().snapshotTerritory(),
    getTerritory: () => deps.getRuntime().runtimeState.battleAnim.territory,
    getWalls: () => deps.getRuntime().runtimeState.battleAnim.walls,
    setTerritory: (territory) => {
      deps.getRuntime().runtimeState.battleAnim.territory =
        territory as Set<number>[];
    },
    setWalls: (walls) => {
      deps.getRuntime().runtimeState.battleAnim.walls = walls as Set<number>[];
    },
    beginBattle: () => deps.getRuntime().phaseTicks.beginBattle(),
  };
}

function buildTransitionEndPhaseCtx(
  deps: OnlineRuntimeTransitionDeps,
): TransitionContext["endPhase"] {
  return {
    showLifeLostDialog: (needsReselect, eliminated) => {
      const runtime = deps.getRuntime();
      runtime.lifeLost.tryShow(needsReselect, eliminated);
      const dialog = runtime.lifeLost.get();
      if (dialog) {
        for (const [playerId, choice] of deps.session.earlyLifeLostChoices) {
          const entry = dialog.entries.find(
            (dialogEntry) => dialogEntry.playerId === playerId,
          );
          if (entry && entry.choice === LifeLostChoice.PENDING) {
            entry.choice = choice;
          }
        }
      }
      deps.session.earlyLifeLostChoices.clear();
    },
    showScoreDeltas: (preScores, onDone) => {
      const runtime = deps.getRuntime();
      runtime.scoreDelta.setPreScores(preScores);
      runtime.scoreDelta.show(onDone);
    },
    setGameOverFrame: (gameOver) => {
      deps.getRuntime().runtimeState.frame.gameOver = gameOver;
    },
    playerColors: PLAYER_COLORS,
  };
}

function buildCheckpointDeps(
  deps: OnlineRuntimeTransitionDeps,
): CheckpointDeps {
  const runtime = deps.getRuntime();
  return {
    state: runtime.runtimeState.state,
    battleAnim: runtime.runtimeState.battleAnim,
    accum: runtime.runtimeState.accum,
    remoteCrosshairs: deps.watcher.remoteCrosshairs,
    watcherCrosshairPos: deps.watcher.watcherCrosshairPos,
    watcherOrbitParams: deps.watcher.watcherOrbitParams,
    watcherOrbitAngles: deps.watcher.watcherOrbitAngles,
    snapshotTerritory: () => runtime.snapshotTerritory(),
  };
}
