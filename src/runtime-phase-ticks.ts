/**
 * Phase tick wrappers — thin glue between config/rs and the imported
 * tick functions from runtime-host-battle-ticks.ts, runtime-host-phase-ticks.ts, etc.
 */

import {
  type GameMessage,
  MSG,
  type SerializedPlayer,
} from "../server/protocol.ts";
import { resolveBalloons, tickCannonballs } from "./battle-system.ts";
import {
  type Crosshair,
  type InputReceiver,
  isHuman,
  type PlayerController,
} from "./controller-interfaces.ts";
import {
  finalizeBuildPhase,
  initBuildPhase,
  nextPhase,
} from "./game-engine.ts";
import {
  collectLocalCrosshairs,
  initCannonPhase,
  tickGameCore,
} from "./game-ui-runtime.ts";
import { gruntAttackTowers, tickGrunts } from "./grunt-system.ts";
import { hapticBattleEvents } from "./input-haptics.ts";
import type {
  CannonPhantom,
  PiecePhantom,
  WatcherTimingState,
} from "./online-types.ts";
import { BANNER_BUILD, BANNER_BUILD_SUB } from "./phase-banner.ts";
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
import type { RuntimeState } from "./runtime-state.ts";
import type { GameRuntime } from "./runtime-types.ts";
import type { BalloonFlight, GameState } from "./types.ts";
import {
  BALLOON_FLIGHT_DURATION,
  BATTLE_COUNTDOWN,
  BATTLE_TIMER,
  IMPACT_FLASH_DURATION,
  Mode,
} from "./types.ts";

interface PhaseTicksDeps {
  rs: RuntimeState;

  // Config / networking
  send: (msg: GameMessage) => void;
  log: (msg: string) => void;
  hostNetworking?: {
    serializePlayers: (state: GameState) => SerializedPlayer[];
    createCannonStartMessage: (state: GameState) => GameMessage;
    createBattleStartMessage: (
      state: GameState,
      flights: readonly BalloonFlight[],
    ) => GameMessage;
    createBuildStartMessage: (state: GameState) => GameMessage;
    remoteCannonPhantoms: () => readonly CannonPhantom[];
    remotePiecePhantoms: () => readonly PiecePhantom[];
    lastSentCannonPhantom: () => Map<number, string>;
    lastSentPiecePhantom: () => Map<number, string>;
  };
  watcherTiming?: WatcherTimingState;
  extendCrosshairs?: (crosshairs: Crosshair[], dt: number) => Crosshair[];
  onLocalCrosshairCollected?: (
    ctrl: PlayerController,
    ch: { x: number; y: number },
    readyCannon: boolean,
  ) => void;
  tickNonHost?: (dt: number) => void;
  everyTick?: (dt: number) => void;

  // Sibling systems / parent callbacks
  render: () => void;
  firstHuman: () => (PlayerController & InputReceiver) | null;
  showBanner: (
    text: string,
    onDone: () => void,
    reveal?: boolean,
    newBattle?: { territory: Set<number>[]; walls: Set<number>[] },
    subtitle?: string,
  ) => void;
  showLifeLostDialog: (
    needsReselect: readonly number[],
    eliminated: readonly number[],
  ) => void;
  afterLifeLostResolved: () => boolean;
  showScoreDeltas: (onDone: () => void) => void;
  snapshotTerritory: () => Set<number>[];
  /** Save human crosshair at end of battle so it can be restored next battle. */
  saveBattleCrosshair?: () => void;
  /** Called after beginBattle completes (crosshair override, etc.). */
  onBeginBattle?: () => void;
}

export type PhaseTicksSystem = Pick<
  GameRuntime,
  | "startCannonPhase"
  | "startBattle"
  | "tickBalloonAnim"
  | "beginBattle"
  | "startBuildPhase"
  | "tickCannonPhase"
  | "tickBattleCountdown"
  | "tickBattlePhase"
  | "tickBuildPhase"
  | "tickGame"
  | "syncCrosshairs"
>;

export function createPhaseTicksSystem(deps: PhaseTicksDeps): PhaseTicksSystem {
  const { rs } = deps;

  // -------------------------------------------------------------------------
  // Crosshairs
  // -------------------------------------------------------------------------

  function syncCrosshairs(canFireNow: boolean, dt = 0): void {
    const remoteHumanSlots = rs.ctx.remoteHumanSlots;
    rs.frame.crosshairs = collectLocalCrosshairs({
      state: rs.state,
      controllers: rs.controllers,
      canFireNow,
      skipController: (pid) => remoteHumanSlots.has(pid),
      onCrosshairCollected: deps.onLocalCrosshairCollected,
    });
    if (deps.extendCrosshairs) {
      rs.frame.crosshairs = deps.extendCrosshairs(rs.frame.crosshairs, dt);
    }
  }

  // -------------------------------------------------------------------------
  // Cannon phase
  // -------------------------------------------------------------------------

  function startCannonPhase() {
    const remoteHumanSlots = rs.ctx.remoteHumanSlots;
    deps.log(`startCannonPhase (round=${rs.state.round})`);
    initCannonPhase({
      state: rs.state,
      controllers: rs.controllers,
      skipController: (pid) => remoteHumanSlots.has(pid),
    });

    rs.accum.cannon = 0;
    rs.state.timer = rs.state.cannonPlaceTimer;
    if (rs.ctx.isHost && deps.hostNetworking) {
      deps.send(deps.hostNetworking.createCannonStartMessage(rs.state));
    }
  }

  // -------------------------------------------------------------------------
  // Battle
  // -------------------------------------------------------------------------

  function startBattle() {
    deps.log(`startBattle (round=${rs.state.round})`);
    rs.scoreDeltas = [];
    rs.scoreDeltaTimer = 0;
    rs.scoreDeltaOnDone = null;
    startHostBattleLifecycle({
      state: rs.state,
      battleAnim: rs.battleAnim,
      resolveBalloons,
      snapshotTerritory: deps.snapshotTerritory,
      showBanner: deps.showBanner,
      nextPhase,
      setModeBalloonAnim: () => {
        rs.mode = Mode.BALLOON_ANIM;
      },
      beginBattle,
      net: deps.hostNetworking
        ? {
            isHost: rs.ctx.isHost,
            sendBattleStart: (flights) => {
              deps.send(
                deps.hostNetworking!.createBattleStartMessage(
                  rs.state,
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
      battleAnim: rs.battleAnim,
      render: deps.render,
      beginBattle,
    });
  }

  function beginBattle() {
    beginHostBattle({
      state: rs.state,
      controllers: rs.controllers,
      accum: rs.accum,
      battleCountdown: BATTLE_COUNTDOWN,
      setModeGame: () => {
        rs.mode = Mode.GAME;
      },
      net: {
        remoteHumanSlots: rs.ctx.remoteHumanSlots,
        isHost: rs.ctx.isHost,
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
    const remoteHumanSlots = rs.ctx.remoteHumanSlots;
    deps.log(`startBuildPhase (round=${rs.state.round})`);
    rs.preScores = rs.state.players.map((p) => p.score);
    rs.scoreDeltas = [];
    rs.scoreDeltaTimer = 0;
    rs.scoreDeltaOnDone = null;
    initBuildPhase(
      rs.state,
      rs.controllers,
      (pid) => remoteHumanSlots.has(pid) || !!rs.state.players[pid]?.eliminated,
    );
    rs.battleAnim.impacts = [];
    rs.accum.grunt = 0;
    rs.accum.build = 0;
  }

  // -------------------------------------------------------------------------
  // Tick wrappers
  // -------------------------------------------------------------------------

  function tickCannonPhase(dt: number): boolean {
    return tickHostCannonPhase({
      dt,
      state: rs.state,
      accum: rs.accum,
      frame: rs.frame,
      controllers: rs.controllers,
      render: deps.render,
      startBattle,
      net: {
        remoteHumanSlots: rs.ctx.remoteHumanSlots,
        isHost: rs.ctx.isHost,
        remoteCannonPhantoms: deps.hostNetworking?.remoteCannonPhantoms() ?? [],
        lastSentCannonPhantom:
          deps.hostNetworking?.lastSentCannonPhantom() ?? new Map(),
        sendOpponentCannonPlaced: (msg) =>
          deps.send({ type: MSG.OPPONENT_CANNON_PLACED, ...msg }),
        sendOpponentCannonPhantom: (msg) =>
          deps.send({ type: MSG.OPPONENT_CANNON_PHANTOM, ...msg }),
      },
    });
  }

  function tickBattleCountdown(dt: number): void {
    tickHostBattleCountdown({
      dt,
      state: rs.state,
      frame: rs.frame,
      controllers: rs.controllers,
      syncCrosshairs,
      render: deps.render,
      net: { remoteHumanSlots: rs.ctx.remoteHumanSlots },
    });
  }

  function tickBattlePhase(dt: number): boolean {
    return tickHostBattlePhase({
      dt,
      state: rs.state,
      battleTimer: BATTLE_TIMER,
      accum: rs.accum,
      controllers: rs.controllers,
      battleAnim: rs.battleAnim,
      render: deps.render,
      syncCrosshairs,
      collectTowerEvents: gruntAttackTowers,
      tickCannonballsWithEvents: tickCannonballs,
      onBattleEvents: (events) => {
        const pid = rs.ctx.myPlayerId;
        const localPid = pid >= 0 ? pid : (deps.firstHuman()?.playerId ?? -1);
        if (localPid >= 0)
          hapticBattleEvents(
            events as Array<{ type: string; playerId?: number; hp?: number }>,
            localPid,
          );
        for (const evt of events as Array<{
          type: string;
          playerId?: number;
          shooterId?: number;
          hp?: number;
          newHp?: number;
        }>) {
          const stats =
            evt.shooterId !== undefined
              ? rs.gameStats[evt.shooterId]
              : undefined;
          if (!stats) continue;
          if (evt.type === MSG.WALL_DESTROYED) {
            stats.wallsDestroyed++;
          } else if (evt.type === MSG.CANNON_DAMAGED && evt.newHp === 0) {
            stats.cannonsKilled++;
          }
        }
      },
      onBattlePhaseEnded: () => {
        deps.saveBattleCrosshair?.();
        deps.showBanner(
          BANNER_BUILD,
          () => {
            startBuildPhase();
            rs.mode = Mode.GAME;
          },
          true,
          undefined,
          BANNER_BUILD_SUB,
        );
        nextPhase(rs.state);
        if (rs.ctx.isHost && deps.hostNetworking) {
          deps.send(deps.hostNetworking.createBuildStartMessage(rs.state));
        }
      },
      net: {
        remoteHumanSlots: rs.ctx.remoteHumanSlots,
        isHost: rs.ctx.isHost,
        sendMessage: deps.send,
      },
    });
  }

  function tickBuildPhase(dt: number): boolean {
    if (rs.scoreDeltaOnDone) {
      deps.render();
      return false;
    }
    return tickHostBuildPhase({
      dt,
      state: rs.state,
      accum: rs.accum,
      frame: rs.frame,
      controllers: rs.controllers,
      render: deps.render,
      tickGrunts,
      isHuman,
      finalizeBuildPhase,
      showLifeLostDialog: deps.showLifeLostDialog,
      afterLifeLostResolved: deps.afterLifeLostResolved,
      showScoreDeltas: deps.showScoreDeltas,
      net: {
        remoteHumanSlots: rs.ctx.remoteHumanSlots,
        isHost: rs.ctx.isHost,
        remotePiecePhantoms: deps.hostNetworking?.remotePiecePhantoms() ?? [],
        lastSentPiecePhantom:
          deps.hostNetworking?.lastSentPiecePhantom() ?? new Map(),
        serializePlayers: deps.hostNetworking?.serializePlayers,
        sendOpponentPiecePlaced: (msg) =>
          deps.send({ type: MSG.OPPONENT_PIECE_PLACED, ...msg }),
        sendOpponentPhantom: (msg) =>
          deps.send({ type: MSG.OPPONENT_PHANTOM, ...msg }),
        sendBuildEnd: (msg) => deps.send({ type: MSG.BUILD_END, ...msg }),
      },
    });
  }

  // -------------------------------------------------------------------------
  // tickGame — dispatches to the correct phase tick
  // -------------------------------------------------------------------------

  function tickGame(dt: number) {
    if (rs.ctx.isHost) {
      tickGameCore({
        dt,
        state: rs.state,
        battleAnim: rs.battleAnim,
        impactFlashDuration: IMPACT_FLASH_DURATION,
        tickCannonPhase,
        tickBattleCountdown,
        tickBattlePhase,
        tickBuildPhase,
      });
    } else {
      for (const imp of rs.battleAnim.impacts) imp.age += dt;
      rs.battleAnim.impacts = rs.battleAnim.impacts.filter(
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
