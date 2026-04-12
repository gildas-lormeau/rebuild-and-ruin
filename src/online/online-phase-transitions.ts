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
import type { BannerShow } from "../runtime/runtime-contracts.ts";
import type { WatcherTimingState } from "../runtime/runtime-tick-context.ts";
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
} from "../runtime/runtime-transition-steps.ts";
import { snapshotAllWalls } from "../shared/core/board-occupancy.ts";
import type { ModifierDiff } from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import { TILE_COUNT } from "../shared/core/grid.ts";
import { modifierDef } from "../shared/core/modifier-defs.ts";
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
  ui: {
    showBanner: BannerShow;
    banner: {
      prevSceneImageData?: ImageData;
      wallsBeforeSweep?: Set<number>[];
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

  // Capture scene before checkpoint mutates state.
  transitionCtx.ui.banner.prevSceneImageData = transitionCtx.ui.captureScene();
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

  executeTransition(CANNON_START_STEPS, {
    applyCheckpoint: () => {
      setPhase(state, Phase.CANNON_PLACE);
      state.timer = state.cannonPlaceTimer;
    },
    initControllers: initLocalController,
    showBanner: () =>
      showCannonPhaseBanner(transitionCtx.ui.showBanner, () => {
        // Anchor phase timer at banner-end wall clock (see helper contract).
        setWatcherPhaseTimerAtBannerEnd(
          transitionCtx.ui.watcherTiming,
          state.timer,
        );
        transitionCtx.setMode(Mode.GAME);
      }),
  });
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

  executeTransition(BATTLE_START_STEPS, {
    showBanner: () => {
      if (modifierDiff) {
        transitionCtx.ui.banner.modifierDiff = modifierDiff;
        showModifierRevealBanner(
          transitionCtx.ui.showBanner,
          modifierDef(modifierDiff.id).label,
          () => {
            // Capture post-modifier scene for the chained battle banner.
            transitionCtx.ui.banner.prevSceneImageData =
              transitionCtx.ui.captureScene();
            showBattlePhaseBanner(transitionCtx.ui.showBanner, proceedToBattle);
          },
        );
      } else {
        showBattlePhaseBanner(transitionCtx.ui.showBanner, proceedToBattle);
      }
    },
    applyCheckpoint: () => {
      transitionCtx.checkpoint.applyBattleStart(msg);
      // Recompute territory from checkpoint walls (post-sweep) on the watcher's
      // pre-modifier map. Matches the host's recheckTerritory in
      // enterBattleFromCannon. Territory becomes stale again after
      // applyCheckpointModifierTiles (inside the checkpoint) mutates map tiles.
      recomputeAllTerritory(state);
      setPhase(state, Phase.BATTLE);
    },
    snapshotForBanner: () => {
      // Populate battleAnim territory/walls so the live scene above the
      // sweep line renders battle territory.
      const postTerritory = transitionCtx.battleLifecycle.snapshotTerritory();
      const postWalls = snapshotAllWalls(state);
      transitionCtx.battleLifecycle.setTerritory(postTerritory);
      transitionCtx.battleLifecycle.setWalls(postWalls);
    },
  });
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
  const showBannerAndEnterBuild = () => {
    // prevSceneImageData was already captured before the checkpoint applied.
    // The upgrade dialog is an overlay — the build banner's old scene should
    // show the battle map, not the dialog.
    executeTransition(BUILD_START_STEPS, {
      showBanner: () =>
        showBuildPhaseBanner(transitionCtx.ui.showBanner, () => {
          // Anchor phase timer at banner-end wall clock (see helper contract).
          setWatcherPhaseTimerAtBannerEnd(
            transitionCtx.ui.watcherTiming,
            state.timer,
          );
          // Deferred clear of the upgrade-pick dialog (host-side path is
          // in `runtime-phase-ticks.ts:enterBuildViaUpgradePick`). The
          // dialog stays in state through the build banner sweep so
          // `drawUpgradePick` can progressively clip it against `banner.y`.
          transitionCtx.clearUpgradePickDialog?.();
          transitionCtx.setMode(Mode.GAME);
        }),
      applyCheckpoint: NOOP_STEP,
      initControllers: () => {
        if (isActivePlayer(myPlayerId)) {
          const player = state.players[myPlayerId];
          if (isPlayerAlive(player)) {
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

  // Capture scene before checkpoint mutates state.
  transitionCtx.ui.banner.prevSceneImageData = transitionCtx.ui.captureScene();

  let preScores: number[] = [];
  transitionCtx.checkpoint.applyBuildEnd(msg, () => {
    // Stash pre-sweep walls so the live scene keeps showing walls during
    // score delta animation (between finalize and the cannon banner).
    transitionCtx.ui.banner.wallsBeforeSweep = state.players.map(
      (player) => new Set(player.walls),
    );
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
