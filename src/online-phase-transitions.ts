import {
  MESSAGE,
  type SerializedPlayer,
  type ServerMessage,
} from "../server/protocol.ts";
import { snapshotAllWalls } from "./board-occupancy.ts";
import { createCastle } from "./castle-generation.ts";
import type { PlayerController } from "./controller-interfaces.ts";
import { initControllerForCannonPhase, setPhase } from "./game-engine.ts";
import type { RGB } from "./geometry-types.ts";
import { TILE_COUNT } from "./grid.ts";
import type { WatcherTimingState } from "./online-types.ts";
import {
  BANNER_BATTLE_ONLINE,
  BANNER_REPAIR_ONLINE,
  type BannerShow,
} from "./phase-banner.ts";
import {
  BATTLE_START_STEPS,
  BUILD_START_STEPS,
  CANNON_START_STEPS,
  executeTransition,
  runBuildEndSequence,
  showBattlePhaseBanner,
  showBuildPhaseBanner,
  showCannonPhaseBanner,
} from "./phase-transition-shared.ts";
import { NO_WINNER_NAME } from "./player-config.ts";
import {
  FOCUS_REMATCH,
  type GameOverFocus,
  type GameState,
  Mode,
  Phase,
} from "./types.ts";

export interface TransitionContext {
  // --- Core state (used by most handlers) ---
  getState: () => GameState;
  getMyPlayerId: () => number;
  getControllers: () => PlayerController[];
  setMode: (mode: Mode) => void;
  now: () => number;

  // --- Banner & UI ---
  ui: {
    showBanner: BannerShow;
    banner: { newTerritory?: Set<number>[]; newWalls?: Set<number>[] };
    render: () => void;
    watcherTiming: WatcherTimingState;
    bannerDuration: number;
  };

  // --- Checkpoints ---
  checkpoint: {
    applyCannonStart: (msg: ServerMessage) => void;
    applyBattleStart: (msg: ServerMessage) => void;
    applyBuildStart: (msg: ServerMessage) => void;
    applyPlayers: (
      state: GameState,
      players: readonly SerializedPlayer[],
    ) => void;
  };

  // --- Selection & castle build ---
  selection: {
    clearOverlay: () => void;
    getStates: () => Map<number, { highlighted: number; confirmed: boolean }>;
    finalizeCastleConstruction: (state: GameState) => void;
    enterCannonPlacePhase: (state: GameState) => void;
    setCastleBuildFromPlans: (
      plans: readonly { playerId: number; tiles: number[] }[],
      maxTiles: number,
      onDone: () => void,
    ) => void;
    setCastleBuildViewport: (
      plans: readonly { playerId: number; tiles: number[] }[],
    ) => void;
  };

  // --- Battle ---
  battle: {
    setFlights: (
      value: readonly {
        flight: {
          startX: number;
          startY: number;
          endX: number;
          endY: number;
        };
        progress: number;
      }[],
    ) => void;
    snapshotTerritory: () => Set<number>[];
    /** Initiate the battle countdown.  Goes through beginHostBattle which
     *  handles resetBattle, countdown, watcher timing, aimAtEnemyCastle, and
     *  Mode.GAME — so the banner callback doesn't need to duplicate any of it. */
    beginBattle: () => void;
  };

  // --- Life-lost & game over ---
  endPhase: {
    resetZoneState: (state: GameState, zone: number) => void;
    showLifeLostDialog: (
      needsReselect: readonly number[],
      eliminated: readonly number[],
    ) => void;
    showScoreDeltas: (preScores: readonly number[], onDone: () => void) => void;
    setGameOverFrame: (payload: {
      winner: string;
      scores: {
        name: string;
        score: number;
        color: RGB;
        eliminated: boolean;
        territory?: number;
        stats?: { wallsDestroyed: number; cannonsKilled: number };
      }[];
      focused: GameOverFocus;
    }) => void;
    playerColors: ReadonlyArray<{ wall: RGB }>;
  };
}

export function handleCastleWallsTransition(
  msg: ServerMessage,
  ctx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.CASTLE_WALLS) return;
  const state = ctx.getState();
  const plans = msg.plans.map((p) => ({
    ...p,
    tiles: p.tiles.filter((t) => t >= 0 && t < TILE_COUNT),
  }));
  const maxTiles = Math.max(...plans.map((p) => p.tiles.length), 0);
  // Set player.castle so walls render during the build animation
  for (const plan of plans) {
    const player = state.players[plan.playerId];
    if (player?.homeTower && !player.castle) {
      player.castle = createCastle(
        player.homeTower,
        state.map.tiles,
        state.map.towers,
      );
    }
  }
  ctx.selection.getStates().clear();
  ctx.selection.clearOverlay();
  // Zoom to the local player's castle on mobile
  const myPlan = plans.find((p) => p.playerId === ctx.getMyPlayerId());
  if (myPlan) ctx.selection.setCastleBuildViewport([myPlan]);

  ctx.selection.setCastleBuildFromPlans(plans, maxTiles, () => {
    // No phase transition — cannon_start checkpoint drives it and reconciles state.
  });
  ctx.setMode(Mode.CASTLE_BUILD);
}

export function handleCannonStartTransition(
  msg: ServerMessage,
  ctx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.CANNON_START) return;
  const state = ctx.getState();
  const myPlayerId = ctx.getMyPlayerId();
  ctx.selection.clearOverlay();
  let needsBanner = false;
  executeTransition(CANNON_START_STEPS, {
    reconcileState: () => {
      ctx.checkpoint.applyCannonStart(msg);
      if (state.phase !== Phase.CANNON_PLACE) {
        setPhase(state, Phase.CANNON_PLACE);
        state.timer = state.cannonPlaceTimer;
        needsBanner = true;
      }
    },
    initControllers: () => {
      if (myPlayerId >= 0) {
        const ctrl = ctx.getControllers()[myPlayerId];
        if (ctrl) initControllerForCannonPhase(ctrl, state);
      }
    },
    showBanner: () => {
      if (needsBanner) {
        showCannonPhaseBanner(ctx.ui.showBanner, () => {
          ctx.ui.watcherTiming.phaseStartTime = ctx.now();
          ctx.ui.watcherTiming.phaseDuration = state.timer;
          ctx.setMode(Mode.GAME);
        });
      }
    },
  });
}

export function handleBattleStartTransition(
  msg: ServerMessage,
  ctx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.BATTLE_START) return;
  const state = ctx.getState();
  const battleFlights = msg.flights;

  executeTransition(BATTLE_START_STEPS, {
    showBanner: () =>
      showBattlePhaseBanner(ctx.ui.showBanner, BANNER_BATTLE_ONLINE, () => {
        if (battleFlights && battleFlights.length > 0) {
          ctx.battle.setFlights(
            battleFlights.map((f) => ({
              flight: {
                startX: f.startX,
                startY: f.startY,
                endX: f.endX,
                endY: f.endY,
              },
              progress: 0,
            })),
          );
          ctx.setMode(Mode.BALLOON_ANIM);
        } else {
          ctx.battle.beginBattle();
        }
      }),
    reconcileState: () => {
      ctx.checkpoint.applyBattleStart(msg);
      setPhase(state, Phase.BATTLE);
    },
    snapshotForBanner: () => {
      ctx.ui.banner.newTerritory = ctx.battle.snapshotTerritory();
      ctx.ui.banner.newWalls = snapshotAllWalls(state);
    },
  });
}

export function handleBuildStartTransition(
  msg: ServerMessage,
  ctx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.BUILD_START) return;
  const state = ctx.getState();
  const myPlayerId = ctx.getMyPlayerId();
  const buildReceivedAt = ctx.now();
  executeTransition(BUILD_START_STEPS, {
    showBanner: () =>
      showBuildPhaseBanner(ctx.ui.showBanner, BANNER_REPAIR_ONLINE, () => {
        ctx.ui.watcherTiming.phaseStartTime =
          buildReceivedAt + ctx.ui.bannerDuration * 1000;
        ctx.ui.watcherTiming.phaseDuration = state.timer;
        ctx.setMode(Mode.GAME);
      }),
    reconcileState: () => {
      ctx.checkpoint.applyBuildStart(msg);
      setPhase(state, Phase.WALL_BUILD);
    },
    initControllers: () => {
      if (myPlayerId >= 0) {
        const player = state.players[myPlayerId];
        if (player && !player.eliminated) {
          ctx.getControllers()[myPlayerId]?.startBuild(state);
        }
      }
    },
  });
}

export function handleBuildEndTransition(
  msg: ServerMessage,
  ctx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.BUILD_END) return;
  const state = ctx.getState();
  // Capture pre-scores before checkpoint overwrites them (needed for score delta animation)
  const preScores = state.players.map((p) => p.score);
  ctx.checkpoint.applyPlayers(state, msg.players);
  for (let i = 0; i < state.players.length; i++) {
    state.players[i]!.score = msg.scores[i] ?? state.players[i]!.score;
  }
  for (const pid of [...msg.needsReselect, ...msg.eliminated]) {
    const zone = state.playerZones[pid];
    if (zone !== undefined) ctx.endPhase.resetZoneState(state, zone);
  }
  // Shared build-end sequence: score deltas → onLifeLost → dialog.
  // Without the score-delta delay, non-host sends life_lost_choice before
  // host creates its dialog.
  const myPlayerId = ctx.getMyPlayerId();
  runBuildEndSequence({
    needsReselect: msg.needsReselect,
    eliminated: msg.eliminated,
    showScoreDeltas: (onDone) =>
      ctx.endPhase.showScoreDeltas(preScores, onDone),
    notifyLifeLost: (pid) => {
      if (pid === myPlayerId) ctx.getControllers()[pid]?.onLifeLost();
    },
    showLifeLostDialog: ctx.endPhase.showLifeLostDialog,
    // No afterLifeLostResolved — watcher waits for host's next phase message
  });
}

export function handleGameOverTransition(
  msg: ServerMessage,
  ctx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.GAME_OVER) return;
  ctx.endPhase.setGameOverFrame({
    winner: msg.winner ?? NO_WINNER_NAME,
    scores: msg.scores.map((s, i) => ({
      ...s,
      color:
        ctx.endPhase.playerColors[i % ctx.endPhase.playerColors.length]!.wall,
    })),
    focused: FOCUS_REMATCH,
  });
  ctx.ui.render();
  ctx.setMode(Mode.STOPPED);
}
