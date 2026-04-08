/**
 * Phase tick wrappers — thin glue between config/runtimeState and the imported
 * tick functions from runtime-host-battle-ticks.ts, runtime-host-phase-ticks.ts, etc.
 *
 * Network wiring convention:
 *   `net` is REQUIRED on all tick deps interfaces. For online play, pass the
 *   full networking context. For local play, pass LOCAL_BATTLE_START_NET or
 *   build the net object with no-op sends and empty remote slots.
 *   This prevents accidental omission — the compiler enforces the choice.
 */

import { type BattleEvent, MESSAGE } from "../../server/protocol.ts";
import { phaseTickFacade } from "../game/phase-tick-facade.ts";
import { ageImpacts } from "../shared/battle-types.ts";
import {
  BALLOON_FLIGHT_DURATION,
  BATTLE_COUNTDOWN,
  BATTLE_TIMER,
  IMPACT_FLASH_DURATION,
} from "../shared/game-constants.ts";
import { NOOP_DEDUP_CHANNEL } from "../shared/phantom-types.ts";
import {
  type HapticsSystem,
  isHuman,
  type SoundSystem,
} from "../shared/system-interfaces.ts";
import {
  ACCUM_BUILD,
  ACCUM_CANNON,
  ACCUM_GRUNT,
  isRemoteHuman,
  resetAccum,
  type WatcherTimingState,
} from "../shared/tick-context.ts";
import type { GameState } from "../shared/types.ts";
import { Mode } from "../shared/ui-mode.ts";
import {
  assertStateReady,
  type RuntimeState,
  setMode,
} from "./runtime-state.ts";
import type {
  OnlineRuntimeConfig,
  RuntimeConfig,
  RuntimeLifeLost,
} from "./runtime-types.ts";

interface PhaseTicksDeps
  extends Pick<RuntimeConfig, "send" | "log">,
    Partial<
      Pick<
        OnlineRuntimeConfig,
        | "hostNetworking"
        | "watcherTiming"
        | "extendCrosshairs"
        | "onLocalCrosshairCollected"
        | "tickNonHost"
        | "everyTick"
      >
    > {
  runtimeState: RuntimeState;

  // Sibling systems / parent callbacks
  render: () => void;
  showBanner: (
    text: string,
    onDone: () => void,
    preservePrevScene?: boolean,
    newBattle?: { territory: Set<number>[]; walls: Set<number>[] },
    subtitle?: string,
  ) => void;
  lifeLost: Pick<RuntimeLifeLost, "tryShow" | "onResolved">;
  scoreDelta: {
    capturePreScores: () => void;
    show: (onDone: () => void) => void;
    isActive: () => boolean;
    reset: () => void;
  };
  snapshotTerritory: () => Set<number>[];
  /** Save human crosshair at end of battle so it can be restored next battle. */
  saveBattleCrosshair?: () => void;
  /** Called after beginBattle completes (crosshair override, etc.). */
  onBeginBattle?: () => void;
  sound: SoundSystem;
  haptics: HapticsSystem;
  /** Try to show upgrade pick overlay. Returns true if shown (caller should
   *  defer Mode.GAME). `onDone` is called when all picks are resolved. */
  tryShowUpgradePick?: (onDone: () => void) => boolean;
  /** Pre-create the upgrade pick dialog for progressive reveal during banner. */
  prepareUpgradePick?: () => boolean;
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
  syncCrosshairs: (weaponsActive: boolean, dt?: number) => void;
}

/** Zeroed watcher timing for local play (no server-driven phase timing). */
const LOCAL_WATCHER_TIMING: WatcherTimingState = {
  phaseStartTime: 0,
  phaseDuration: 0,
  countdownStartTime: 0,
  countdownDuration: 0,
};

export function createPhaseTicksSystem(deps: PhaseTicksDeps): PhaseTicksSystem {
  if (deps.tickNonHost && !deps.hostNetworking) {
    throw new Error(
      "hostNetworking required when tickNonHost is configured (online mode)",
    );
  }
  const { runtimeState } = deps;

  // -------------------------------------------------------------------------
  // Crosshairs
  // -------------------------------------------------------------------------

  function syncCrosshairs(weaponsActive: boolean, dt = 0): void {
    const remoteHumanSlots = runtimeState.frameMeta.remoteHumanSlots;
    runtimeState.frame.crosshairs = phaseTickFacade.collectLocalCrosshairs({
      state: runtimeState.state,
      controllers: runtimeState.controllers,
      canFireNow: weaponsActive,
      skipController: (pid) => isRemoteHuman(pid, remoteHumanSlots),
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
    const remoteHumanSlots = runtimeState.frameMeta.remoteHumanSlots;
    deps.log(`startCannonPhase (round=${runtimeState.state.round})`);
    phaseTickFacade.executeTransition(phaseTickFacade.CANNON_START_STEPS, {
      showBanner: () => {
        if (onBannerDone) {
          // INVARIANT: Banner captures prevCastles BEFORE applyCheckpoint mutates state.
          // executeTransition guarantees this ordering via CANNON_START_STEPS.
          phaseTickFacade.showCannonPhaseBanner(deps.showBanner, onBannerDone);
        }
      },
      applyCheckpoint: () => {
        phaseTickFacade.prepareCannonPhase(runtimeState.state);
        // Apply reset facings — hidden behind the banner overlay.
        phaseTickFacade.applyDefaultFacings(runtimeState.state);
        resetAccum(runtimeState.accum, ACCUM_CANNON);
        runtimeState.state.timer = runtimeState.state.cannonPlaceTimer;
        if (runtimeState.frameMeta.hostAtFrameStart && deps.hostNetworking) {
          deps.send(
            deps.hostNetworking.createCannonStartMessage(runtimeState.state),
          );
        }
      },
      initControllers: () => {
        for (const ctrl of runtimeState.controllers) {
          if (isRemoteHuman(ctrl.playerId, remoteHumanSlots)) continue;
          phaseTickFacade.initControllerForCannonPhase(
            ctrl,
            runtimeState.state,
          );
        }
      },
    });
  }

  // -------------------------------------------------------------------------
  // Battle
  // -------------------------------------------------------------------------

  function sendBuildCheckpointIfHost(): void {
    if (runtimeState.frameMeta.hostAtFrameStart && deps.hostNetworking) {
      deps.send(
        deps.hostNetworking.createBuildStartMessage(runtimeState.state),
      );
    }
  }

  function enterBuildViaUpgradePick(): void {
    const showBannerAndEnterBuild = () => {
      phaseTickFacade.executeTransition(phaseTickFacade.BUILD_START_STEPS, {
        showBanner: () =>
          phaseTickFacade.showBuildPhaseBanner(
            deps.showBanner,
            phaseTickFacade.BANNER_BUILD,
            () => {
              setMode(runtimeState, Mode.GAME);
            },
          ),
        applyCheckpoint: phaseTickFacade.NOOP_STEP,
        initControllers: () => startBuildPhase(),
      });
    };
    phaseTickFacade.gateUpgradePick(
      deps.showBanner,
      deps.tryShowUpgradePick,
      !!runtimeState.state.modern?.pendingUpgradeOffers,
      showBannerAndEnterBuild,
      deps.prepareUpgradePick,
    );
  }

  function startBattle() {
    deps.sound.drumsStop();
    deps.log(`startBattle (round=${runtimeState.state.round})`);
    deps.scoreDelta.reset();

    phaseTickFacade.startHostBattleLifecycle({
      state: runtimeState.state,
      battleAnim: runtimeState.battleAnim,
      banner: runtimeState.banner,
      resolveBalloons: phaseTickFacade.resolveBalloons,
      snapshotTerritory: deps.snapshotTerritory,
      showBanner: deps.showBanner,
      nextPhase: phaseTickFacade.nextPhase,
      setModeBalloonAnim: () => {
        setMode(runtimeState, Mode.BALLOON_ANIM);
      },
      beginBattle,
      net: deps.hostNetworking
        ? {
            isHost: runtimeState.frameMeta.hostAtFrameStart,
            sendBattleStart: (flights, diff) => {
              deps.send(
                deps.hostNetworking!.createBattleStartMessage(
                  runtimeState.state,
                  flights,
                  diff,
                ),
              );
            },
          }
        : phaseTickFacade.LOCAL_BATTLE_START_NET,
      ceasefireActive: phaseTickFacade.isCeasefireActive(runtimeState.state),
      onCeasefire: () => {
        deps.log("ceasefire: skipping battle");
        sendBuildCheckpointIfHost();
        enterBuildViaUpgradePick();
      },
    });
  }

  function tickBalloonAnim(dt: number) {
    phaseTickFacade.tickHostBalloonAnim({
      dt,
      balloonFlightDuration: BALLOON_FLIGHT_DURATION,
      battleAnim: runtimeState.battleAnim,
      render: deps.render,
      beginBattle,
    });
  }

  function beginBattle() {
    phaseTickFacade.beginHostBattle({
      state: runtimeState.state,
      controllers: runtimeState.controllers,
      accum: runtimeState.accum,
      battleCountdown: BATTLE_COUNTDOWN,
      setModeGame: () => {
        setMode(runtimeState, Mode.GAME);
      },
      net: {
        remoteHumanSlots: runtimeState.frameMeta.remoteHumanSlots,
        isHost: runtimeState.frameMeta.hostAtFrameStart,
        watcherTiming: deps.watcherTiming ?? LOCAL_WATCHER_TIMING,
      },
    });
    deps.onBeginBattle?.();
  }

  // -------------------------------------------------------------------------
  // Build phase
  // -------------------------------------------------------------------------

  function startBuildPhase() {
    const remoteHumanSlots = runtimeState.frameMeta.remoteHumanSlots;
    deps.log(`startBuildPhase (round=${runtimeState.state.round})`);
    deps.scoreDelta.reset();
    deps.scoreDelta.capturePreScores();
    phaseTickFacade.initBuildPhaseControllers(
      runtimeState.state,
      runtimeState.controllers,
      (pid) =>
        isRemoteHuman(pid, remoteHumanSlots) ||
        !!runtimeState.state.players[pid]?.eliminated,
    );
    runtimeState.battleAnim.impacts = [];
    resetAccum(runtimeState.accum, ACCUM_GRUNT);
    resetAccum(runtimeState.accum, ACCUM_BUILD);
  }

  // -------------------------------------------------------------------------
  // Tick wrappers
  // -------------------------------------------------------------------------

  function tickCannonPhase(dt: number): boolean {
    return phaseTickFacade.tickHostCannonPhase({
      dt,
      state: runtimeState.state,
      accum: runtimeState.accum,
      frame: runtimeState.frame,
      controllers: runtimeState.controllers,
      render: deps.render,
      startBattle,
      net: {
        remoteHumanSlots: runtimeState.frameMeta.remoteHumanSlots,
        isHost: runtimeState.frameMeta.hostAtFrameStart,
        remoteCannonPhantoms: deps.hostNetworking?.remoteCannonPhantoms() ?? [],
        lastSentCannonPhantom:
          deps.hostNetworking?.lastSentCannonPhantom() ?? NOOP_DEDUP_CHANNEL,
        sendOpponentCannonPlaced: (msg) =>
          deps.send({ type: MESSAGE.OPPONENT_CANNON_PLACED, ...msg }),
        sendOpponentCannonPhantom: (msg) =>
          deps.send({ type: MESSAGE.OPPONENT_CANNON_PHANTOM, ...msg }),
      },
    });
  }

  function tickBattleCountdown(dt: number): void {
    phaseTickFacade.tickHostBattleCountdown({
      dt,
      state: runtimeState.state,
      frame: runtimeState.frame,
      controllers: runtimeState.controllers,
      syncCrosshairs,
      render: deps.render,
      net: { remoteHumanSlots: runtimeState.frameMeta.remoteHumanSlots },
    });
  }

  function tickBattlePhase(dt: number): boolean {
    return phaseTickFacade.tickHostBattlePhase({
      dt,
      state: runtimeState.state,
      battleTimer: BATTLE_TIMER,
      accum: runtimeState.accum,
      controllers: runtimeState.controllers,
      battleAnim: runtimeState.battleAnim,
      render: deps.render,
      syncCrosshairs,
      collectTowerEvents: phaseTickFacade.gruntAttackTowers,
      tickCannonballsWithEvents: phaseTickFacade.tickCannonballs,
      onBattleEvents: (events: ReadonlyArray<BattleEvent>) => {
        const pov = runtimeState.frameMeta.povPlayerId;
        deps.haptics.battleEvents(events, pov);
        deps.sound.battleEvents(events, pov);
        phaseTickFacade.accumulateBattleStats(
          events,
          runtimeState.scoreDisplay.gameStats,
        );
      },
      onBattlePhaseEnded: () => {
        deps.saveBattleCrosshair?.();

        // Pre-capture old battle scene before nextPhase mutates state
        phaseTickFacade.capturePrevBattleScene(
          runtimeState.banner,
          runtimeState.state,
          runtimeState.battleAnim.territory,
          runtimeState.battleAnim.walls,
        );

        phaseTickFacade.nextPhase(runtimeState.state);
        sendBuildCheckpointIfHost();
        enterBuildViaUpgradePick();
      },
      net: {
        remoteHumanSlots: runtimeState.frameMeta.remoteHumanSlots,
        isHost: runtimeState.frameMeta.hostAtFrameStart,
        sendMessage: deps.send,
      },
    });
  }

  function tickBuildPhase(dt: number): boolean {
    if (deps.scoreDelta.isActive()) {
      deps.render();
      return false;
    }
    return phaseTickFacade.tickHostBuildPhase({
      dt,
      state: runtimeState.state,
      banner: runtimeState.banner,
      accum: runtimeState.accum,
      frame: runtimeState.frame,
      controllers: runtimeState.controllers,
      render: deps.render,
      tickGrunts: (gameState: GameState) => {
        phaseTickFacade.tickBreachSpawnQueue(gameState);
        phaseTickFacade.tickGrunts(gameState);
      },
      isHuman,
      finalizeBuildPhase: phaseTickFacade.finalizeBuildPhase,
      showLifeLostDialog: (needsReselect, eliminated) => {
        deps.sound.lifeLost();
        deps.lifeLost.tryShow(needsReselect, eliminated);
      },
      onLifeLostResolved: deps.lifeLost.onResolved,
      showScoreDeltas: deps.scoreDelta.show,
      onFirstEnclosure: deps.sound.chargeFanfare,
      net: {
        remoteHumanSlots: runtimeState.frameMeta.remoteHumanSlots,
        isHost: runtimeState.frameMeta.hostAtFrameStart,
        remotePiecePhantoms: deps.hostNetworking?.remotePiecePhantoms() ?? [],
        lastSentPiecePhantom:
          deps.hostNetworking?.lastSentPiecePhantom() ?? NOOP_DEDUP_CHANNEL,
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
    if (runtimeState.frameMeta.hostAtFrameStart) {
      phaseTickFacade.tickGameCore({
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
      ageImpacts(runtimeState.battleAnim, dt, IMPACT_FLASH_DURATION);
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
