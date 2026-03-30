import { MESSAGE, type ServerMessage } from "../server/protocol.ts";
import { snapshotAllWalls } from "./board-occupancy.ts";
import { createCastle } from "./castle-generation.ts";
import type {
  BattleStartData,
  BuildStartData,
  CannonStartData,
  SerializedPlayer,
} from "./checkpoint-data.ts";
import type { PlayerController } from "./controller-interfaces.ts";
import { initControllerForCannonPhase, setPhase } from "./game-engine.ts";
import type { RGB } from "./geometry-types.ts";
import { TILE_COUNT } from "./grid.ts";
import {
  startWatcherPhaseTimer,
  type WatcherTimingState,
} from "./online-types.ts";
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
  /** Set the UI rendering mode. Valid transitions from phase handlers:
   *  - CASTLE_BUILD — castle wall animation playing
   *  - GAME — normal gameplay (cannon, battle, build phases)
   *  - BALLOON_ANIM — balloon flight animation before battle
   *  - STOPPED — game over
   *
   *  Host promotion (skipPendingAnimations) may also set GAME from
   *  CASTLE_BUILD, LIFE_LOST, BANNER, or BALLOON_ANIM. */
  setMode: (mode: Mode) => void;
  now: () => number;

  // --- Banner & UI ---
  ui: {
    showBanner: BannerShow;
    banner: {
      newTerritory?: Set<number>[];
      newWalls?: Set<number>[];
      oldCastles?: {
        walls: ReadonlySet<number>;
        interior: ReadonlySet<number>;
        cannons: readonly {
          row: number;
          col: number;
          hp: number;
          mode: string;
          facing?: number;
        }[];
        playerId: number;
      }[];
      oldHouses?: { row: number; col: number; zone: number; alive: boolean }[];
      oldBonusSquares?: { row: number; col: number }[];
      pendingOldWalls?: Set<number>[];
    };
    render: () => void;
    watcherTiming: WatcherTimingState;
    bannerDuration: number;
  };

  // --- Checkpoints (protocol-free data types) ---
  checkpoint: {
    applyCannonStart: (data: CannonStartData) => void;
    applyBattleStart: (data: BattleStartData) => void;
    applyBuildStart: (data: BuildStartData) => void;
    applyPlayersCheckpoint: (
      state: GameState,
      players: readonly SerializedPlayer[],
    ) => void;
  };

  // --- Selection & castle build ---
  selection: {
    clearSelectionOverlay: () => void;
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
     *  handles initBattleState, countdown, watcher timing, aimAtEnemyCastle, and
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
  const plans = msg.plans.map((plan) => ({
    ...plan,
    tiles: plan.tiles.filter((tile) => tile >= 0 && tile < TILE_COUNT),
  }));
  const maxTiles = Math.max(...plans.map((plan) => plan.tiles.length), 0);
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
  ctx.selection.clearSelectionOverlay();
  // Zoom to the local player's castle on mobile
  const myPlan = plans.find((plan) => plan.playerId === ctx.getMyPlayerId());
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
  ctx.selection.clearSelectionOverlay();

  // Pre-capture old houses/bonus before checkpoint spawns new ones.
  // oldCastles is already pre-captured in handleBuildEndTransition (pre-sweep walls).
  ctx.ui.banner.oldHouses = state.map.houses.map((h) => ({ ...h }));
  ctx.ui.banner.oldBonusSquares = state.bonusSquares.map((b) => ({ ...b }));

  ctx.checkpoint.applyCannonStart(msg);

  const initLocalController = () => {
    if (myPlayerId >= 0) {
      const ctrl = ctx.getControllers()[myPlayerId];
      if (ctrl) initControllerForCannonPhase(ctrl, state);
    }
  };

  // Dedup guard: checkpoint already set the phase (e.g. full-state recovery).
  // Init the local controller but skip the full transition.
  if (state.phase === Phase.CANNON_PLACE) {
    initLocalController();
    return;
  }

  executeTransition(CANNON_START_STEPS, {
    applyCheckpoint: () => {
      setPhase(state, Phase.CANNON_PLACE);
      state.timer = state.cannonPlaceTimer;
    },
    initControllers: initLocalController,
    showBanner: () =>
      showCannonPhaseBanner(ctx.ui.showBanner, () => {
        startWatcherPhaseTimer(ctx.ui.watcherTiming, ctx.now(), state.timer);
        ctx.setMode(Mode.GAME);
      }),
  });
}

export function handleBattleStartTransition(
  msg: ServerMessage,
  ctx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.BATTLE_START) return;
  const state = ctx.getState();
  const battleFlights = msg.flights;

  // Pre-capture old scene before checkpoint replaces state (banner ??= keeps it)
  ctx.ui.banner.oldHouses = state.map.houses.map((h) => ({ ...h }));
  ctx.ui.banner.oldBonusSquares = state.bonusSquares.map((b) => ({ ...b }));

  executeTransition(BATTLE_START_STEPS, {
    showBanner: () =>
      showBattlePhaseBanner(ctx.ui.showBanner, BANNER_BATTLE_ONLINE, () => {
        if (battleFlights && battleFlights.length > 0) {
          ctx.battle.setFlights(
            battleFlights.map((flight) => ({
              flight: {
                startX: flight.startX,
                startY: flight.startY,
                endX: flight.endX,
                endY: flight.endY,
              },
              progress: 0,
            })),
          );
          ctx.setMode(Mode.BALLOON_ANIM);
        } else {
          ctx.battle.beginBattle();
        }
      }),
    applyCheckpoint: () => {
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

  // Pre-capture old scene before checkpoint replaces state (banner ??= keeps it)
  ctx.ui.banner.oldHouses = state.map.houses.map((h) => ({ ...h }));
  ctx.ui.banner.oldBonusSquares = state.bonusSquares.map((b) => ({ ...b }));

  executeTransition(BUILD_START_STEPS, {
    showBanner: () =>
      showBuildPhaseBanner(ctx.ui.showBanner, BANNER_REPAIR_ONLINE, () => {
        startWatcherPhaseTimer(
          ctx.ui.watcherTiming,
          buildReceivedAt + ctx.ui.bannerDuration * 1000,
          state.timer,
        );
        ctx.setMode(Mode.GAME);
      }),
    applyCheckpoint: () => {
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

/** Handle BUILD_END: apply player checkpoint, show score deltas, then life-lost dialog.
 *
 *  IMPORTANT: `preScores` must be captured BEFORE `applyPlayersCheckpoint` overwrites player state.
 *  The score-delta animation relies on comparing old scores against the new ones the host
 *  computed. Without the delta delay, the non-host would send life_lost_choice before the
 *  host has created its dialog, causing the choice to be silently dropped. */
export function handleBuildEndTransition(
  msg: ServerMessage,
  ctx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.BUILD_END) return;
  const state = ctx.getState();

  // Pre-capture old scene before checkpoint applies the wall sweep.
  // The host stashes pendingOldWalls before sweeping; the watcher must
  // do the same so walls stay visible until the cannon-start banner.
  ctx.ui.banner.pendingOldWalls = state.players.map(
    (player) => new Set(player.walls),
  );
  ctx.ui.banner.oldCastles = state.players
    .filter((player) => player.castle)
    .map((player) => ({
      walls: new Set(player.walls),
      interior: new Set(player.interior),
      cannons: player.cannons.map((cn) => ({ ...cn })),
      playerId: player.id,
    }));

  // Capture pre-scores before checkpoint overwrites them (needed for score delta animation)
  const preScores = state.players.map((player) => player.score);
  ctx.checkpoint.applyPlayersCheckpoint(state, msg.players);
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
    scores: msg.scores.map((score, i) => ({
      ...score,
      color:
        ctx.endPhase.playerColors[i % ctx.endPhase.playerColors.length]!.wall,
    })),
    focused: FOCUS_REMATCH,
  });
  ctx.ui.render();
  ctx.setMode(Mode.STOPPED);
}
