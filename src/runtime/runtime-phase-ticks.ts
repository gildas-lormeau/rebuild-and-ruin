/**
 * Phase tick wrappers — thin glue between config/runtimeState and the imported
 * tick functions from game/host-battle-ticks.ts, game/host-phase-ticks.ts.
 *
 * Network wiring convention:
 *   Game-domain tick functions are network-agnostic. This module pre-filters
 *   controllers (local vs remote) and provides optional broadcast callbacks.
 *   For local play the callbacks are omitted; for online they send to the wire.
 */

import { type BattleEvent, MESSAGE } from "../../server/protocol.ts";
import type {
  BuildEndPayload,
  CannonPhantomPayload,
  CannonPlacedPayload,
  PiecePhantomPayload,
  PiecePlacedPayload,
} from "../game/phase-tick-facade.ts";
import { phaseTickFacade } from "../game/phase-tick-facade.ts";
import { ageImpacts, type BalloonFlight } from "../shared/battle-types.ts";
import {
  BALLOON_FLIGHT_DURATION,
  BATTLE_COUNTDOWN,
  BATTLE_TIMER,
  IMPACT_FLASH_DURATION,
} from "../shared/game-constants.ts";
import { Phase } from "../shared/game-phase.ts";
import type { PlayerStats } from "../shared/overlay-types.ts";
import {
  cannonPhantomKey,
  filterAlivePhantoms,
  NOOP_DEDUP_CHANNEL,
  phantomWireMode,
} from "../shared/phantom-types.ts";
import {
  type HapticsSystem,
  isHuman,
  type SoundSystem,
} from "../shared/system-interfaces.ts";
import {
  ACCUM_BATTLE,
  ACCUM_BUILD,
  ACCUM_CANNON,
  ACCUM_GRUNT,
  advancePhaseTimer,
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
    const { state, battleAnim, banner } = runtimeState;
    deps.sound.drumsStop();
    deps.log(`startBattle (round=${state.round})`);
    deps.scoreDelta.reset();

    // Ceasefire: skip battle entirely and proceed to build phase
    if (phaseTickFacade.isCeasefireActive(state)) {
      phaseTickFacade.enterBuildSkippingBattle(state);
      deps.log("ceasefire: skipping battle");
      enterBuildViaUpgradePick();
      return;
    }

    let flights: BalloonFlight[] = [];
    const activeModifier = state.modern?.activeModifier ?? null;

    const proceedToBattle = () => {
      if (flights.length > 0) {
        battleAnim.flights = flights.map((flight) => ({
          flight,
          progress: 0,
        }));
        setMode(runtimeState, Mode.BALLOON_ANIM);
      } else {
        beginBattle();
      }
    };

    phaseTickFacade.executeTransition(phaseTickFacade.BATTLE_START_STEPS, {
      showBanner: () => {
        if (activeModifier) {
          phaseTickFacade.showModifierRevealBanner(
            deps.showBanner,
            phaseTickFacade.modifierDef(activeModifier).label,
            () => {
              phaseTickFacade.showBattlePhaseBanner(
                deps.showBanner,
                phaseTickFacade.BANNER_BATTLE,
                proceedToBattle,
              );
            },
          );
        } else {
          phaseTickFacade.showBattlePhaseBanner(
            deps.showBanner,
            phaseTickFacade.BANNER_BATTLE,
            proceedToBattle,
          );
        }
      },
      applyCheckpoint: () => {
        const diff = phaseTickFacade.enterBattleFromCannon(state);
        if (diff) banner.modifierDiff = diff;
        // Resolve balloons AFTER enterBattleFromCannon so modifiers
        // (crumbling walls, etc.) are applied before the enclosure check picks targets.
        flights = phaseTickFacade.resolveBalloons(state);
        battleAnim.impacts = [];
        if (deps.hostNetworking && runtimeState.frameMeta.hostAtFrameStart) {
          deps.send(
            deps.hostNetworking.createBattleStartMessage(state, flights, diff),
          );
        }
      },
      snapshotForBanner: () => {
        const postTerritory = deps.snapshotTerritory();
        const postWalls = phaseTickFacade.snapshotAllWalls(state);
        battleAnim.territory = postTerritory;
        battleAnim.walls = postWalls;
        banner.newTerritory = postTerritory;
        banner.newWalls = postWalls;
      },
    });
  }

  function tickBalloonAnim(dt: number) {
    const { battleAnim } = runtimeState;
    let allDone = true;
    for (const flight of battleAnim.flights) {
      flight.progress = Math.min(
        1,
        flight.progress + dt / BALLOON_FLIGHT_DURATION,
      );
      if (flight.progress < 1) allDone = false;
    }
    deps.render();
    if (allDone) {
      battleAnim.flights = [];
      beginBattle();
    }
  }

  function beginBattle() {
    const remoteHumanSlots = runtimeState.frameMeta.remoteHumanSlots;
    phaseTickFacade.initBattleControllers(
      localControllers(runtimeState.controllers, remoteHumanSlots),
      runtimeState.state,
    );
    runtimeState.state.battleCountdown = BATTLE_COUNTDOWN;
    resetAccum(runtimeState.accum, ACCUM_BATTLE);
    setMode(runtimeState, Mode.GAME);
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
    const { state, frame } = runtimeState;
    const local = localControllers(runtimeState.controllers, remoteHumanSlots);
    const lastSentCannonPhantom =
      deps.hostNetworking?.lastSentCannonPhantom() ?? NOOP_DEDUP_CHANNEL;

    advancePhaseTimer(
      runtimeState.accum,
      ACCUM_CANNON,
      state,
      dt,
      state.cannonPlaceTimer,
    );

    // Collect default facings for phantom rendering
    const defaultFacings = new Map<number, number>();
    for (const player of state.players) {
      defaultFacings.set(player.id, player.defaultFacing);
    }
    frame.phantoms = { cannonPhantoms: [], defaultFacings };

    // PASS 1: tick local controllers, collect placements + phantoms
    for (const ctrl of local) {
      const cannonsBefore = state.players[ctrl.playerId]!.cannons.length;
      const phantom = ctrl.cannonTick(state, dt);

      if (isHost) {
        const cannonsAfter = state.players[ctrl.playerId]!.cannons.length;
        for (
          let cannonIdx = cannonsBefore;
          cannonIdx < cannonsAfter;
          cannonIdx++
        ) {
          const cannon = state.players[ctrl.playerId]!.cannons[cannonIdx]!;
          deps.sendOpponentCannonPlaced({
            playerId: ctrl.playerId,
            row: cannon.row,
            col: cannon.col,
            mode: cannon.mode,
          });
        }
      }

      if (!phantom) continue;
      frame.phantoms.cannonPhantoms!.push(phantom);

      if (
        isHost &&
        lastSentCannonPhantom.shouldSend(
          ctrl.playerId,
          cannonPhantomKey(phantom),
        )
      ) {
        deps.sendOpponentCannonPhantom({
          playerId: ctrl.playerId,
          row: phantom.row,
          col: phantom.col,
          mode: phantomWireMode(phantom),
          valid: phantom.valid,
        });
      }
    }

    // Merge remote phantoms
    const remoteCannonPhantoms = filterAlivePhantoms(
      deps.hostNetworking?.remoteCannonPhantoms() ?? [],
      state.players,
    );
    if (remoteCannonPhantoms.length > 0) {
      frame.phantoms.cannonPhantoms!.push(...remoteCannonPhantoms);
    }

    deps.render();

    const allDone = local.every((ctrl) => {
      const player = state.players[ctrl.playerId]!;
      if (player.eliminated) return true;
      const max = state.cannonLimits[player.id] ?? 0;
      return ctrl.isCannonPhaseDone(state, max);
    });

    if (state.timer > 0 && !allDone) return false;

    // PASS 2: finalize controllers for phase transition
    const remote = runtimeState.controllers.filter((ctrl) =>
      isRemoteHuman(ctrl.playerId, remoteHumanSlots),
    );
    phaseTickFacade.finalizeCannonControllers(state, local, remote);
    startBattle();
    return true;
  }

  function tickBattleCountdown(dt: number): void {
    const remoteHumanSlots = runtimeState.frameMeta.remoteHumanSlots;
    runtimeState.frame.announcement = phaseTickFacade.advanceBattleCountdown(
      runtimeState.state,
      dt,
    );
    for (const ctrl of localControllers(
      runtimeState.controllers,
      remoteHumanSlots,
    )) {
      ctrl.battleTick(runtimeState.state, dt);
    }
    syncCrosshairs(/* weaponsActive */ false, dt);
    deps.render();
  }

  function tickBattlePhase(dt: number): boolean {
    const remoteHumanSlots = runtimeState.frameMeta.remoteHumanSlots;
    const isHost = runtimeState.frameMeta.hostAtFrameStart;
    const local = localControllers(runtimeState.controllers, remoteHumanSlots);
    const { state, battleAnim } = runtimeState;
    const broadcast = isHost ? deps.send : undefined;

    advancePhaseTimer(runtimeState.accum, "battle", state, dt, BATTLE_TIMER);

    // Collect events (pure game logic — load-bearing order preserved inside)
    const result = phaseTickFacade.collectBattleFrameEvents({
      state,
      dt,
      localControllers: local,
      collectTowerEvents: phaseTickFacade.gruntAttackTowers,
      tickCannonballsWithEvents: phaseTickFacade.tickCannonballs,
    });

    // Broadcast events to network
    if (broadcast) {
      for (const evt of result.fireEvents) broadcast(evt);
      for (const evt of result.towerEvents) broadcast(evt);
      for (const evt of result.impactEvents) broadcast(evt);
    }

    // Record visual impacts
    for (const imp of result.newImpacts) {
      battleAnim.impacts.push({ ...imp, age: 0 });
    }

    // Notify sound/haptics
    const allEvents = [
      ...result.fireEvents,
      ...result.towerEvents,
      ...result.impactEvents,
    ];
    if (allEvents.length > 0) {
      const pov = runtimeState.frameMeta.povPlayerId;
      deps.haptics.battleEvents(allEvents, pov);
      deps.sound.battleEvents(allEvents, pov);
      accumulateBattleStats(allEvents, runtimeState.scoreDisplay.gameStats);
    }

    syncCrosshairs(/* weaponsActive */ true, dt);
    deps.render();

    if (state.timer > 0 || state.cannonballs.length > 0) return false;

    // Battle ended — finalize controllers and transition
    // NOTE: Intentionally includes eliminated players — they need battle state
    // cleanup (clear fire targets, etc.) for potential castle reselection.
    for (const ctrl of local) {
      ctrl.endBattle();
    }
    deps.saveBattleCrosshair?.();
    phaseTickFacade.capturePrevBattleScene(
      runtimeState.banner,
      state,
      battleAnim.territory,
      battleAnim.walls,
    );
    phaseTickFacade.nextPhase(state);
    enterBuildViaUpgradePick();
    return true;
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

  /** Accumulate per-player battle stats (walls destroyed, cannons killed) from battle events.
   *  UI/stats concern — lives in runtime, not game domain. */
  function accumulateBattleStats(
    events: ReadonlyArray<BattleEvent>,
    gameStats: readonly PlayerStats[],
  ): void {
    for (const evt of events) {
      if (evt.type === MESSAGE.WALL_DESTROYED) {
        const stats =
          evt.shooterId !== undefined ? gameStats[evt.shooterId] : undefined;
        if (stats) stats.wallsDestroyed++;
      } else if (evt.type === MESSAGE.CANNON_DAMAGED && evt.newHp === 0) {
        const stats =
          evt.shooterId !== undefined ? gameStats[evt.shooterId] : undefined;
        if (stats) stats.cannonsKilled++;
      }
    }
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
