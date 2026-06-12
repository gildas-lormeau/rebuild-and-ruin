import type { GameOverOutcome } from "../../game/index.ts";
import {
  advanceBattleCountdown,
  allCannonPlaceDone,
  canPlayerBuild,
  emitBattleCeaseIfTimerCrossed,
  tickBattlePhase as engineTickBattlePhase,
  enterBuildSkippingBattle,
  markCannonPlaceDoneAtDrain,
  moveGrunts,
  nextReadyCannon,
  primeControllerForCannonPhase,
  resetCannonFacings,
  setBattleCountdown,
  shouldSkipBattle,
  tickBuildUpgrades,
  wallBuildTimerMax,
} from "../../game/index.ts";
import { DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS } from "../../shared/core/action-schedule.ts";
import {
  ageImpacts,
  type Crosshair,
  clearImpacts,
  WALL_BURN_DURATION,
} from "../../shared/core/battle-types.ts";
import { isHuman } from "../../shared/core/controller-guards.ts";
import {
  BALLOON_FLIGHT_DURATION,
  BATTLE_COUNTDOWN,
  BATTLE_TIMER,
  IMPACT_FLASH_DURATION,
  MODIFIER_REVEAL_TIMER,
} from "../../shared/core/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../../shared/core/game-event-bus.ts";
import { Phase } from "../../shared/core/game-phase.ts";
import type { TileKey } from "../../shared/core/grid.ts";
import {
  type CannonPhantomPayload,
  cannonPhantomKey,
  type PiecePhantomPayload,
  piecePhantomKey,
} from "../../shared/core/phantom-types.ts";
import type { ValidPlayerId } from "../../shared/core/player-slot.ts";
import { isPlayerEliminated } from "../../shared/core/player-types.ts";
import {
  type CannonController,
  type PlayerController,
} from "../../shared/core/system-interfaces.ts";
import type { GameState } from "../../shared/core/types.ts";
import { WALL_DESTROY_ANIM_DURATION } from "../../shared/core/wall-destroy-anim.ts";
import type { UpgradePickDialogState } from "../../shared/ui/interaction-types.ts";
import { Mode } from "../../shared/ui/ui-mode.ts";
import type { BannerShow } from "../banner-state.ts";
import {
  clearBalloonFlights,
  recordBattleVisualEvents,
  tickBalloonFlights,
} from "../battle-anim.ts";
import {
  forceResolveRoundEndPhase,
  forceResolveUpgradePickPhase,
  type PhaseTransitionCtx,
  runTransition,
} from "../phase-machine.ts";
import { assertStateInstalled, type RuntimeState, setMode } from "../state.ts";
import {
  advancePhaseTimer,
  isRemotePlayer,
  localControllers,
  tickGruntsIfDue,
} from "../tick-context.ts";
import {
  ACCUM_BATTLE,
  ACCUM_BUILD,
  ACCUM_CANNON,
  ACCUM_GRUNT,
  ACCUM_MODIFIER_REVEAL,
  resetAccum,
} from "../timer-accums.ts";
import type { OnlinePhaseTicks, RuntimeConfig } from "../types.ts";
import type { RuntimeLifeLost } from "./life-lost.ts";

interface PhaseTicksDeps extends Pick<RuntimeConfig, "log"> {
  runtimeState: RuntimeState;
  // Pre-built typed-payload senders — protocol knowledge stays in the
  // composition root. For local play these close over the config's no-op
  // network.send; for online they prepend the message type and send.
  // Only the phantom previews and the cannon-done flag broadcast from
  // here — placement broadcasts go through the `OnlineActions` wrappers
  // on the human-input path, never through phase ticks.
  sendOpponentCannonPhantom: (msg: CannonPhantomPayload) => void;
  sendOpponentPhantom: (msg: PiecePhantomPayload) => void;
  /** Broadcast "I'm done placing cannons" for a local human-kind slot.
   *  No-op for local play; emits `OPPONENT_CANNON_PHASE_DONE` online with
   *  the lockstep `applyAt` already stamped so the originator's local
   *  enqueue and the receiver's wire-receipt enqueue land on the same
   *  logical sim tick. */
  sendOpponentCannonPhaseDone: (
    playerId: ValidPlayerId,
    applyAt: number,
  ) => void;

  /** Online coordination bag — see `OnlinePhaseTicks`. Undefined for local
   *  play; every field is independently optional within the bag itself. */
  online?: OnlinePhaseTicks;

  // Sibling systems / parent callbacks
  requestRender: () => void;
  /** Prime the banner's pre-mutation prev-scene — threaded through to
   *  `PhaseTransitionCtx` so `runTransition` captures it at the dispatch
   *  tick, before the mutate. See `BannerSystem.primePrevScene`. */
  primeBannerPrevScene: () => void;
  /** Cosmetic viewport hard-cut to fullMapVp at transition dispatch —
   *  threaded through to `PhaseTransitionCtx`. See
   *  `RuntimeCamera.snapToFullMapForTransition`. */
  snapCameraToFullMap: () => void;
  /** Run `cb` after the in-flight pitch animation completes — threaded
   *  through to `PhaseTransitionCtx` so `proceedToBattleFromCtx`'s postDisplay
   *  can gate balloon-anim entry on the build→battle tilt-in completing.
   *  See `RuntimeCamera.awaitPitchSettled`. */
  awaitPitchSettled: (callback: () => void) => void;
  /** Show a full-screen banner. `onDone` fires once when the sweep
   *  completes. Sequencing banners is the phase machine's job — each
   *  display step invokes its own `showBanner` in the display sequence;
   *  the prev-scene snapshot is threaded in from `runTransition`, and
   *  `showBanner` captures the matching new-scene snapshot itself. */
  showBanner: BannerShow;
  /** Hide the current banner. The phase machine's display runner
   *  threads this through to non-banner steps and to end-of-sequence
   *  cleanup. Banner steps overwrite via `showBanner` and never need
   *  to hide explicitly. */
  hideBanner: () => void;
  lifeLost: Pick<RuntimeLifeLost, "show" | "forceResolveAll">;
  /** Handlers called after the life-lost dialog resolves. `onGameOver`
   *  dispatches the game-over transition; `onReselect` seeds the
   *  reselect queue and enters the castle-reselect flow; `onAdvance`
   *  dispatches `advance-to-cannon`. Wired identically on every peer —
   *  each routes its own dialog resolution locally. */
  lifeLostRoute: {
    onGameOver: (outcome: GameOverOutcome) => void;
    onReselect: (continuing: readonly ValidPlayerId[]) => void;
    onAdvance: () => void;
  };
  scoreDelta: {
    setPreScores: (scores: readonly number[]) => void;
    show: (onDone: () => void) => void;
    reset: () => void;
    finishNow: () => void;
  };
  /** Save human crosshair at end of battle so it can be restored next battle. */
  saveBattleCrosshair?: () => void;
  /** Called after beginBattle completes (crosshair override, etc.). */
  onBeginBattle?: () => void;
  /** Upgrade-pick hook bag — both functions are wired together or not
   *  at all. Grouping them into a single optional field encodes that
   *  invariant at the type level, so the `upgradePick` ctx object can be
   *  assembled without non-null assertions.
   *  - `prepare`: pre-create the dialog for progressive reveal during banner.
   *  - `tryShow`: show upgrade pick overlay. Returns true if shown (caller
   *    should defer Mode.GAME). `onResolved(resolved)` fires when all
   *    picks are resolved, carrying the finalized dialog snapshot. The
   *    subsystem clears its own dialog state before invoking the
   *    callback; the phase machine applies the picks against the
   *    snapshot. Mirrors `lifeLost.show`'s callback-driven resolution. */
  upgradePick?: {
    prepare: () => boolean;
    tryShow: (
      onResolved: (resolved: UpgradePickDialogState) => void,
    ) => boolean;
    /** Host-promotion repair — see `UpgradePickSystem.forceResolveAll`. */
    forceResolveAll: () => UpgradePickDialogState | null;
  };
  /** End-game side effects (set game-over frame, stop sound, switch to
   *  Mode.STOPPED, arm demo timer). Wired to `lifecycle.endGame` from
   *  composition. The machine's `game-over` mutate calls this through
   *  `ctx.endGame`. */
  endGame: (winner: { id: ValidPlayerId }) => void;
  /** Request an immediate untilt ease at battle-end. Called every tick
   *  while the phase-ticks system waits for `getPitchState() === "flat"`
   *  before firing the battle-done banner capture. */
  beginUntilt: () => void;
  /** Pitch state machine. Gates the battle-done transition so the
   *  banner snapshot captures a flat scene — `tickBattlePhase` returns
   *  false until this reads `"flat"`. There is no timeout: the wait
   *  can't hang because the camera's pitch ease is a fixed tick-driven
   *  ease advanced every substep, and `beginUntilt` is re-requested
   *  each tick. */
  getPitchState: () => "flat" | "tilting" | "tilted" | "untilting";
  /** Snap every cannon's eased displayed facing to its rest target.
   *  Called once at battle-end (after `resetCannonFacings`, after the
   *  camera untilt settles) so the build banner's prev-scene snapshot
   *  captures cannons at rest. Render-only: the battle-done transition is
   *  NOT gated on the cosmetic rotation ease — cannon facing must never
   *  drive game-flow timing. Sourced from
   *  `subsystems/cannon-animator.ts`'s `snapToRest`. */
  snapCannonRotationToRest: () => void;
  /** Drop the renderer's per-cannon barrel-recoil pitch so every barrel
   *  paints at rest from the next frame on. Called at battle-end after
   *  `resetCannonFacings`, before the BATTLE → WALL_BUILD transition,
   *  so the recoil decay (~2s) doesn't leak across the phase boundary
   *  as visible micro-rotation. Undefined for renderers without a
   *  barrel-pitch animation (2D, headless stub). */
  snapCannonBarrelsToRest?: () => void;
  /** Start the build→battle tilt. Called from `proceedToBattleFromCtx` at
   *  battle-banner end. */
  beginTilt: () => void;
  /** Fire-and-forget renderer hook to pre-link shadow-pass shader
   *  programs. Threaded through to `PhaseTransitionCtx.warmShadowPermutations`
   *  and called from `enter-cannon-place`'s postDisplay. Undefined for renderers
   *  without a 3D pipeline (2D, headless stub). See the comment on the
   *  ctx field for the BATTLE-entry hitch this avoids. */
  warmShadowPermutations?: () => Promise<void>;
}

/** Public phase-ticks handle exposed on `GameRuntime`. Narrow surface —
 *  most callers go through the orchestrator, not the handle. Sole
 *  consumer: host promotion (`promote.ts`). */
export interface RuntimePhaseTicks {
  /** Force the UPGRADE_PICK phase to its conclusion (state-derived picks
   *  applied, `enter-wall-build` dispatched). Host-promotion repair —
   *  see `forceResolveUpgradePickPhase` in phase-machine.ts. */
  resolveUpgradePickNow: () => void;
  /** Skip the battle intro (balloon flyover) and run `beginBattle`.
   *  Host-promotion repair — promotion landing in the battle-entry
   *  display windows (banner sweep, post-banner tilt wait, balloon
   *  flyover) tears down the step that owned the intro, so controller
   *  battle-state init, the ready countdown, the battle accum reset,
   *  and the Mode.GAME flip never run. See promote.ts
   *  `skipPendingAnimations`. */
  skipBattleIntro: () => void;
  /** Fast-forward the round-end display chain (score overlay + life-lost
   *  dialog) to its routed conclusion. Host-promotion repair — see
   *  `forceResolveRoundEndPhase` in phase-machine.ts. */
  resolveRoundEndNow: () => void;
}

export interface PhaseTicksSystem {
  /** Dispatch the `advance-to-cannon` prep transition (post-life-lost
   *  continue path). The mutate runs `finalizeRoundCleanup` only — the
   *  phase entry is owned by the routed `enter-cannon-place`. */
  dispatchAdvanceToCannon: () => void;
  /** Host-promotion repair — see `RuntimePhaseTicks.resolveUpgradePickNow`. */
  resolveUpgradePickNow: () => void;
  /** Host-promotion repair — see `RuntimePhaseTicks.skipBattleIntro`. */
  skipBattleIntro: () => void;
  /** Host-promotion repair — see `RuntimePhaseTicks.resolveRoundEndNow`. */
  resolveRoundEndNow: () => void;
  /** Dispatch the `castle-done` prep transition. Used by both the round-1
   *  initial-selection path and the reselect cycle. The mutate runs
   *  `finalizeRoundCleanup` (gated on `round > 1` because round 1 has no
   *  prior round to clean up after — cleanup-deferral, not cycle-type) +
   *  `finalizeFreshCastles` + `finalizeCastleConstruction`, then routes
   *  to `enter-cannon-place`. */
  dispatchCastleDone: () => void;
  /** Dispatch the `game-over` transition; the mutate logs the outcome's
   *  reason and calls `ctx.endGame(winner)`. */
  dispatchGameOver: (outcome: GameOverOutcome) => void;
  startBattle: () => void;
  tickBalloonAnim: (dt: number) => void;
  startBuildPhase: () => void;
  tickCannonPhase: (dt: number) => boolean;
  tickBattleCountdown: (dt: number) => void;
  tickBattlePhase: (dt: number) => boolean;
  tickBuildPhase: (dt: number) => boolean;
  tickGame: (dt: number) => void;
  /** Decay the migration/disconnect announcement banner. Mode-independent
   *  — called from the composition root's `tickMode` for every tickable
   *  mode, not just Mode.GAME (announcements are set by wire handlers in
   *  any mode). */
  tickOnlineAnnouncement: (dt: number) => void;
  syncCrosshairs: (weaponsActive: boolean, dt: number) => void;
}

export function createPhaseTicksSystem(deps: PhaseTicksDeps): PhaseTicksSystem {
  const { runtimeState } = deps;
  const online = deps.online;

  // -------------------------------------------------------------------------
  // Crosshairs
  // -------------------------------------------------------------------------

  function syncCrosshairs(weaponsActive: boolean, dt: number): void {
    const remotePlayerSlots = runtimeState.frameMeta.remotePlayerSlots;
    const { state, controllers } = runtimeState;
    const crosshairs: Crosshair[] = [];

    for (const ctrl of controllers) {
      if (isRemotePlayer(ctrl.playerId, remotePlayerSlots)) continue;
      if (isPlayerEliminated(state.players[ctrl.playerId])) continue;
      const readyCannon = nextReadyCannon(state, ctrl.playerId);
      const anyReloading =
        !readyCannon &&
        state.cannonballs.some(
          (ball) =>
            ball.playerId === ctrl.playerId ||
            ball.scoringPlayerId === ctrl.playerId,
        );
      if (!readyCannon && !anyReloading) continue;
      const ch = ctrl.getCrosshair();
      crosshairs.push({
        x: ch.x,
        y: ch.y,
        playerId: ctrl.playerId,
        cannonReady: weaponsActive && !!readyCannon,
      });
      // Per-controller fan-out — the hook self-gates by ownership (only
      // emits for the local human, not for AIs which every peer recomputes).
      online?.broadcastLocalCrosshair?.(ctrl, ch, !!readyCannon);
    }

    runtimeState.frame.crosshairs = crosshairs;
    if (online?.extendCrosshairs) {
      runtimeState.frame.crosshairs = online.extendCrosshairs(
        runtimeState.frame.crosshairs,
        dt,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Cannon phase
  // -------------------------------------------------------------------------

  function dispatchAdvanceToCannon() {
    runTransition("advance-to-cannon", buildPhaseCtx());
  }

  function dispatchCastleDone() {
    runTransition("castle-done", buildPhaseCtx());
  }

  function dispatchGameOver(outcome: GameOverOutcome) {
    runTransition("game-over", {
      ...buildPhaseCtx(),
      gameOverOutcome: outcome,
    });
  }

  // -------------------------------------------------------------------------
  // Battle
  // -------------------------------------------------------------------------

  function startBattle() {
    const { state } = runtimeState;
    if (shouldSkipBattle(state)) {
      runTransition("ceasefire", buildPhaseCtx());
      return;
    }
    runTransition("cannon-place-done", buildPhaseCtx());
  }

  /** Single `PhaseTransitionCtx` factory shared by every call site
   *  (advance-to-cannon, ceasefire, cannon-place-done, battle-done,
   *  round-end, castle-done, game-over) and run on every peer — the only
   *  host-gated field is `broadcast`; everything else is populated
   *  unconditionally (clone-everywhere model).
   *
   *  Every hook any mutate/postDisplay might need is populated. Hooks the
   *  active transition doesn't read are inert — the cost of including
   *  them is one closure allocation per `runTransition` call. */
  function buildPhaseCtx(): PhaseTransitionCtx {
    const remotePlayerSlots = runtimeState.frameMeta.remotePlayerSlots;
    const local = localControllers(runtimeState.controllers, remotePlayerSlots);
    const isHost = runtimeState.frameMeta.hostAtFrameStart;
    const { battleAnim } = runtimeState;
    return {
      state: runtimeState.state,
      runtimeState,
      showBanner: deps.showBanner,
      hideBanner: deps.hideBanner,
      primeBannerPrevScene: deps.primeBannerPrevScene,
      snapCameraToFullMap: deps.snapCameraToFullMap,
      setMode: (mode) => setMode(runtimeState, mode),
      log: deps.log,
      scoreDelta: deps.scoreDelta,
      battle: {
        setFlights: (flights) => {
          battleAnim.flights = [...flights];
        },
        setTerritory: (territory) => {
          battleAnim.territory = territory.map((set) => new Set<TileKey>(set));
        },
        setWalls: (walls) => {
          battleAnim.walls = walls.map((set) => new Set<TileKey>(set));
        },
        clearImpacts: () => clearImpacts(battleAnim),
        begin: beginBattle,
      },
      initLocalCannonControllers: () => {
        resetAccum(runtimeState.accum, ACCUM_CANNON);
        for (const ctrl of runtimeState.controllers) {
          if (isRemotePlayer(ctrl.playerId, remotePlayerSlots)) continue;
          primeControllerForCannonPhase(ctrl, runtimeState.state);
        }
      },
      upgradePick: deps.upgradePick
        ? {
            prepare: deps.upgradePick.prepare,
            tryShow: deps.upgradePick.tryShow,
            forceResolveAll: deps.upgradePick.forceResolveAll,
          }
        : undefined,
      ceasefireSkipBattle: () => enterBuildSkippingBattle(runtimeState.state),
      startBuildPhaseLocal: startBuildPhase,
      endBattleLocalControllers: () => {
        for (const ctrl of local) ctrl.endBattle();
      },
      saveBattleCrosshair: deps.saveBattleCrosshair,
      awaitPitchSettled: deps.awaitPitchSettled,
      beginTilt: deps.beginTilt,
      warmShadowPermutations: deps.warmShadowPermutations,
      lifeLost: {
        show: deps.lifeLost.show,
        forceResolveAll: deps.lifeLost.forceResolveAll,
      },
      lifeLostRoute: deps.lifeLostRoute,
      notifyLifeLost: (pid) => {
        if (!isRemotePlayer(pid, remotePlayerSlots)) {
          runtimeState.controllers[pid]!.onLifeLost();
        }
      },
      finalizeLocalControllersBuildPhase: () => {
        for (const ctrl of local) {
          ctrl.finalizeBuildPhase(runtimeState.state);
        }
      },
      endGame: deps.endGame,
      broadcast: isHost
        ? {
            cannonStart: () => online?.broadcastCannonStart?.(),
            battleStart: () => online?.broadcastBattleStart?.(),
            buildStart: () => online?.broadcastBuildStart?.(),
            buildEnd: () => online?.broadcastBuildEnd?.(),
          }
        : undefined,
    };
  }

  function tickBalloonAnim(dt: number) {
    const { allDone } = tickBalloonFlights(
      runtimeState.battleAnim,
      dt,
      BALLOON_FLIGHT_DURATION,
    );
    deps.requestRender();
    if (allDone) {
      emitGameEvent(runtimeState.state.bus, GAME_EVENT.BALLOON_ANIM_END, {
        round: runtimeState.state.round,
      });
      beginBattle();
    }
  }

  function beginBattle() {
    const remotePlayerSlots = runtimeState.frameMeta.remotePlayerSlots;
    for (const ctrl of localControllers(
      runtimeState.controllers,
      remotePlayerSlots,
    )) {
      if (isPlayerEliminated(runtimeState.state.players[ctrl.playerId]))
        continue;
      ctrl.initBattleState(runtimeState.state);
    }
    // Go through setBattleCountdown so the jump from 0 → BATTLE_COUNTDOWN
    // emits the initial `battleReady` bus event — without this the voice
    // line for "Ready" never fires (the tick-driven transitions only
    // catch Ready→Aim and Aim→Fire crossings during countdown decay).
    setBattleCountdown(runtimeState.state, BATTLE_COUNTDOWN);
    resetAccum(runtimeState.accum, ACCUM_BATTLE);
    setMode(runtimeState, Mode.GAME);
    deps.onBeginBattle?.();
  }

  // -------------------------------------------------------------------------
  // Build phase
  // -------------------------------------------------------------------------

  function startBuildPhase() {
    const remotePlayerSlots = runtimeState.frameMeta.remotePlayerSlots;
    deps.log(`startBuildPhase (round=${runtimeState.state.round})`);
    deps.scoreDelta.reset();
    if (runtimeState.state.phase !== Phase.WALL_BUILD) {
      throw new Error("startBuildPhase called outside WALL_BUILD");
    }
    for (const ctrl of runtimeState.controllers) {
      if (isRemotePlayer(ctrl.playerId, remotePlayerSlots)) continue;
      if (isPlayerEliminated(runtimeState.state.players[ctrl.playerId]))
        continue;
      ctrl.startBuildPhase(runtimeState.state);
    }
    clearImpacts(runtimeState.battleAnim);
    resetAccum(runtimeState.accum, ACCUM_GRUNT);
    resetAccum(runtimeState.accum, ACCUM_BUILD);
  }

  // -------------------------------------------------------------------------
  // Tick wrappers
  // -------------------------------------------------------------------------

  function tickCannonPhase(dt: number): boolean {
    const remotePlayerSlots = runtimeState.frameMeta.remotePlayerSlots;
    const { state } = runtimeState;
    const local = localControllers(runtimeState.controllers, remotePlayerSlots);

    advancePhaseTimer(
      runtimeState.accum,
      ACCUM_CANNON,
      state,
      dt,
      state.cannonPlaceTimer,
    );

    // PASS 1: tick local controllers, broadcast own-human's cannon phantom.
    // AI cannon placements are deterministic from strategy.rng + state — every
    // peer recomputes them locally, no wire payload (see project rule
    // "wire = uncomputable inputs only"). Human placements broadcast from
    // inside the placement callback, not here. The phantom hook self-gates
    // by ownership so only the local-human's cursor preview hits the wire.
    for (const ctrl of local) {
      if (isPlayerEliminated(state.players[ctrl.playerId])) continue;
      const phantom = ctrl.cannonTick(state, dt);
      // Detect newly-done local controllers — mark in shared per-slot state
      // and broadcast for human-kind so remote peers (whose `local` excludes
      // this slot and so never observes its `isCannonPhaseDone`) can mirror
      // the done flag and exit the phase in lockstep. AI controllers are
      // deterministic across peers; their done-ness is already mirrored
      // implicitly so no broadcast needed.
      const max = state.cannonLimits[ctrl.playerId] ?? 0;
      if (
        !state.cannonPlaceDone.has(ctrl.playerId) &&
        !state.pendingCannonPlaceDone.has(ctrl.playerId) &&
        ctrl.isCannonPhaseDone(state, max)
      ) {
        if (isHuman(ctrl)) {
          // Lockstep: schedule the `cannonPlaceDone.add` for `applyAt` on
          // both originator and receiver so the phase-exit predicate
          // (`allCannonPlaceDone`) flips on the same simTick everywhere.
          // Without this, the originator marks done at simTick=N while
          // the receiver only sees it at simTick=N+wireDelay, letting one
          // peer exit CANNON_PLACE first and drift state.rng cross-peer
          // through the post-cannon-place transition (modifier roll,
          // grunt spawn).
          const playerId = ctrl.playerId;
          const applyAt = state.simTick + DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS;
          state.pendingCannonPlaceDone.add(playerId);
          runtimeState.actionSchedule.schedule({
            applyAt,
            playerId,
            apply: (drainState) =>
              markCannonPlaceDoneAtDrain(drainState, playerId),
          });
          deps.sendOpponentCannonPhaseDone(playerId, applyAt);
        } else {
          // AI: clone-everywhere → both peers detect identically; immediate
          // add stays in lockstep without scheduling.
          state.cannonPlaceDone.add(ctrl.playerId);
        }
      }
      if (!phantom) continue;
      if (!isHuman(ctrl)) continue;
      if (
        !(
          online?.shouldSendCannonPhantom?.(
            ctrl.playerId,
            cannonPhantomKey(phantom),
          ) ?? false
        )
      ) {
        continue;
      }
      deps.sendOpponentCannonPhantom({
        playerId: ctrl.playerId,
        row: phantom.row,
        col: phantom.col,
        mode: phantom.mode,
        valid: phantom.valid,
      });
    }

    // Remote phantoms live on each remote-controlled slot's controller
    // (`currentCannonPhantom`), written by the inbound network handler.
    // Render reads them via `buildCannonPhantomsUnion`.

    deps.requestRender();

    // Exit predicate: every non-eliminated slot must be in `cannonPlaceDone`.
    // Local slots flip the bit above; remote-driven slots flip it via the
    // wire (`OPPONENT_CANNON_PHASE_DONE`). Same predicate runs on every
    // peer — no `local`-subset early exit. Parallels SELECT's
    // `allSelectionsConfirmed` (per-slot Map) and the dialog phases'
    // `tickDialogWithFallback` allResolved return (per-entry choice).
    if (state.timer > 0 && !allCannonPlaceDone(state)) return false;

    // PASS 2: finalize controllers for phase transition.
    // Local vs remote use different finalize entry points — the helpers
    // below encode the split so the two paths cannot be merged.
    const remote = runtimeState.controllers.filter((ctrl) =>
      isRemotePlayer(ctrl.playerId, remotePlayerSlots),
    );
    for (const ctrl of remote) finalizeRemoteCannonController(ctrl, state);
    for (const ctrl of local) finalizeLocalCannonController(ctrl, state);
    startBattle();
    return true;
  }

  /** MODIFIER_REVEAL phase tick. The phase has no game-mechanics
   *  content — it exists purely to hold the modifier-reveal banner on
   *  screen for a beat before battle begins. `enter-modifier-reveal`'s
   *  mutate set `state.timer = MODIFIER_REVEAL_TIMER`; we decrement it
   *  here and dispatch `enter-battle` when it expires. Same on every
   *  peer — clone-everywhere model means each peer drives the timer
   *  itself, no network message is exchanged for this edge. */
  function tickModifierRevealPhase(dt: number): boolean {
    advancePhaseTimer(
      runtimeState.accum,
      ACCUM_MODIFIER_REVEAL,
      runtimeState.state,
      dt,
      MODIFIER_REVEAL_TIMER,
    );
    deps.requestRender();
    if (runtimeState.state.timer > 0) return false;
    resetAccum(runtimeState.accum, ACCUM_MODIFIER_REVEAL);
    runTransition("enter-battle", buildPhaseCtx());
    return true;
  }

  function tickBattleCountdown(dt: number): void {
    const remotePlayerSlots = runtimeState.frameMeta.remotePlayerSlots;
    runtimeState.frame.announcement = advanceBattleCountdown(
      runtimeState.state,
      dt,
    );
    for (const ctrl of localControllers(
      runtimeState.controllers,
      remotePlayerSlots,
    )) {
      if (isPlayerEliminated(runtimeState.state.players[ctrl.playerId]))
        continue;
      ctrl.battleTick(runtimeState.state, dt);
    }
    syncCrosshairs(/* weaponsActive */ false, dt);
    deps.requestRender();
  }

  function tickBattlePhase(dt: number): boolean {
    const remotePlayerSlots = runtimeState.frameMeta.remotePlayerSlots;
    const local = localControllers(runtimeState.controllers, remotePlayerSlots);
    const { state, battleAnim } = runtimeState;

    const prevTimer = state.timer;
    advancePhaseTimer(
      runtimeState.accum,
      ACCUM_BATTLE,
      state,
      dt,
      BATTLE_TIMER,
    );
    emitBattleCeaseIfTimerCrossed(state, prevTimer);

    // Weapons are locked once the timer has expired AND the last ball has
    // landed — no more aiming, firing, or crosshair motion. Controllers
    // therefore skip their battleTick (crosshair motion); the cannon-
    // animator then computes the rest facing once weapons go inactive.
    const weaponsActive = state.timer > 0 || state.cannonballs.length > 0;

    // Controller ticks (pass 1) must precede engine combat (pass 2): new
    // cannonballs spawned during `battleTick` need to exist before the
    // engine advances them and resolves hits on the same frame. Both run
    // locally on every peer — AI fires are deterministic from strategy.rng
    // + state, human fires broadcast CANNON_FIRED via the human-input path.
    if (weaponsActive) tickLocalBattleControllers(local, state, dt);
    const result = engineTickBattlePhase(state, dt);

    // Record visuals from the same combat result, on every peer. The bus
    // must not drive runtime-affecting state — battleAnim.* gates the
    // battle-end transition.
    recordBattleVisualEvents(result, battleAnim, state);

    // Haptics is handled by the haptics observer subsystem (bus subscriber).

    syncCrosshairs(weaponsActive, dt);
    deps.requestRender();

    if (state.timer > 0 || state.cannonballs.length > 0) return false;
    // Safe margin: let impact flashes, ice-thaw, wall-burn, and shield-
    // flash animations finish before capturing the "old scene" snapshot
    // for the Build banner. Without this, mid-animation explosion/thaw/
    // burn/flash visuals bake into the prev-scene image. For
    // destroyedWalls we gate only on the fire-burst window
    // (`age < WALL_DESTROY_ANIM_DURATION + WALL_BURN_DURATION`); the
    // sink + dust + tail-fade beyond that point is continuous visual state
    // — fine to capture mid-anim — and the entry itself lives the full
    // `IMPACT_ENTRY_LIFETIME`. shieldFlashes (Reinforced-Walls hit flash,
    // 0.5s) matters on wirings where pitch is already flat at battle end
    // (2D renderer) — on the 3D path the 0.6s untilt below would absorb
    // it, but the gate keeps the snapshot clean on every wiring.
    if (
      battleAnim.impacts.length > 0 ||
      battleAnim.thawing.length > 0 ||
      battleAnim.destroyedWalls.some(
        (wall) => wall.age < WALL_DESTROY_ANIM_DURATION + WALL_BURN_DURATION,
      ) ||
      battleAnim.cannonDestroys.length > 0 ||
      battleAnim.gruntKills.length > 0 ||
      battleAnim.houseDestroys.length > 0 ||
      battleAnim.shieldFlashes.length > 0
    )
      return false;

    // Set the cannons' rest target (toward enemy territory). The cannon-
    // animator eases displayed → target cosmetically over the following
    // frames; we deliberately DO NOT gate the transition on that ease.
    // Cannon facing is render-only state and must never drive game-flow
    // timing (gating battle-done on the eased displayed value made the
    // BATTLE phase last a facing-angle-dependent number of frames). The
    // rotation plays out during the deterministic camera-untilt window
    // below; any residual is snapped to rest just before the snapshot.
    resetCannonFacings(state);
    // Snap barrel recoil pitch to rest. Barrel pitch lives in the renderer
    // and has a ~2s decay tail from the last shot — without this snap, the
    // residual ease leaks across into WALL_BUILD as visible micro-rotation
    // on the cannon barrels. Idempotent + safe here: the in-flight-
    // cannonballs / animation gates above guarantee no ball is mid-flight,
    // so the next frame's `applyFiringTargets` can't re-arm a recoil target.
    deps.snapCannonBarrelsToRest?.();

    // Pre-banner untilt: trigger the camera to ease pitch → 0 and wait for
    // it to settle BEFORE the battle-done transition runs. Otherwise the
    // banner's prev-scene snapshot bakes in the tilted view and the
    // untilt then plays under the banner (visible flat-flash then
    // re-tilt on next-phase enter). The untilt window is a fixed ease
    // (constant tilt angle) → deterministic, unlike the old rotation gate.
    deps.beginUntilt();
    if (deps.getPitchState() !== "flat") return false;

    // Guarantee cannons paint at their rest facing in the banner's prev-
    // scene snapshot. The untilt window above eases most of the way; this
    // snaps any remaining delta (e.g. a 180° flip that outlasts the
    // untilt). Render-only — no effect on game state or determinism.
    deps.snapCannonRotationToRest();

    runTransition("battle-done", buildPhaseCtx());
    return true;
  }

  function tickBuildPhase(dt: number): boolean {
    const remotePlayerSlots = runtimeState.frameMeta.remotePlayerSlots;
    const { state, accum } = runtimeState;
    const local = localControllers(runtimeState.controllers, remotePlayerSlots);

    // --- Engine tick (advance upgrade-effect timers; timerMax = base +
    // upgrade bonus + drained supply-ship seconds — see wallBuildTimerMax) ---
    tickBuildUpgrades(state, dt);
    advancePhaseTimer(accum, "build", state, dt, wallBuildTimerMax(state));

    // --- PASS 1: Tick local controllers, broadcast own-human's piece phantom ---
    // AI piece placements are deterministic from strategy.rng + state — every
    // peer recomputes them locally, no wire payload (see project rule
    // "wire = uncomputable inputs only"). Human placements broadcast from
    // inside the placement callback. Only the own-human's *phantom* (cursor
    // preview) is sent — the phantom hook self-gates by ownership.
    for (const ctrl of local) {
      if (isPlayerEliminated(state.players[ctrl.playerId])) continue;
      if (!canPlayerBuild(state, ctrl.playerId)) continue;
      const phantoms = ctrl.buildTick(state, dt);

      if (!isHuman(ctrl)) continue;
      for (const phantom of phantoms) {
        if (
          !(
            online?.shouldSendPiecePhantom?.(
              phantom.playerId,
              piecePhantomKey(phantom),
            ) ?? false
          )
        ) {
          continue;
        }
        deps.sendOpponentPhantom({
          playerId: phantom.playerId,
          row: phantom.row,
          col: phantom.col,
          offsets: phantom.offsets,
          valid: phantom.valid,
        });
      }
    }

    // Remote phantoms live on each remote-controlled slot's controller
    // (`currentBuildPhantoms`), written by the inbound network handler.
    // Render reads them via `buildPiecePhantomsUnion`.

    // Grunt movement runs AFTER local controllers place walls so host and
    // watcher see the same wall set when grunts step. Under the clone-
    // everywhere model both peers run this same `tickGruntsIfDue`; wire-
    // received placements are applied via `actionSchedule.drainUpTo` at
    // the top of `runOneSubStep`, before phase ticks fire. The drain-
    // before-grunts ordering is what keeps state-dependent RNG draws
    // (recheckTerritory → grunt enclosure) identical across peers.
    tickGruntsIfDue(accum, dt, state, moveGrunts);

    deps.requestRender();
    if (state.timer > 0) return false;

    // --- End of phase: delegate to the round-end transition ---
    runTransition("round-end", buildPhaseCtx());
    return true;
  }

  // -------------------------------------------------------------------------
  // tickGame — dispatches to the correct phase tick
  // -------------------------------------------------------------------------

  /** Canonical state-ready guard — all phase ticks funnel through here,
   *  so a single assertion covers cannon, battle, build, and balloon ticks.
   *  Same code runs on every peer (clone-everywhere): each peer simulates
   *  the full game from synced state + RNG; the wire only carries
   *  uncomputable inputs (human input). */
  function tickGame(dt: number) {
    assertStateInstalled(runtimeState);
    // Age and filter impact flashes regardless of phase
    ageImpacts(runtimeState.battleAnim, dt, IMPACT_FLASH_DURATION);

    switch (runtimeState.state.phase) {
      case Phase.CANNON_PLACE:
        tickCannonPhase(dt);
        break;
      case Phase.BATTLE:
        if (runtimeState.state.battleCountdown > 0) {
          tickBattleCountdown(dt);
        } else {
          tickBattlePhase(dt);
        }
        break;
      case Phase.WALL_BUILD:
        tickBuildPhase(dt);
        break;
      case Phase.MODIFIER_REVEAL:
        // Real timed phase — its banner's sweep-end flips mode to GAME
        // (see `enter-modifier-reveal.postDisplay`), then this branch
        // decrements `state.timer` and dispatches `enter-battle` when it
        // expires. Both peers run the same timer locally; no network
        // message is exchanged for the edge.
        tickModifierRevealPhase(dt);
        break;
      case Phase.UPGRADE_PICK:
      case Phase.CASTLE_SELECT:
        // UPGRADE_PICK runs in Mode.UPGRADE_PICK (not Mode.GAME);
        // castle-select runs in Mode.SELECTION.
        // tickGame never reaches these branches while those phases
        // are active. Explicit no-ops for exhaustiveness.
        break;
    }
  }

  /** Decay the migration/disconnect announcement banner. Called from the
   *  composition root's `tickMode` for EVERY tickable mode — the wire
   *  handlers set announcements at arbitrary moments (HOST_LEFT during
   *  SELECTION, PLAYER_LEFT mid-dialog), and a Mode.GAME-only decay froze
   *  the banner on screen until the next gameplay phase. */
  function tickOnlineAnnouncement(dt: number): void {
    online?.tickMigrationAnnouncement?.(dt);
  }

  return {
    dispatchAdvanceToCannon,
    resolveUpgradePickNow: () => forceResolveUpgradePickPhase(buildPhaseCtx()),
    resolveRoundEndNow: () => forceResolveRoundEndPhase(buildPhaseCtx()),
    skipBattleIntro: () => {
      clearBalloonFlights(runtimeState.battleAnim);
      beginBattle();
    },
    dispatchCastleDone,
    dispatchGameOver,
    startBattle,
    tickBalloonAnim,
    startBuildPhase,
    tickCannonPhase,
    tickBattleCountdown,
    tickBattlePhase,
    tickBuildPhase,
    tickGame,
    tickOnlineAnnouncement,
    syncCrosshairs,
  };
}

/** Finalize a LOCAL controller at the end of cannon phase.
 *  Local controllers own an auto-placement queue that must be flushed before
 *  `initCannons` runs the round-1 safety net, so this routes through
 *  `finalizeCannonPhase` which guarantees flush → init order. Calling
 *  `initCannons` directly on a local controller would skip the flush and
 *  corrupt cannon state. */
function finalizeLocalCannonController(
  ctrl: CannonController & { readonly playerId: ValidPlayerId },
  state: GameState,
): void {
  const maxSlots = state.cannonLimits[ctrl.playerId] ?? 0;
  ctrl.finalizeCannonPhase(state, maxSlots);
}

/** Finalize a REMOTE controller at the end of cannon phase.
 *  Remote controllers' cannons were already flushed client-side before the
 *  wire placements arrived, so only the round-1 safety-net init is needed
 *  here. Calling `finalizeCannonPhase` would re-run the flush against an
 *  empty local queue — a no-op today, but it couples the remote path to
 *  local-only queue semantics and is explicitly not the contract. */
function finalizeRemoteCannonController(
  ctrl: CannonController & { readonly playerId: ValidPlayerId },
  state: GameState,
): void {
  const maxSlots = state.cannonLimits[ctrl.playerId] ?? 0;
  ctrl.initCannons(state, maxSlots);
}

/** Pass 1 of the battle-phase tick: tick every local controller and collect
 *  fire events for the cannonballs they spawned this frame. AI-origin fires
 *  only — human-driven controllers (including AssistedHuman) emit their own
 *  CANNON_FIRED via the human action path, so re-emitting here would
 *  double-spawn on the receiver. Must run BEFORE `resolveBattleCombatStep`
 *  so the engine advances the newly-spawned balls the same frame; the data
 *  flow (return → parameter) is what enforces that order. */
function tickLocalBattleControllers(
  local: readonly PlayerController[],
  state: GameState,
  dt: number,
): void {
  for (const ctrl of local) {
    if (isPlayerEliminated(state.players[ctrl.playerId])) continue;
    ctrl.battleTick(state, dt);
  }
}
