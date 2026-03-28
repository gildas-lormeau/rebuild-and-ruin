import {
  MESSAGE,
  type SerializedPlayer,
  type ServerMessage,
} from "../server/protocol.ts";
import { snapshotAllWalls } from "./board-occupancy.ts";
import { createCastle } from "./castle-generation.ts";
import type { PlayerController } from "./controller-interfaces.ts";
import { setPhase } from "./game-engine.ts";
import type { RGB } from "./geometry-types.ts";
import { TILE_COUNT } from "./grid.ts";
import type { WatcherTimingState } from "./online-types.ts";
import { BANNER_PLACE_CANNONS, type BannerShow } from "./phase-banner.ts";
import { NO_WINNER_NAME } from "./player-config.ts";
import {
  FOCUS_REMATCH,
  type GameOverFocus,
  type GameState,
  Mode,
  Phase,
} from "./types.ts";

/** Exported for headless testing (test/scenario-helpers.ts). */
export interface TransitionContext {
  getState: () => GameState;
  getMyPlayerId: () => number;
  getControllers: () => PlayerController[];
  showBanner: BannerShow;
  banner: {
    newTerritory?: Set<number>[];
    newWalls?: Set<number>[];
    pendingOldWalls?: Set<number>[];
  };
  clearSelectionOverlay: () => void;
  now: () => number;

  /** Mutable watcher timing — written directly by transition handlers. */
  watcherTiming: WatcherTimingState;
  /** Set the runtime mode (GAME, CASTLE_BUILD, BALLOON_ANIM, STOPPED). */
  setMode: (mode: Mode) => void;

  // Constants
  battleCountdown: number;
  bannerDuration: number;
  playerColors: ReadonlyArray<{ wall: RGB }>;

  // Checkpoint appliers
  applyCannonStartData: (msg: ServerMessage) => void;
  applyBattleStartData: (msg: ServerMessage) => void;
  applyBuildStartData: (msg: ServerMessage) => void;
  applyPlayersCheckpoint: (
    state: GameState,
    players: readonly SerializedPlayer[],
  ) => void;
  resetZoneState: (state: GameState, zone: number) => void;

  // Castle build
  finalizeCastleConstruction: (state: GameState) => void;
  enterCannonPlacePhase: (state: GameState) => void;
  getSelectionStates: () => Map<
    number,
    { highlighted: number; confirmed: boolean }
  >;
  setCastleBuildFromPlans: (
    plans: readonly { playerId: number; tiles: number[] }[],
    maxTiles: number,
    onDone: () => void,
  ) => void;
  setCastleBuildViewport: (
    plans: readonly { playerId: number; tiles: number[] }[],
  ) => void;

  // Battle flights
  setBattleFlights: (
    value: readonly {
      flight: { startX: number; startY: number; endX: number; endY: number };
      progress: number;
    }[],
  ) => void;
  snapshotTerritory: () => Set<number>[];

  // Battle
  /** Position battle crosshair (first battle: best enemy; subsequent: restore last position). */
  aimAtEnemyCastle?: () => void;

  // Life-lost / game over
  showLifeLostDialog: (
    needsReselect: readonly number[],
    eliminated: readonly number[],
  ) => void;
  /** Show score delta animation, calling onDone when complete (or immediately if no deltas). */
  showScoreDeltas: (preScores: readonly number[], onDone: () => void) => void;
  render: () => void;
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
}

const BANNER_BATTLE_ONLINE = "Battle!";
const BANNER_REPAIR_ONLINE = "Repair!";

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
  ctx.getSelectionStates().clear();
  ctx.clearSelectionOverlay();
  // Zoom to the local player's castle on mobile
  const myPlan = plans.find((p) => p.playerId === ctx.getMyPlayerId());
  if (myPlan) ctx.setCastleBuildViewport([myPlan]);

  ctx.setCastleBuildFromPlans(plans, maxTiles, () => {
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
  ctx.clearSelectionOverlay();
  // Stash pre-checkpoint walls so the banner old scene shows pre-sweep walls
  ctx.banner.pendingOldWalls = snapshotAllWalls(state);
  ctx.applyCannonStartData(msg);
  if (myPlayerId >= 0) {
    const ctrl = ctx.getControllers()[myPlayerId];
    const player = state.players[myPlayerId];
    if (ctrl && player && !player.eliminated) {
      const max = state.cannonLimits[myPlayerId] ?? 0;
      ctrl.placeCannons(state, max);
    }
    if (ctrl && player?.homeTower) {
      ctrl.cannonCursor = {
        row: player.homeTower.row,
        col: player.homeTower.col,
      };
    }
    ctrl?.onCannonPhaseStart(state);
  }
  if (state.phase !== Phase.CANNON_PLACE) {
    setPhase(state, Phase.CANNON_PLACE);
    state.timer = state.cannonPlaceTimer;
    ctx.showBanner(
      BANNER_PLACE_CANNONS,
      () => {
        ctx.watcherTiming.phaseStartTime = ctx.now();
        ctx.watcherTiming.phaseDuration = state.timer;
        ctx.setMode(Mode.GAME);
      },
      true,
    );
  }
}

export function handleBattleStartTransition(
  msg: ServerMessage,
  ctx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.BATTLE_START) return;
  const state = ctx.getState();
  const myPlayerId = ctx.getMyPlayerId();
  const battleReceivedAt = ctx.now();
  const battleFlights = msg.flights;

  ctx.showBanner(
    BANNER_BATTLE_ONLINE,
    () => {
      if (myPlayerId >= 0) {
        const ctrl = ctx.getControllers()[myPlayerId];
        if (ctrl) ctrl.resetBattle(state);
      }
      ctx.aimAtEnemyCastle?.();
      if (battleFlights && battleFlights.length > 0) {
        ctx.setBattleFlights(
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
        state.battleCountdown = ctx.battleCountdown;
        ctx.watcherTiming.countdownStartTime =
          battleReceivedAt + ctx.bannerDuration * 1000;
        ctx.watcherTiming.countdownDuration = ctx.battleCountdown;
        ctx.setMode(Mode.GAME);
      }
    },
    true,
  );

  ctx.applyBattleStartData(msg);
  setPhase(state, Phase.BATTLE);

  // Set post-checkpoint walls/territory so the banner's new scene shows
  // clean grass instead of debris for swept walls.
  ctx.banner.newTerritory = ctx.snapshotTerritory();
  ctx.banner.newWalls = snapshotAllWalls(state);
  state.battleCountdown = ctx.battleCountdown;
}

export function handleBuildStartTransition(
  msg: ServerMessage,
  ctx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.BUILD_START) return;
  const state = ctx.getState();
  const myPlayerId = ctx.getMyPlayerId();
  const buildReceivedAt = ctx.now();
  ctx.showBanner(
    BANNER_REPAIR_ONLINE,
    () => {
      ctx.watcherTiming.phaseStartTime =
        buildReceivedAt + ctx.bannerDuration * 1000;
      ctx.watcherTiming.phaseDuration = state.timer;
      ctx.setMode(Mode.GAME);
    },
    true,
  );

  ctx.applyBuildStartData(msg);
  setPhase(state, Phase.WALL_BUILD);
  if (myPlayerId >= 0) {
    ctx.getControllers()[myPlayerId]?.startBuild(state);
  }
}

export function handleBuildEndTransition(
  msg: ServerMessage,
  ctx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.BUILD_END) return;
  const state = ctx.getState();
  // Capture pre-scores before checkpoint overwrites them (needed for score delta animation)
  const preScores = state.players.map((p) => p.score);
  ctx.applyPlayersCheckpoint(state, msg.players);
  for (let i = 0; i < state.players.length; i++) {
    state.players[i]!.score = msg.scores[i] ?? state.players[i]!.score;
  }
  for (const pid of [...msg.needsReselect, ...msg.eliminated]) {
    const zone = state.playerZones[pid];
    if (zone !== undefined) ctx.resetZoneState(state, zone);
  }
  // Show score deltas first (matches host timing), then life-lost dialog.
  // Without this delay, non-host sends life_lost_choice before host creates its dialog.
  ctx.showScoreDeltas(preScores, () => {
    if (msg.needsReselect.length > 0 || msg.eliminated.length > 0) {
      ctx.showLifeLostDialog(msg.needsReselect, msg.eliminated);
    }
  });
}

export function handleGameOverTransition(
  msg: ServerMessage,
  ctx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.GAME_OVER) return;
  ctx.setGameOverFrame({
    winner: msg.winner ?? NO_WINNER_NAME,
    scores: msg.scores.map((s, i) => ({
      ...s,
      color: ctx.playerColors[i % ctx.playerColors.length]!.wall,
    })),
    focused: FOCUS_REMATCH,
  });
  ctx.render();
  ctx.setMode(Mode.STOPPED);
}
