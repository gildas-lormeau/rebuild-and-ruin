import type { ServerMessage } from "../server/protocol.ts";
import type { BannerShow } from "./battle-ticks.ts";
import { BANNER_PLACE_CANNONS } from "./game-engine.ts";
import { FOCUS_REMATCH, type GameOverFocus } from "./game-ui-types.ts";
import type { SerializedPlayer } from "./online-serialize.ts";
import type { RGB } from "./player-config.ts";
import type { PlayerController } from "./player-controller.ts";
import type { GameState } from "./types.ts";
import { Phase } from "./types.ts";

const BANNER_BATTLE_ONLINE = "Battle!";
const BANNER_REPAIR_ONLINE = "Repair!";

// ---------------------------------------------------------------------------
// Shared context for all watcher phase transitions
// ---------------------------------------------------------------------------

export interface TransitionContext {
  getState: () => GameState;
  getMyPlayerId: () => number;
  getControllers: () => PlayerController[];
  showBanner: BannerShow;
  clearSelectionOverlay: () => void;
  now: () => number;

  // Watcher timing
  setWatcherPhaseStartTime: (value: number) => void;
  setWatcherPhaseDuration: (value: number) => void;
  setWatcherCountdownStartTime: (value: number) => void;
  setWatcherCountdownDuration: (value: number) => void;

  // Mode setters
  setModeGame: () => void;
  setModeCastleBuild: () => void;
  setModeBalloonAnim: () => void;
  setModeStopped: () => void;

  // Constants
  battleCountdown: number;
  bannerDuration: number;
  playerColors: ReadonlyArray<{ wall: RGB }>;

  // Checkpoint appliers
  applyCannonStartData: (msg: ServerMessage) => void;
  applyBattleStartData: (msg: ServerMessage) => void;
  applyBuildStartData: (msg: ServerMessage) => void;
  applyPlayersCheckpoint: (state: GameState, players: SerializedPlayer[]) => void;
  resetZoneState: (state: GameState, zone: number) => void;

  // Castle build
  finalizeCastleConstruction: (state: GameState) => void;
  enterCannonPlacePhase: (state: GameState) => void;
  getSelectionStates: () => Map<number, { highlighted: number; confirmed: boolean }>;
  setCastleBuildFromPlans: (
    plans: { playerId: number; tiles: number[] }[],
    maxTiles: number,
    onDone: () => void,
  ) => void;
  setCastleBuildViewport: (plans: { playerId: number; tiles: number[] }[]) => void;

  // Battle flights
  setBattleFlights: (value: { flight: { startX: number; startY: number; endX: number; endY: number }; progress: number }[]) => void;
  snapshotTerritory: () => Set<number>[];

  // Life-lost / game over
  showLifeLostDialog: (needsReselect: number[], eliminated: number[]) => void;
  render: () => void;
  setGameOverFrame: (payload: { winner: string; scores: { name: string; score: number; color: RGB; eliminated: boolean; territory?: number; stats?: { wallsDestroyed: number; cannonsKilled: number } }[]; focused: GameOverFocus }) => void;
}

// ---------------------------------------------------------------------------
// Transition handlers
// ---------------------------------------------------------------------------

export function handleCastleWallsTransition(msg: ServerMessage, ctx: TransitionContext): void {
  if (msg.type !== "castle_walls") return;
  const state = ctx.getState();
  const plans = msg.plans;
  const maxTiles = Math.max(...plans.map((p) => p.tiles.length), 0);
  ctx.getSelectionStates().clear();
  ctx.clearSelectionOverlay();
  // Zoom to the local player's castle on mobile
  const myPlan = plans.find(p => p.playerId === ctx.getMyPlayerId());
  if (myPlan) ctx.setCastleBuildViewport([myPlan]);

  ctx.setCastleBuildFromPlans(plans, maxTiles, () => {
    ctx.finalizeCastleConstruction(state);
    ctx.enterCannonPlacePhase(state);
    state.timer = state.cannonPlaceTimer;
    ctx.showBanner(BANNER_PLACE_CANNONS, () => {
      ctx.setWatcherPhaseStartTime(ctx.now());
      ctx.setWatcherPhaseDuration(state.timer);
      ctx.setModeGame();
    });
  });
  ctx.setModeCastleBuild();
}

export function handleCannonStartTransition(msg: ServerMessage, ctx: TransitionContext): void {
  if (msg.type !== "cannon_start") return;
  const state = ctx.getState();
  const myPlayerId = ctx.getMyPlayerId();
  ctx.clearSelectionOverlay();
  ctx.applyCannonStartData(msg);
  if (myPlayerId >= 0) {
    const ctrl = ctx.getControllers()[myPlayerId];
    const player = state.players[myPlayerId];
    if (ctrl && player && !player.eliminated) {
      const max = state.cannonLimits[myPlayerId] ?? 0;
      ctrl.placeCannons(state, max);
    }
    if (ctrl && player?.homeTower) {
      ctrl.cannonCursor = { row: player.homeTower.row, col: player.homeTower.col };
    }
    ctrl?.onCannonPhaseStart(state);
  }
  if (state.phase !== Phase.CANNON_PLACE) {
    state.phase = Phase.CANNON_PLACE;
    state.timer = state.cannonPlaceTimer;
    ctx.showBanner(BANNER_PLACE_CANNONS, () => {
      ctx.setWatcherPhaseStartTime(ctx.now());
      ctx.setWatcherPhaseDuration(state.timer);
      ctx.setModeGame();
    });
  }
}

export function handleBattleStartTransition(msg: ServerMessage, ctx: TransitionContext): void {
  if (msg.type !== "battle_start") return;
  const state = ctx.getState();
  const myPlayerId = ctx.getMyPlayerId();
  const battleReceivedAt = ctx.now();
  const preBattleTerritory = ctx.snapshotTerritory();
  const preBattleWalls = state.players.map((p) => new Set(p.walls));
  const battleFlights = msg.flights;

  ctx.showBanner(
    BANNER_BATTLE_ONLINE,
    () => {
      if (myPlayerId >= 0) {
        const ctrl = ctx.getControllers()[myPlayerId];
        if (ctrl) ctrl.resetBattle(state);
      }
      if (battleFlights && battleFlights.length > 0) {
        ctx.setBattleFlights(
          battleFlights.map((f) => ({
            flight: { startX: f.startX, startY: f.startY, endX: f.endX, endY: f.endY },
            progress: 0,
          })),
        );
        ctx.setModeBalloonAnim();
      } else {
        state.battleCountdown = ctx.battleCountdown;
        ctx.setWatcherCountdownStartTime(battleReceivedAt + ctx.bannerDuration * 1000);
        ctx.setWatcherCountdownDuration(ctx.battleCountdown);
        ctx.setModeGame();
      }
    },
    true,
    { territory: preBattleTerritory, walls: preBattleWalls },
  );

  ctx.applyBattleStartData(msg);
  state.phase = Phase.BATTLE;
  state.battleCountdown = ctx.battleCountdown;
}

export function handleBuildStartTransition(msg: ServerMessage, ctx: TransitionContext): void {
  if (msg.type !== "build_start") return;
  const state = ctx.getState();
  const myPlayerId = ctx.getMyPlayerId();
  const buildReceivedAt = ctx.now();
  ctx.showBanner(
    BANNER_REPAIR_ONLINE,
    () => {
      ctx.setWatcherPhaseStartTime(buildReceivedAt + ctx.bannerDuration * 1000);
      ctx.setWatcherPhaseDuration(state.timer);
      ctx.setModeGame();
    },
    true,
  );

  ctx.applyBuildStartData(msg);
  state.phase = Phase.WALL_BUILD;
  if (myPlayerId >= 0) {
    ctx.getControllers()[myPlayerId]?.startBuild(state);
  }
}

export function handleBuildEndTransition(msg: ServerMessage, ctx: TransitionContext): void {
  if (msg.type !== "build_end") return;
  const state = ctx.getState();
  ctx.applyPlayersCheckpoint(state, msg.players);
  for (let i = 0; i < state.players.length; i++) {
    state.players[i]!.score = msg.scores[i] ?? state.players[i]!.score;
  }
  for (const pid of [...msg.needsReselect, ...msg.eliminated]) {
    const zone = state.playerZones[pid];
    if (zone !== undefined) ctx.resetZoneState(state, zone);
  }
  if (msg.needsReselect.length > 0 || msg.eliminated.length > 0) {
    ctx.showLifeLostDialog(msg.needsReselect, msg.eliminated);
  }
}

export function handleGameOverTransition(msg: ServerMessage, ctx: TransitionContext): void {
  if (msg.type !== "game_over") return;
  ctx.setGameOverFrame({
    winner: msg.winner ?? "Nobody",
    scores: msg.scores.map((s, i) => ({
      ...s,
      color: ctx.playerColors[i % ctx.playerColors.length]!.wall,
    })),
    focused: FOCUS_REMATCH,
  });
  ctx.render();
  ctx.setModeStopped();
}
