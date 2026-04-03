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

import { type BattleEvent, MESSAGE } from "../server/protocol.ts";
import {
  collectLocalCrosshairs,
  resolveBalloons,
  tickCannonballs,
} from "./battle-system.ts";
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
import { nextPhase, tickGameCore } from "./game-engine.ts";
import { tickGrunts } from "./grunt-movement.ts";
import { gruntAttackTowers } from "./grunt-system.ts";
import type { HapticsSystem } from "./haptics-system.ts";
import { tickHostBuildPhase, tickHostCannonPhase } from "./host-phase-ticks.ts";
import {
  beginHostBattle,
  LOCAL_BATTLE_START_NET,
  startHostBattleLifecycle,
  tickHostBalloonAnim,
  tickHostBattleCountdown,
  tickHostBattlePhase,
} from "./online-host-battle-ticks.ts";
import { NOOP_DEDUP_CHANNEL } from "./phantom-types.ts";
import { BANNER_BUILD } from "./phase-banner.ts";
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
  showBuildPhaseBanner,
  showCannonPhaseBanner,
} from "./phase-transition-shared.ts";
import {
  BANNER_PHASE_BUILD,
  BANNER_PHASE_CANNON,
  modifierBannerText,
} from "./round-modifiers.ts";
import { assertStateReady, type RuntimeState } from "./runtime-state.ts";
import type {
  RuntimeConfig,
  RuntimeLifeLost,
  RuntimeSelection,
} from "./runtime-types.ts";
import type { SoundSystem } from "./sound-system.ts";
import { isRemoteHuman, type MutableAccums } from "./tick-context.ts";
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
  pointerPlayer: () => (PlayerController & InputReceiver) | null;
  showBanner: (
    text: string,
    onDone: () => void,
    preserveOldScene?: boolean,
    newBattle?: { territory: Set<number>[]; walls: Set<number>[] },
    subtitle?: string,
  ) => void;
  lifeLost: Pick<RuntimeLifeLost, "tryShow" | "afterResolved">;
  selection: Pick<RuntimeSelection, "showBuildScoreDeltas">;
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
  syncCrosshairs: (battleCountdownExpired: boolean, dt?: number) => void;
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

  function syncCrosshairs(battleCountdownExpired: boolean, dt = 0): void {
    const remoteHumanSlots = runtimeState.frameCtx.remoteHumanSlots;
    runtimeState.frame.crosshairs = collectLocalCrosshairs({
      state: runtimeState.state,
      controllers: runtimeState.controllers,
      canFireNow: battleCountdownExpired,
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
    const remoteHumanSlots = runtimeState.frameCtx.remoteHumanSlots;
    deps.log(`startCannonPhase (round=${runtimeState.state.round})`);
    executeTransition(CANNON_START_STEPS, {
      showBanner: () => {
        if (onBannerDone) {
          // INVARIANT: Banner captures oldCastles BEFORE applyCheckpoint mutates state.
          // executeTransition guarantees this ordering via CANNON_START_STEPS.
          showCannonPhaseBanner(
            deps.showBanner,
            onBannerDone,
            modifierBannerText(
              runtimeState.state.activeModifier,
              BANNER_PHASE_CANNON,
            ),
          );
        }
      },
      applyCheckpoint: () => {
        prepareCannonPhase(runtimeState.state);
        // Apply reset facings — hidden behind the banner overlay.
        applyDefaultFacings(runtimeState.state);
        (runtimeState.accum as MutableAccums).cannon = 0;
        runtimeState.state.timer = runtimeState.state.cannonPlaceTimer;
        if (runtimeState.frameCtx.hostAtFrameStart && deps.hostNetworking) {
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
            isHost: runtimeState.frameCtx.hostAtFrameStart,
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
        remoteHumanSlots: runtimeState.frameCtx.remoteHumanSlots,
        isHost: runtimeState.frameCtx.hostAtFrameStart,
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
        isRemoteHuman(pid, remoteHumanSlots) ||
        !!runtimeState.state.players[pid]?.eliminated,
    );
    runtimeState.battleAnim.impacts = [];
    (runtimeState.accum as MutableAccums).grunt = 0;
    (runtimeState.accum as MutableAccums).build = 0;
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
        isHost: runtimeState.frameCtx.hostAtFrameStart,
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
      onBattleEvents: (events: ReadonlyArray<BattleEvent>) => {
        const pov = runtimeState.frameCtx.povPlayerId;
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

        // Step 1: apply checkpoint (nextPhase generates offers + modifier)
        nextPhase(runtimeState.state);
        if (runtimeState.frameCtx.hostAtFrameStart && deps.hostNetworking) {
          deps.send(
            deps.hostNetworking.createBuildStartMessage(runtimeState.state),
          );
        }

        // Step 2→3→4: upgrade pick (if any) → build banner → game
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
                  runtimeState.state.activeModifier,
                  BANNER_PHASE_BUILD,
                ),
              ),
            applyCheckpoint: () => {
              // Already applied above — no-op
            },
            initControllers: () => startBuildPhase(),
          });
        };

        if (deps.tryShowUpgradePick?.(showBannerAndEnterBuild)) return;
        showBannerAndEnterBuild();
      },
      net: {
        remoteHumanSlots: runtimeState.frameCtx.remoteHumanSlots,
        isHost: runtimeState.frameCtx.hostAtFrameStart,
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
        deps.lifeLost.tryShow(needsReselect, eliminated);
      },
      afterLifeLostResolved: deps.lifeLost.afterResolved,
      showScoreDeltas: deps.selection.showBuildScoreDeltas,
      onFirstEnclosure: deps.sound.chargeFanfare,
      net: {
        remoteHumanSlots: runtimeState.frameCtx.remoteHumanSlots,
        isHost: runtimeState.frameCtx.hostAtFrameStart,
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
    if (runtimeState.frameCtx.hostAtFrameStart) {
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
