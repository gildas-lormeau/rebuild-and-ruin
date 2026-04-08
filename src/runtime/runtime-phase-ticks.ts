/**
 * Phase tick wrappers — thin glue between config/runtimeState and the imported
 * tick functions from game/host-battle-ticks.ts, game/host-phase-ticks.ts.
 *
 * Network wiring convention:
 *   Game-domain tick functions are network-agnostic. This module pre-filters
 *   controllers (local vs remote) and provides optional broadcast callbacks.
 *   For local play the callbacks are omitted; for online they send to the wire.
 */

import type {
  BuildEndPayload,
  CannonPhantomPayload,
  CannonPlacedPayload,
  PiecePhantomPayload,
  PiecePlacedPayload,
} from "../game/phase-tick-facade.ts";
import { phaseTickFacade } from "../game/phase-tick-facade.ts";
import { ageImpacts } from "../shared/battle-types.ts";
import {
  BALLOON_FLIGHT_DURATION,
  BATTLE_COUNTDOWN,
  BATTLE_TIMER,
  IMPACT_FLASH_DURATION,
} from "../shared/game-constants.ts";
import { Phase } from "../shared/game-phase.ts";
import {
  filterAlivePhantoms,
  NOOP_DEDUP_CHANNEL,
} from "../shared/phantom-types.ts";
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
  localControllers,
  resetAccum,
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

  // Pre-built message senders — protocol knowledge stays in composition root.
  // For local play these close over the config no-op send; for online they
  // construct the typed message and send it over the wire.
  sendOpponentCannonPlaced: (msg: CannonPlacedPayload) => void;
  sendOpponentCannonPhantom: (msg: CannonPhantomPayload) => void;
  sendOpponentPiecePlaced: (msg: PiecePlacedPayload) => void;
  sendOpponentPhantom: (msg: PiecePhantomPayload) => void;
  sendBuildEnd: (msg: BuildEndPayload) => void;

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

  /** Send build checkpoint + enter build phase (via upgrade pick gate).
   *  Checkpoint is sent here — not in the transition steps — because it must
   *  precede the upgrade pick dialog (which reads post-battle state). */
  function enterBuildViaUpgradePick(): void {
    if (runtimeState.frameMeta.hostAtFrameStart && deps.hostNetworking) {
      deps.send(
        deps.hostNetworking.createBuildStartMessage(runtimeState.state),
      );
    }
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
      sendBattleStart:
        deps.hostNetworking && runtimeState.frameMeta.hostAtFrameStart
          ? (flights, diff) => {
              deps.send(
                deps.hostNetworking!.createBattleStartMessage(
                  runtimeState.state,
                  flights,
                  diff,
                ),
              );
            }
          : undefined,
      ceasefireActive: phaseTickFacade.isCeasefireActive(runtimeState.state),
      onCeasefire: () => {
        deps.log("ceasefire: skipping battle");
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
    const remoteHumanSlots = runtimeState.frameMeta.remoteHumanSlots;
    phaseTickFacade.beginHostBattle({
      state: runtimeState.state,
      controllers: localControllers(runtimeState.controllers, remoteHumanSlots),
      accum: runtimeState.accum,
      battleCountdown: BATTLE_COUNTDOWN,
      setModeGame: () => {
        setMode(runtimeState, Mode.GAME);
      },
    });
    // Watcher timing: record countdown start for non-host clients
    if (!runtimeState.frameMeta.hostAtFrameStart && deps.watcherTiming) {
      deps.watcherTiming.countdownStartTime = performance.now();
      deps.watcherTiming.countdownDuration = BATTLE_COUNTDOWN;
    }
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
    phaseTickFacade.clearImpacts(runtimeState.battleAnim);
    resetAccum(runtimeState.accum, ACCUM_GRUNT);
    resetAccum(runtimeState.accum, ACCUM_BUILD);
  }

  // -------------------------------------------------------------------------
  // Tick wrappers
  // -------------------------------------------------------------------------

  function tickCannonPhase(dt: number): boolean {
    const remoteHumanSlots = runtimeState.frameMeta.remoteHumanSlots;
    const isHost = runtimeState.frameMeta.hostAtFrameStart;
    return phaseTickFacade.tickHostCannonPhase({
      dt,
      state: runtimeState.state,
      accum: runtimeState.accum,
      frame: runtimeState.frame,
      localControllers: localControllers(
        runtimeState.controllers,
        remoteHumanSlots,
      ),
      remoteControllers: runtimeState.controllers.filter((ctrl) =>
        isRemoteHuman(ctrl.playerId, remoteHumanSlots),
      ),
      render: deps.render,
      startBattle,
      onCannonPlaced: isHost ? deps.sendOpponentCannonPlaced : undefined,
      onCannonPhantom: isHost ? deps.sendOpponentCannonPhantom : undefined,
      remoteCannonPhantoms: filterAlivePhantoms(
        deps.hostNetworking?.remoteCannonPhantoms() ?? [],
        runtimeState.state.players,
      ),
      lastSentCannonPhantom:
        deps.hostNetworking?.lastSentCannonPhantom() ?? NOOP_DEDUP_CHANNEL,
    });
  }

  function tickBattleCountdown(dt: number): void {
    const remoteHumanSlots = runtimeState.frameMeta.remoteHumanSlots;
    phaseTickFacade.tickHostBattleCountdown({
      dt,
      state: runtimeState.state,
      frame: runtimeState.frame,
      controllers: localControllers(runtimeState.controllers, remoteHumanSlots),
      syncCrosshairs,
      render: deps.render,
    });
  }

  function tickBattlePhase(dt: number): boolean {
    const remoteHumanSlots = runtimeState.frameMeta.remoteHumanSlots;
    const isHost = runtimeState.frameMeta.hostAtFrameStart;
    const local = localControllers(runtimeState.controllers, remoteHumanSlots);
    return phaseTickFacade.tickHostBattlePhase({
      dt,
      state: runtimeState.state,
      battleTimer: BATTLE_TIMER,
      accum: runtimeState.accum,
      localControllers: local,
      controllersToFinalize: local,
      battleAnim: runtimeState.battleAnim,
      render: deps.render,
      syncCrosshairs,
      collectTowerEvents: phaseTickFacade.gruntAttackTowers,
      tickCannonballsWithEvents: phaseTickFacade.tickCannonballs,
      onBattleEvents: (events) => {
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
        enterBuildViaUpgradePick();
      },
      broadcastEvent: isHost ? deps.send : undefined,
    });
  }

  function tickBuildPhase(dt: number): boolean {
    if (deps.scoreDelta.isActive()) {
      deps.render();
      return false;
    }
    const remoteHumanSlots = runtimeState.frameMeta.remoteHumanSlots;
    const isHost = runtimeState.frameMeta.hostAtFrameStart;
    return phaseTickFacade.tickHostBuildPhase({
      dt,
      state: runtimeState.state,
      banner: runtimeState.banner,
      accum: runtimeState.accum,
      frame: runtimeState.frame,
      localControllers: localControllers(
        runtimeState.controllers,
        remoteHumanSlots,
      ),
      allControllers: runtimeState.controllers,
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
      shouldSkipLifeLostNotify: (pid) => isRemoteHuman(pid, remoteHumanSlots),
      shouldBroadcastWalls: isHost,
      onPiecePlaced: isHost ? deps.sendOpponentPiecePlaced : undefined,
      onPhantom: isHost ? deps.sendOpponentPhantom : undefined,
      remotePiecePhantoms: filterAlivePhantoms(
        deps.hostNetworking?.remotePiecePhantoms() ?? [],
        runtimeState.state.players,
      ),
      lastSentPiecePhantom:
        deps.hostNetworking?.lastSentPiecePhantom() ?? NOOP_DEDUP_CHANNEL,
      serializePlayers: deps.hostNetworking?.serializePlayers,
      onBuildEnd: isHost ? deps.sendBuildEnd : undefined,
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
      // Age and filter impact flashes regardless of phase
      ageImpacts(runtimeState.battleAnim, dt, IMPACT_FLASH_DURATION);

      const { phase } = runtimeState.state;
      if (phase === Phase.CANNON_PLACE) {
        tickCannonPhase(dt);
      } else if (phase === Phase.BATTLE) {
        if (runtimeState.state.battleCountdown > 0) {
          tickBattleCountdown(dt);
        } else {
          tickBattlePhase(dt);
        }
      } else if (phase === Phase.WALL_BUILD) {
        tickBuildPhase(dt);
      }
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
