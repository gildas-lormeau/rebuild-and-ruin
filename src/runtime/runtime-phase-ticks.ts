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
import {
  collectLocalCrosshairs,
  resolveBalloons,
  tickCannonballs,
} from "../game/battle-system.ts";
import { applyDefaultFacings } from "../game/cannon-system.ts";
import { nextPhase, tickGameCore } from "../game/game-engine.ts";
import { tickGrunts } from "../game/grunt-movement.ts";
import { gruntAttackTowers } from "../game/grunt-system.ts";
import {
  beginHostBattle,
  LOCAL_BATTLE_START_NET,
  startHostBattleLifecycle,
  tickHostBalloonAnim,
  tickHostBattleCountdown,
  tickHostBattlePhase,
} from "../game/host-battle-ticks.ts";
import {
  tickHostBuildPhase,
  tickHostCannonPhase,
} from "../game/host-phase-ticks.ts";
import { BANNER_BUILD, capturePrevBattleScene } from "../game/phase-banner.ts";
import {
  finalizeBuildPhase,
  initBuildPhaseControllers,
  initControllerForCannonPhase,
  prepareCannonPhase,
} from "../game/phase-setup.ts";
import {
  BUILD_START_STEPS,
  CANNON_START_STEPS,
  executeTransition,
  gateUpgradePick,
  showBuildPhaseBanner,
  showCannonPhaseBanner,
} from "../game/phase-transition-shared.ts";
import {
  BANNER_PHASE_BUILD,
  BANNER_PHASE_CANNON,
  modifierBannerText,
} from "../game/round-modifiers.ts";
import {
  BALLOON_FLIGHT_DURATION,
  BATTLE_COUNTDOWN,
  BATTLE_TIMER,
  IMPACT_FLASH_DURATION,
} from "../shared/game-constants.ts";
import { Mode } from "../shared/game-phase.ts";
import { NOOP_DEDUP_CHANNEL } from "../shared/phantom-types.ts";
import {
  type HapticsSystem,
  type InputReceiver,
  isHuman,
  type PlayerController,
  type SoundSystem,
} from "../shared/system-interfaces.ts";
import {
  ACCUM_CANNON,
  isRemoteHuman,
  resetAccum,
} from "../shared/tick-context.ts";
import { assertStateReady, type RuntimeState } from "./runtime-state.ts";
import type { RuntimeConfig, RuntimeLifeLost } from "./runtime-types.ts";

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
  pointerPlayer: () => (PlayerController & InputReceiver) | null;
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
  /** Monotonic timestamp source (injected for testability). */
  now: () => number;
  /** Try to show upgrade pick overlay. Returns true if shown (caller should
   *  defer Mode.GAME). `onDone` is called when all picks are resolved. */
  tryShowUpgradePick?: (onDone: () => void) => boolean;
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
    runtimeState.frame.crosshairs = collectLocalCrosshairs({
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
    executeTransition(CANNON_START_STEPS, {
      showBanner: () => {
        if (onBannerDone) {
          // INVARIANT: Banner captures prevCastles BEFORE applyCheckpoint mutates state.
          // executeTransition guarantees this ordering via CANNON_START_STEPS.
          showCannonPhaseBanner(
            deps.showBanner,
            onBannerDone,
            modifierBannerText(
              runtimeState.state.modern?.activeModifier ?? null,
              BANNER_PHASE_CANNON,
            ),
          );
        }
      },
      applyCheckpoint: () => {
        prepareCannonPhase(runtimeState.state);
        // Apply reset facings — hidden behind the banner overlay.
        applyDefaultFacings(runtimeState.state);
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
          initControllerForCannonPhase(ctrl, runtimeState.state);
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
    deps.scoreDelta.reset();
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
            isHost: runtimeState.frameMeta.hostAtFrameStart,
            sendBattleStart: (flights) => {
              deps.send(
                deps.hostNetworking!.createBattleStartMessage(
                  runtimeState.state,
                  flights,
                ),
              );
            },
          }
        : LOCAL_BATTLE_START_NET,
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
        remoteHumanSlots: runtimeState.frameMeta.remoteHumanSlots,
        isHost: runtimeState.frameMeta.hostAtFrameStart,
        watcherTiming: deps.watcherTiming ?? {
          phaseStartTime: 0,
          phaseDuration: 0,
          countdownStartTime: 0,
          countdownDuration: 0,
        },
        now: deps.now,
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
    initBuildPhaseControllers(
      runtimeState.state,
      runtimeState.controllers,
      (pid) =>
        isRemoteHuman(pid, remoteHumanSlots) ||
        !!runtimeState.state.players[pid]?.eliminated,
    );
    runtimeState.battleAnim.impacts = [];
    resetAccum(runtimeState.accum, "grunt");
    resetAccum(runtimeState.accum, "build");
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
    tickHostBattleCountdown({
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
      onBattleEvents: (events: ReadonlyArray<BattleEvent>) => {
        const pov = runtimeState.frameMeta.povPlayerId;
        deps.haptics.battleEvents(events, pov);
        deps.sound.battleEvents(events, pov);
        for (const evt of events) {
          if (evt.type === MESSAGE.WALL_DESTROYED) {
            const stats =
              evt.shooterId !== undefined
                ? runtimeState.gameStats[evt.shooterId]
                : undefined;
            if (stats) stats.wallsDestroyed++;
          } else if (evt.type === MESSAGE.CANNON_DAMAGED && evt.newHp === 0) {
            const stats =
              evt.shooterId !== undefined
                ? runtimeState.gameStats[evt.shooterId]
                : undefined;
            if (stats) stats.cannonsKilled++;
          }
        }
      },
      onBattlePhaseEnded: () => {
        deps.saveBattleCrosshair?.();

        // Pre-capture old battle scene before nextPhase mutates state
        capturePrevBattleScene(
          runtimeState.banner,
          runtimeState.state,
          runtimeState.battleAnim.territory,
          runtimeState.battleAnim.walls,
        );

        // Step 1: apply checkpoint (nextPhase generates offers + modifier)
        nextPhase(runtimeState.state);
        if (runtimeState.frameMeta.hostAtFrameStart && deps.hostNetworking) {
          deps.send(
            deps.hostNetworking.createBuildStartMessage(runtimeState.state),
          );
        }

        // Step 2→3→4: upgrade pick banner + dialog (if any) → build banner �� game
        const showBannerAndEnterBuild = () => {
          executeTransition(BUILD_START_STEPS, {
            showBanner: () =>
              showBuildPhaseBanner(
                deps.showBanner,
                BANNER_BUILD,
                () => {
                  runtimeState.mode = Mode.GAME;
                },
                modifierBannerText(
                  runtimeState.state.modern?.activeModifier ?? null,
                  BANNER_PHASE_BUILD,
                ),
              ),
            applyCheckpoint: () => {
              // Already applied above — no-op
            },
            initControllers: () => startBuildPhase(),
          });
        };

        gateUpgradePick(
          deps.showBanner,
          deps.tryShowUpgradePick,
          !!runtimeState.state.modern?.pendingUpgradeOffers,
          showBannerAndEnterBuild,
        );
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
