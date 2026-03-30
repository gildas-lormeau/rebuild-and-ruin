/**
 * Phase tick wrappers — thin glue between config/runtimeState and the imported
 * tick functions from runtime-host-battle-ticks.ts, runtime-host-phase-ticks.ts, etc.
 */

import { MESSAGE } from "../server/protocol.ts";
import { resolveBalloons, tickCannonballs } from "./battle-system.ts";
import { applyDefaultFacings } from "./cannon-system.ts";
import {
  type InputReceiver,
  isHuman,
  type PlayerController,
} from "./controller-interfaces.ts";
import {
  BALLOON_FLIGHT_DURATION,
  BATTLE_COUNTDOWN,
  BATTLE_TIMER,
  IMPACT_FLASH_DURATION,
} from "./game-constants.ts";
import {
  finalizeBuildPhase,
  initBuildPhaseControllers,
  initControllerForCannonPhase,
  nextPhase,
  prepareCannonPhase,
} from "./game-engine.ts";
import { collectLocalCrosshairs, tickGameCore } from "./game-ui-helpers.ts";
import { tickGrunts } from "./grunt-movement.ts";
import { gruntAttackTowers } from "./grunt-system.ts";
import type { HapticsSystem } from "./haptics-system.ts";
import { BANNER_BUILD } from "./phase-banner.ts";
import {
  BUILD_START_STEPS,
  CANNON_START_STEPS,
  executeTransition,
  showBuildPhaseBanner,
  showCannonPhaseBanner,
} from "./phase-transition-shared.ts";
import {
  beginHostBattle,
  startHostBattleLifecycle,
  tickHostBalloonAnim,
  tickHostBattleCountdown,
  tickHostBattlePhase,
} from "./runtime-host-battle-ticks.ts";
import {
  tickHostBuildPhase,
  tickHostCannonPhase,
} from "./runtime-host-phase-ticks.ts";
import { assertStateReady, type RuntimeState } from "./runtime-state.ts";
import type {
  RuntimeConfig,
  RuntimeLifeLost,
  RuntimeSelection,
} from "./runtime-types.ts";
import type { SoundSystem } from "./sound-system.ts";
import { Mode } from "./types.ts";

interface PhaseTicksDeps
  extends Pick<
    RuntimeConfig,
    | "send"
    | "log"
    | "hostNetworking"
    | "watcherTiming"
    | "extendCrosshairs"
    | "onLocalCrosshairCollected"
    | "tickNonHost"
    | "everyTick"
  > {
  runtimeState: RuntimeState;

  // Sibling systems / parent callbacks
  render: () => void;
  firstHuman: () => (PlayerController & InputReceiver) | null;
  showBanner: (
    text: string,
    onDone: () => void,
    preserveOldScene?: boolean,
    newBattle?: { territory: Set<number>[]; walls: Set<number>[] },
    subtitle?: string,
  ) => void;
  lifeLost: Pick<RuntimeLifeLost, "show" | "afterResolved">;
  selection: Pick<RuntimeSelection, "showBuildScoreDeltas">;
  snapshotTerritory: () => Set<number>[];
  /** Save human crosshair at end of battle so it can be restored next battle. */
  saveBattleCrosshair?: () => void;
  /** Called after beginBattle completes (crosshair override, etc.). */
  onBeginBattle?: () => void;
  sound: SoundSystem;
  haptics: HapticsSystem;
}

export interface PhaseTicksSystem {
  startCannonPhase: (onBannerDone?: () => void) => void;
  startBattle: () => void;
  tickBalloonAnim: (dt: number) => void;
  beginBattle: () => void;
  startBuildPhase: () => void;
  tickCannonPhase: (dt: number) => boolean;
  tickBattleCountdown: (dt: number) => void;
  tickBattlePhase: (dt: number) => boolean;
  tickBuildPhase: (dt: number) => boolean;
  tickGame: (dt: number) => void;
  syncCrosshairs: (canFireNow: boolean, dt?: number) => void;
}

export function createPhaseTicksSystem(deps: PhaseTicksDeps): PhaseTicksSystem {
  const { runtimeState } = deps;

  // -------------------------------------------------------------------------
  // Crosshairs
  // -------------------------------------------------------------------------

  function syncCrosshairs(canFireNow: boolean, dt = 0): void {
    const remoteHumanSlots = runtimeState.frameCtx.remoteHumanSlots;
    runtimeState.frame.crosshairs = collectLocalCrosshairs({
      state: runtimeState.state,
      controllers: runtimeState.controllers,
      canFireNow,
      skipController: (pid) => remoteHumanSlots.has(pid),
      onCrosshairCollected: deps.onLocalCrosshairCollected,
    });
    if (deps.extendCrosshairs) {
      runtimeState.frame.crosshairs = deps.extendCrosshairs(
        runtimeState.frame.crosshairs,
        dt,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Cannon phase
  // -------------------------------------------------------------------------

  function startCannonPhase(onBannerDone?: () => void) {
    deps.sound.drumsQuiet();
    const remoteHumanSlots = runtimeState.frameCtx.remoteHumanSlots;
    deps.log(`startCannonPhase (round=${runtimeState.state.round})`);
    executeTransition(CANNON_START_STEPS, {
      applyCheckpoint: () => {
        prepareCannonPhase(runtimeState.state);
        runtimeState.accum.cannon = 0;
        runtimeState.state.timer = runtimeState.state.cannonPlaceTimer;
        if (runtimeState.frameCtx.isHost && deps.hostNetworking) {
          deps.send(
            deps.hostNetworking.createCannonStartMessage(runtimeState.state),
          );
        }
      },
      initControllers: () => {
        for (const ctrl of runtimeState.controllers) {
          if (remoteHumanSlots.has(ctrl.playerId)) continue;
          initControllerForCannonPhase(ctrl, runtimeState.state);
        }
      },
      showBanner: () => {
        if (onBannerDone) {
          // Banner captures oldCastles (with old facings) before we snap.
          showCannonPhaseBanner(deps.showBanner, onBannerDone);
          // Now apply reset facings — hidden behind the banner overlay.
          applyDefaultFacings(runtimeState.state);
        }
      },
    });
  }

  // -------------------------------------------------------------------------
  // Battle
  // -------------------------------------------------------------------------

  function startBattle() {
    deps.sound.drumsStop();
    deps.log(`startBattle (round=${runtimeState.state.round})`);
    runtimeState.scoreDeltas = [];
    runtimeState.scoreDeltaTimer = 0;
    runtimeState.scoreDeltaOnDone = null;
    startHostBattleLifecycle({
      state: runtimeState.state,
      battleAnim: runtimeState.battleAnim,
      banner: runtimeState.banner,
      resolveBalloons,
      snapshotTerritory: deps.snapshotTerritory,
      showBanner: deps.showBanner,
      nextPhase,
      setModeBalloonAnim: () => {
        runtimeState.mode = Mode.BALLOON_ANIM;
      },
      beginBattle,
      net: deps.hostNetworking
        ? {
            isHost: runtimeState.frameCtx.isHost,
            sendBattleStart: (flights) => {
              deps.send(
                deps.hostNetworking!.createBattleStartMessage(
                  runtimeState.state,
                  flights,
                ),
              );
            },
          }
        : undefined,
    });
  }

  function tickBalloonAnim(dt: number) {
    tickHostBalloonAnim({
      dt,
      balloonFlightDuration: BALLOON_FLIGHT_DURATION,
      battleAnim: runtimeState.battleAnim,
      render: deps.render,
      beginBattle,
    });
  }

  function beginBattle() {
    beginHostBattle({
      state: runtimeState.state,
      controllers: runtimeState.controllers,
      accum: runtimeState.accum,
      battleCountdown: BATTLE_COUNTDOWN,
      setModeGame: () => {
        runtimeState.mode = Mode.GAME;
      },
      net: {
        remoteHumanSlots: runtimeState.frameCtx.remoteHumanSlots,
        isHost: runtimeState.frameCtx.isHost,
        watcherTiming: deps.watcherTiming ?? {
          phaseStartTime: 0,
          phaseDuration: 0,
          countdownStartTime: 0,
          countdownDuration: 0,
        },
        now: () => performance.now(),
      },
    });
    deps.onBeginBattle?.();
  }

  // -------------------------------------------------------------------------
  // Build phase
  // -------------------------------------------------------------------------

  function startBuildPhase() {
    const remoteHumanSlots = runtimeState.frameCtx.remoteHumanSlots;
    deps.log(`startBuildPhase (round=${runtimeState.state.round})`);
    runtimeState.preScores = runtimeState.state.players.map(
      (player) => player.score,
    );
    runtimeState.scoreDeltas = [];
    runtimeState.scoreDeltaTimer = 0;
    runtimeState.scoreDeltaOnDone = null;
    initBuildPhaseControllers(
      runtimeState.state,
      runtimeState.controllers,
      (pid) =>
        remoteHumanSlots.has(pid) ||
        !!runtimeState.state.players[pid]?.eliminated,
    );
    runtimeState.battleAnim.impacts = [];
    runtimeState.accum.grunt = 0;
    runtimeState.accum.build = 0;
  }

  // -------------------------------------------------------------------------
  // Tick wrappers
  // -------------------------------------------------------------------------

  function tickCannonPhase(dt: number): boolean {
    return tickHostCannonPhase({
      dt,
      state: runtimeState.state,
      accum: runtimeState.accum,
      frame: runtimeState.frame,
      controllers: runtimeState.controllers,
      render: deps.render,
      startBattle,
      net: {
        remoteHumanSlots: runtimeState.frameCtx.remoteHumanSlots,
        isHost: runtimeState.frameCtx.isHost,
        remoteCannonPhantoms: deps.hostNetworking?.remoteCannonPhantoms() ?? [],
        lastSentCannonPhantom:
          deps.hostNetworking?.lastSentCannonPhantom() ?? new Map(),
        sendOpponentCannonPlaced: (msg) =>
          deps.send({ type: MESSAGE.OPPONENT_CANNON_PLACED, ...msg }),
        sendOpponentCannonPhantom: (msg) =>
          deps.send({ type: MESSAGE.OPPONENT_CANNON_PHANTOM, ...msg }),
      },
    });
  }

  function tickBattleCountdown(dt: number): void {
    tickHostBattleCountdown({
      dt,
      state: runtimeState.state,
      frame: runtimeState.frame,
      controllers: runtimeState.controllers,
      syncCrosshairs,
      render: deps.render,
      net: { remoteHumanSlots: runtimeState.frameCtx.remoteHumanSlots },
    });
  }

  function tickBattlePhase(dt: number): boolean {
    return tickHostBattlePhase({
      dt,
      state: runtimeState.state,
      battleTimer: BATTLE_TIMER,
      accum: runtimeState.accum,
      controllers: runtimeState.controllers,
      battleAnim: runtimeState.battleAnim,
      render: deps.render,
      syncCrosshairs,
      collectTowerEvents: gruntAttackTowers,
      tickCannonballsWithEvents: tickCannonballs,
      onBattleEvents: (events) => {
        const pid = runtimeState.frameCtx.myPlayerId;
        const localPid = pid >= 0 ? pid : (deps.firstHuman()?.playerId ?? -1);
        if (localPid >= 0) {
          deps.haptics.battleEvents(
            events as Array<{ type: string; playerId?: number; hp?: number }>,
            localPid,
          );
          deps.sound.battleEvents(events, localPid);
        }
        for (const evt of events as Array<{
          type: string;
          playerId?: number;
          shooterId?: number;
          hp?: number;
          newHp?: number;
        }>) {
          const stats =
            evt.shooterId !== undefined
              ? runtimeState.gameStats[evt.shooterId]
              : undefined;
          if (!stats) continue;
          if (evt.type === MESSAGE.WALL_DESTROYED) {
            stats.wallsDestroyed++;
          } else if (evt.type === MESSAGE.CANNON_DAMAGED && evt.newHp === 0) {
            stats.cannonsKilled++;
          }
        }
      },
      onBattlePhaseEnded: () => {
        deps.saveBattleCrosshair?.();
        executeTransition(BUILD_START_STEPS, {
          showBanner: () =>
            showBuildPhaseBanner(deps.showBanner, BANNER_BUILD, () => {
              runtimeState.mode = Mode.GAME;
            }),
          applyCheckpoint: () => {
            nextPhase(runtimeState.state);
            if (runtimeState.frameCtx.isHost && deps.hostNetworking) {
              deps.send(
                deps.hostNetworking.createBuildStartMessage(runtimeState.state),
              );
            }
          },
          // Runs immediately (during banner), not deferred to onDone.
          // Safe: build phase doesn't tick until Mode.GAME is set in the callback.
          initControllers: () => startBuildPhase(),
        });
      },
      net: {
        remoteHumanSlots: runtimeState.frameCtx.remoteHumanSlots,
        isHost: runtimeState.frameCtx.isHost,
        sendMessage: deps.send,
      },
    });
  }

  function tickBuildPhase(dt: number): boolean {
    if (runtimeState.scoreDeltaOnDone) {
      deps.render();
      return false;
    }
    return tickHostBuildPhase({
      dt,
      state: runtimeState.state,
      banner: runtimeState.banner,
      accum: runtimeState.accum,
      frame: runtimeState.frame,
      controllers: runtimeState.controllers,
      render: deps.render,
      tickGrunts,
      isHuman,
      finalizeBuildPhase,
      showLifeLostDialog: (needsReselect, eliminated) => {
        deps.sound.lifeLost();
        deps.lifeLost.show(needsReselect, eliminated);
      },
      afterLifeLostResolved: deps.lifeLost.afterResolved,
      showScoreDeltas: deps.selection.showBuildScoreDeltas,
      onFirstEnclosure: deps.sound.chargeFanfare,
      net: {
        remoteHumanSlots: runtimeState.frameCtx.remoteHumanSlots,
        isHost: runtimeState.frameCtx.isHost,
        remotePiecePhantoms: deps.hostNetworking?.remotePiecePhantoms() ?? [],
        lastSentPiecePhantom:
          deps.hostNetworking?.lastSentPiecePhantom() ?? new Map(),
        serializePlayers: deps.hostNetworking?.serializePlayers,
        sendOpponentPiecePlaced: (msg) =>
          deps.send({ type: MESSAGE.OPPONENT_PIECE_PLACED, ...msg }),
        sendOpponentPhantom: (msg) =>
          deps.send({ type: MESSAGE.OPPONENT_PHANTOM, ...msg }),
        sendBuildEnd: (msg) => deps.send({ type: MESSAGE.BUILD_END, ...msg }),
      },
    });
  }

  // -------------------------------------------------------------------------
  // tickGame — dispatches to the correct phase tick
  // -------------------------------------------------------------------------

  /** Canonical state-ready guard — all phase ticks funnel through here,
   *  so a single assertion covers cannon, battle, build, and balloon ticks. */
  function tickGame(dt: number) {
    assertStateReady(runtimeState);
    if (runtimeState.frameCtx.isHost) {
      tickGameCore({
        dt,
        state: runtimeState.state,
        battleAnim: runtimeState.battleAnim,
        impactFlashDuration: IMPACT_FLASH_DURATION,
        tickCannonPhase,
        tickBattleCountdown,
        tickBattlePhase,
        tickBuildPhase,
      });
    } else {
      for (const imp of runtimeState.battleAnim.impacts) imp.age += dt;
      runtimeState.battleAnim.impacts = runtimeState.battleAnim.impacts.filter(
        (imp) => imp.age < IMPACT_FLASH_DURATION,
      );
      deps.tickNonHost?.(dt);
      deps.render();
    }
    deps.everyTick?.(dt);
  }

  return {
    startCannonPhase,
    startBattle,
    tickBalloonAnim,
    beginBattle,
    startBuildPhase,
    tickCannonPhase,
    tickBattleCountdown,
    tickBattlePhase,
    tickBuildPhase,
    tickGame,
    syncCrosshairs,
  };
}
