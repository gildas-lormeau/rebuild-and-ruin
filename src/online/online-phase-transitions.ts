import {
  createCastle,
  prepareControllerCannonPhase,
  recomputeAllTerritory,
  resetZoneState,
} from "../game/index.ts";
// Deep import: setPhase is a network-state-conformance primitive used inside
// watcher checkpoint apply steps. Allowlisted in
// scripts/lint-restricted-imports.ts.
import { setPhase } from "../game/phase-setup.ts";
import type {
  BattleStartData,
  BuildEndData,
  BuildStartData,
  CannonStartData,
} from "../protocol/checkpoint-data.ts";
import { MESSAGE, type ServerMessage } from "../protocol/protocol.ts";
import type {
  BannerShow,
  BannerTransitions,
} from "../runtime/runtime-contracts.ts";
import type { WatcherTimingState } from "../runtime/runtime-tick-context.ts";
import { runBuildEndSequence } from "../runtime/runtime-transition-steps.ts";
import type { BalloonFlight } from "../shared/core/battle-types.ts";
import { snapshotAllWalls } from "../shared/core/board-occupancy.ts";
import type { ModifierDiff } from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import { TILE_COUNT } from "../shared/core/grid.ts";
import {
  isActivePlayer,
  type ValidPlayerSlot,
} from "../shared/core/player-slot.ts";
import { isPlayerAlive } from "../shared/core/player-types.ts";
import type { PlayerController } from "../shared/core/system-interfaces.ts";
import { type GameState } from "../shared/core/types.ts";
import {
  FOCUS_REMATCH,
  type GameOverFocus,
} from "../shared/ui/interaction-types.ts";
import type { RGB } from "../shared/ui/theme.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import type { OnlineSession } from "./online-session.ts";
import { setWatcherPhaseTimerAtBannerEnd } from "./online-types.ts";

/**
 * Mode-setting timing convention across transition handlers:
 *  - CASTLE_BUILD: setMode immediately (animation starts without banner)
 *  - CANNON_PLACE / WALL_BUILD: setMode inside banner onComplete callback
 *    (game resumes only after banner finishes)
 *  - BATTLE: setMode via BALLOON_ANIM or beginBattle() inside banner callback
 *    (balloon flight plays first if there are flights, otherwise battle begins directly)
 *  - STOPPED (game over): setMode immediately after building game-over frame
 */
export interface TransitionContext {
  // ── Core state access ──
  getState: () => GameState;
  session: Pick<OnlineSession, "myPlayerId">;
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

  // ── Banner & UI ──
  ui: BannerTransitions & {
    showBanner: BannerShow;
    banner: {
      prevSceneImageData?: ImageData;
      modifierDiff?: ModifierDiff;
    };
    /** Capture the current offscreen scene as ImageData for banner prev-scene. */
    captureScene: () => ImageData | undefined;
    render: () => void;
    watcherTiming: WatcherTimingState;
  };

  // ── Checkpoint application ──
  // Each method accepts an optional `capturePreState` callback that runs BEFORE
  // applyPlayersCheckpoint mutates state. Use it to capture pre-state (walls,
  // scores, entities) needed for banner animations — the ordering is guaranteed.
  checkpoint: {
    applyCannonStart: (
      data: CannonStartData,
      capturePreState?: () => void,
    ) => void;
    applyBattleStart: (
      data: BattleStartData,
      capturePreState?: () => void,
    ) => void;
    applyBuildStart: (
      data: BuildStartData,
      capturePreState?: () => void,
    ) => void;
    applyBuildEnd: (data: BuildEndData, capturePreState?: () => void) => void;
  };

  // ── Selection & castle build ──
  selection: {
    clearSelectionOverlay: () => void;
    getStates: () => Map<number, { highlighted: number; confirmed: boolean }>;
    setCastleBuildFromPlans: (
      plans: readonly { playerId: ValidPlayerSlot; tiles: number[] }[],
      maxTiles: number,
      onDone: () => void,
    ) => void;
    setCastleBuildViewport: (
      plans: readonly { playerId: ValidPlayerSlot; tiles: number[] }[],
    ) => void;
  };

  // ── Battle lifecycle ──
  battleLifecycle: {
    setFlights: (
      value: readonly { flight: BalloonFlight; progress: number }[],
    ) => void;
    snapshotTerritory: () => Set<number>[];
    /** Battle-start territory snapshot (for banner old-scene rendering). */
    getTerritory: () => Set<number>[];
    /** Battle-start wall snapshot (for banner old-scene rendering). */
    getWalls: () => Set<number>[];
    /** Update battleAnim territory snapshot (after watcher territory recompute). */
    setTerritory: (territory: readonly Set<number>[]) => void;
    /** Update battleAnim wall snapshot. */
    setWalls: (walls: readonly Set<number>[]) => void;
    /** Initiate the battle countdown.  Handles initBattleState, countdown,
     *  watcher timing, aimAtEnemyCastle, and Mode.GAME — so the banner
     *  callback doesn't need to duplicate any of it. */
    beginBattle: () => void;
  };

  // ── End-of-phase (life-lost, scoring, game over) ──
  endPhase: {
    showLifeLostDialog: (
      needsReselect: readonly ValidPlayerSlot[],
      eliminated: readonly ValidPlayerSlot[],
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

  // ── Upgrade pick (modern mode) ──
  upgradePick?: {
    tryShow: (onDone: () => void) => boolean;
    prepare: () => boolean;
  };
  /** Clear the upgrade-pick dialog state. Called from the build banner's
   *  onDone after the sweep completes — see the host counterpart in
   *  `runtime-phase-ticks.ts:enterBuildViaUpgradePick`. The dialog has to
   *  stay alive through the build banner sweep so `drawUpgradePick` can
   *  progressively clip it against `banner.y`; this callback is what
   *  finally tears it down. */
  clearUpgradePickDialog?: () => void;
}

/** Watcher-only: processes CASTLE_WALLS from host (triggers castle build animation). */
/** Mode timing: setMode(CASTLE_BUILD) immediately. See TransitionContext JSDoc. */
export function handleCastleWallsTransition(
  msg: ServerMessage,
  transitionCtx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.CASTLE_WALLS) return;
  const state = transitionCtx.getState();
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
  transitionCtx.selection.getStates().clear();
  transitionCtx.selection.clearSelectionOverlay();
  // Zoom to the local player's castle on mobile
  const myPlan = plans.find(
    (plan) => plan.playerId === transitionCtx.session.myPlayerId,
  );
  if (myPlan) transitionCtx.selection.setCastleBuildViewport([myPlan]);

  transitionCtx.selection.setCastleBuildFromPlans(plans, maxTiles, () => {
    // No phase transition — cannon_start checkpoint drives it and reconciles state.
  });
  transitionCtx.setMode(Mode.CASTLE_BUILD);
}

/** Watcher-only: processes CANNON_START checkpoint and transitions to cannon phase. */
/** Mode timing: setMode(GAME) inside banner onComplete. See TransitionContext JSDoc. */
export function handleCannonStartTransition(
  msg: ServerMessage,
  transitionCtx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.CANNON_START) return;
  const state = transitionCtx.getState();
  const myPlayerId = transitionCtx.session.myPlayerId;
  transitionCtx.selection.clearSelectionOverlay();

  // Capture the pre-mutation scene for the cannons banner's prev-scene,
  // but only on paths that introduce the mutation here. Rounds 2+ arrive
  // with state.phase === WALL_BUILD (mutation already captured at
  // handleBuildEndTransition before the wall sweep); the CANNON_START
  // checkpoint on that path just flips the phase and adds cannon limits.
  // Round 1 / reselect arrive with state.phase === CASTLE_SELECT or
  // CASTLE_RESELECT — no BUILD_END ran, so the CANNON_START checkpoint
  // itself delivers the first post-finalizeCastleConstruction state
  // (houses, bonus squares), and capturing before applyCannonStart grabs
  // the pre-finalize picture the banner needs to reveal against.
  if (state.phase !== Phase.WALL_BUILD) {
    transitionCtx.ui.banner.prevSceneImageData =
      transitionCtx.ui.captureScene();
  }
  transitionCtx.checkpoint.applyCannonStart(msg);

  const initLocalController = () => {
    if (isActivePlayer(myPlayerId)) {
      const ctrl = transitionCtx.getControllers()[myPlayerId];
      if (!ctrl) return;
      const prep = prepareControllerCannonPhase(ctrl.playerId, state);
      if (!prep) return;
      ctrl.placeCannons(state, prep.maxSlots);
      ctrl.cannonCursor = prep.cursorPos;
      ctrl.startCannonPhase(state);
    }
  };

  // Dedup guard: checkpoint already set the phase (e.g. full-state recovery).
  // Init the local controller but skip the full transition.
  if (state.phase === Phase.CANNON_PLACE) {
    initLocalController();
    return;
  }

  // 1. Banner
  transitionCtx.ui.showCannonTransition(() => {
    setWatcherPhaseTimerAtBannerEnd(
      transitionCtx.ui.watcherTiming,
      state.timer,
    );
    transitionCtx.setMode(Mode.GAME);
  });

  // 2. Checkpoint
  setPhase(state, Phase.CANNON_PLACE);
  state.timer = state.cannonPlaceTimer;

  // 3. Init controllers
  initLocalController();
}

/** Watcher-only: processes BATTLE_START checkpoint and transitions to battle phase. */
/** Mode timing: setMode via BALLOON_ANIM or beginBattle() inside banner callback. See TransitionContext JSDoc. */
export function handleBattleStartTransition(
  msg: ServerMessage,
  transitionCtx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.BATTLE_START) return;
  const state = transitionCtx.getState();
  const battleFlights = msg.flights;

  // Capture scene before checkpoint mutates state.
  transitionCtx.ui.banner.prevSceneImageData = transitionCtx.ui.captureScene();

  const modifierDiff = msg.modifierDiff ?? null;

  const proceedToBattle = () => {
    if (battleFlights && battleFlights.length > 0) {
      transitionCtx.battleLifecycle.setFlights(
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
      transitionCtx.setMode(Mode.BALLOON_ANIM);
    } else {
      transitionCtx.battleLifecycle.beginBattle();
    }
  };

  // 1. Banner (modifier chain handled by the banner system)
  transitionCtx.ui.showBattleTransition(modifierDiff, proceedToBattle);

  // 2. Checkpoint
  transitionCtx.checkpoint.applyBattleStart(msg);
  recomputeAllTerritory(state);
  setPhase(state, Phase.BATTLE);

  // 3. Snapshot territory/walls for battleAnim
  const postTerritory = transitionCtx.battleLifecycle.snapshotTerritory();
  const postWalls = snapshotAllWalls(state);
  transitionCtx.battleLifecycle.setTerritory(postTerritory);
  transitionCtx.battleLifecycle.setWalls(postWalls);
}

/** Watcher-only: processes BUILD_START checkpoint and transitions to build phase.
 *  Mode timing: setMode(GAME) inside banner onComplete. See TransitionContext JSDoc. */
export function handleBuildStartTransition(
  msg: ServerMessage,
  transitionCtx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.BUILD_START) return;
  const state = transitionCtx.getState();
  const myPlayerId = transitionCtx.session.myPlayerId;

  // Capture scene before checkpoint mutates state.
  transitionCtx.ui.banner.prevSceneImageData = transitionCtx.ui.captureScene();

  // Step 1: apply checkpoint (deserializes offers, modifier, players)
  transitionCtx.checkpoint.applyBuildStart(msg);
  setPhase(state, Phase.WALL_BUILD);

  // Step 2→3: upgrade pick (if any) → build banner → game
  transitionCtx.ui.showBuildTransition(
    transitionCtx.upgradePick,
    !!state.modern?.pendingUpgradeOffers,
    () => {
      setWatcherPhaseTimerAtBannerEnd(
        transitionCtx.ui.watcherTiming,
        state.timer,
      );
      transitionCtx.clearUpgradePickDialog?.();
      transitionCtx.setMode(Mode.GAME);
    },
    () => {
      if (isActivePlayer(myPlayerId)) {
        const player = state.players[myPlayerId];
        if (isPlayerAlive(player)) {
          transitionCtx.getControllers()[myPlayerId]?.startBuildPhase(state);
        }
      }
    },
  );
}

/** Handle BUILD_END: apply player checkpoint, show score deltas, then life-lost dialog.
 *
 *  The score-delta animation relies on comparing old scores against the new ones the host
 *  computed. Without the delta delay, the non-host would send life_lost_choice before the
 *  host has created its dialog, causing the choice to be silently dropped. */
export function handleBuildEndTransition(
  msg: ServerMessage,
  transitionCtx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.BUILD_END) return;
  const state = transitionCtx.getState();

  // Capture scene before checkpoint mutates state.
  transitionCtx.ui.banner.prevSceneImageData = transitionCtx.ui.captureScene();

  let preScores: number[] = [];
  transitionCtx.checkpoint.applyBuildEnd(msg, () => {
    preScores = state.players.map((player) => player.score);
  });
  for (const pid of [...msg.needsReselect, ...msg.eliminated]) {
    const zone = state.playerZones[pid];
    if (zone !== undefined) resetZoneState(state, zone);
  }
  // Shared build-end sequence: score deltas → onLifeLost → dialog.
  // Without the score-delta delay, non-host sends life_lost_choice before
  // host creates its dialog.
  const myPlayerId = transitionCtx.session.myPlayerId;
  runBuildEndSequence({
    needsReselect: msg.needsReselect,
    eliminated: msg.eliminated,
    showScoreDeltas: (onDone) =>
      transitionCtx.endPhase.showScoreDeltas(preScores, onDone),
    notifyLifeLost: (pid) => {
      if (pid === myPlayerId) transitionCtx.getControllers()[pid]?.onLifeLost();
    },
    showLifeLostDialog: transitionCtx.endPhase.showLifeLostDialog,
    // No onLifeLostResolved — watcher waits for host's next phase message
  });
}

/** Mode timing: setMode(STOPPED) immediately. See TransitionContext JSDoc. */
export function handleGameOverTransition(
  msg: ServerMessage,
  transitionCtx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.GAME_OVER) return;
  transitionCtx.endPhase.setGameOverFrame({
    winner: msg.winner,
    scores: msg.scores.map((score, i) => ({
      ...score,
      color:
        transitionCtx.endPhase.playerColors[
          i % transitionCtx.endPhase.playerColors.length
        ]!.wall,
    })),
    focused: FOCUS_REMATCH,
  });
  transitionCtx.ui.render();
  transitionCtx.setMode(Mode.STOPPED);
}
