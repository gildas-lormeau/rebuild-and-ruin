import { MESSAGE, type ServerMessage } from "../../server/protocol.ts";
import { createCastle } from "../game/castle-generation.ts";
import {
  BANNER_BATTLE_ONLINE,
  BANNER_REPAIR_ONLINE,
  type BannerShow,
  capturePrevBattleScene,
  snapshotCastles,
  snapshotEntities,
} from "../game/phase-banner.ts";
import {
  initControllerForCannonPhase,
  resetZoneState,
  setPhase,
} from "../game/phase-setup.ts";
import {
  BATTLE_START_STEPS,
  BUILD_START_STEPS,
  CANNON_START_STEPS,
  executeTransition,
  gateUpgradePick,
  NOOP_STEP,
  runBuildEndSequence,
  showBattlePhaseBanner,
  showBuildPhaseBanner,
  showCannonPhaseBanner,
  showModifierRevealBanner,
} from "../game/phase-transition-steps.ts";
import { snapshotAllWalls } from "../shared/board-occupancy.ts";
import type {
  BattleStartData,
  BuildStartData,
  CannonStartData,
  SerializedPlayer,
} from "../shared/checkpoint-data.ts";
import { FOCUS_REMATCH, type GameOverFocus } from "../shared/dialog-types.ts";
import { Phase } from "../shared/game-phase.ts";
import { TILE_COUNT } from "../shared/grid.ts";
import type { CastleData } from "../shared/overlay-types.ts";
import { isActivePlayer, type ValidPlayerSlot } from "../shared/player-slot.ts";
import type { PlayerController } from "../shared/system-interfaces.ts";
import type { RGB } from "../shared/theme.ts";
import type { WatcherTimingState } from "../shared/tick-context.ts";
import { type GameState } from "../shared/types.ts";
import { Mode } from "../shared/ui-mode.ts";
import type { OnlineSession } from "./online-session.ts";
import { setWatcherPhaseTimer } from "./online-types.ts";

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
  ui: {
    showBanner: BannerShow;
    banner: {
      newTerritory?: Set<number>[];
      newWalls?: Set<number>[];
      prevCastles?: CastleData[];
      prevTerritory?: Set<number>[];
      prevWalls?: Set<number>[];
      prevEntities?: import("../shared/overlay-types.ts").EntityOverlay;
      wallsBeforeSweep?: Set<number>[];
      modifierDiff?: import("../shared/game-constants.ts").ModifierDiff;
    };
    render: () => void;
    watcherTiming: WatcherTimingState;
    bannerDuration: number;
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
    applyBuildStart: (data: BuildStartData) => void;
    applyBuildEnd: (
      state: GameState,
      players: readonly SerializedPlayer[],
      scores: readonly number[],
      capturePreState?: () => void,
    ) => void;
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
    /** Battle-start territory snapshot (for banner old-scene rendering). */
    getTerritory: () => Set<number>[];
    /** Battle-start wall snapshot (for banner old-scene rendering). */
    getWalls: () => Set<number>[];
    /** Initiate the battle countdown.  Goes through beginHostBattle which
     *  handles initBattleState, countdown, watcher timing, aimAtEnemyCastle, and
     *  Mode.GAME — so the banner callback doesn't need to duplicate any of it. */
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
}

/** Watcher-only: processes CASTLE_WALLS from host (triggers castle build animation). */
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
export function handleCannonStartTransition(
  msg: ServerMessage,
  transitionCtx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.CANNON_START) return;
  const state = transitionCtx.getState();
  const myPlayerId = transitionCtx.session.myPlayerId;
  transitionCtx.selection.clearSelectionOverlay();

  // prevCastles is already pre-captured in handleBuildEndTransition (pre-sweep walls).
  transitionCtx.checkpoint.applyCannonStart(msg, () => {
    transitionCtx.ui.banner.prevEntities = snapshotEntities(state);
  });

  const initLocalController = () => {
    if (isActivePlayer(myPlayerId)) {
      const ctrl = transitionCtx.getControllers()[myPlayerId];
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
      showCannonPhaseBanner(transitionCtx.ui.showBanner, () => {
        // Timer starts at banner-end wall clock. Safe to use now() because
        // no intermediate dialog (unlike build, which has upgrade-pick) can
        // delay the callback after the banner animation begins.
        setWatcherPhaseTimer(
          transitionCtx.ui.watcherTiming,
          performance.now(),
          state.timer,
        );
        transitionCtx.setMode(Mode.GAME);
      }),
  });
}

/** Watcher-only: processes BATTLE_START checkpoint and transitions to battle phase. */
export function handleBattleStartTransition(
  msg: ServerMessage,
  transitionCtx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.BATTLE_START) return;
  const state = transitionCtx.getState();
  const battleFlights = msg.flights;

  // Pre-capture old scene before checkpoint replaces state (banner ??= keeps it)
  transitionCtx.ui.banner.prevEntities = snapshotEntities(state);

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

  executeTransition(BATTLE_START_STEPS, {
    showBanner: () => {
      if (modifierDiff) {
        transitionCtx.ui.banner.modifierDiff = modifierDiff;
        showModifierRevealBanner(
          transitionCtx.ui.showBanner,
          modifierDiff.label,
          () => {
            showBattlePhaseBanner(
              transitionCtx.ui.showBanner,
              BANNER_BATTLE_ONLINE,
              proceedToBattle,
            );
          },
        );
      } else {
        showBattlePhaseBanner(
          transitionCtx.ui.showBanner,
          BANNER_BATTLE_ONLINE,
          proceedToBattle,
        );
      }
    },
    applyCheckpoint: () => {
      transitionCtx.checkpoint.applyBattleStart(msg);
      setPhase(state, Phase.BATTLE);
    },
    snapshotForBanner: () => {
      transitionCtx.ui.banner.newTerritory =
        transitionCtx.battleLifecycle.snapshotTerritory();
      transitionCtx.ui.banner.newWalls = snapshotAllWalls(state);
    },
  });
}

/** Watcher-only: processes BUILD_START checkpoint and transitions to build phase. */
export function handleBuildStartTransition(
  msg: ServerMessage,
  transitionCtx: TransitionContext,
): void {
  if (msg.type !== MESSAGE.BUILD_START) return;
  const state = transitionCtx.getState();
  const myPlayerId = transitionCtx.session.myPlayerId;

  // Pre-capture old battle scene before checkpoint mutates state
  capturePrevBattleScene(
    transitionCtx.ui.banner,
    state,
    transitionCtx.battleLifecycle.getTerritory(),
    transitionCtx.battleLifecycle.getWalls(),
  );

  // Step 1: apply checkpoint (deserializes offers, modifier, players)
  transitionCtx.checkpoint.applyBuildStart(msg);
  setPhase(state, Phase.WALL_BUILD);

  // Step 2→3: upgrade pick (if any) → build banner → game
  const showBannerAndEnterBuild = () => {
    // Compute timer start NOW (after upgrade pick resolved, not at message receipt).
    // CONTRAST with cannon (handleCannonStartTransition): cannon uses now() inside
    // the banner callback because no dialog precedes it. Here, an upgrade-pick dialog
    // may delay showBannerAndEnterBuild, so we capture bannerStartedAt when the banner
    // actually begins and add its duration to get the phase-timer origin.
    const bannerStartedAt = performance.now();
    executeTransition(BUILD_START_STEPS, {
      showBanner: () =>
        showBuildPhaseBanner(
          transitionCtx.ui.showBanner,
          BANNER_REPAIR_ONLINE,
          () => {
            setWatcherPhaseTimer(
              transitionCtx.ui.watcherTiming,
              bannerStartedAt + transitionCtx.ui.bannerDuration * 1000,
              state.timer,
            );
            transitionCtx.setMode(Mode.GAME);
          },
        ),
      applyCheckpoint: NOOP_STEP,
      initControllers: () => {
        if (isActivePlayer(myPlayerId)) {
          const player = state.players[myPlayerId];
          if (player && !player.eliminated) {
            transitionCtx.getControllers()[myPlayerId]?.startBuildPhase(state);
          }
        }
      },
    });
  };

  gateUpgradePick(
    transitionCtx.ui.showBanner,
    transitionCtx.upgradePick?.tryShow,
    !!state.modern?.pendingUpgradeOffers,
    showBannerAndEnterBuild,
    transitionCtx.upgradePick?.prepare,
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

  let preScores: number[] = [];
  transitionCtx.checkpoint.applyBuildEnd(state, msg.players, msg.scores, () => {
    // Pre-capture old scene before checkpoint applies the wall sweep.
    // The host stashes wallsBeforeSweep before sweeping; the watcher must
    // do the same so walls stay visible until the cannon-start banner.
    transitionCtx.ui.banner.wallsBeforeSweep = state.players.map(
      (player) => new Set(player.walls),
    );
    transitionCtx.ui.banner.prevCastles = snapshotCastles(state);
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
