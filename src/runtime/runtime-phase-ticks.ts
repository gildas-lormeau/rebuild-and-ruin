import type { GameOverReason } from "../game/index.ts";
import {
  advanceBattleCountdown,
  allCannonPlaceDone,
  buildTimerBonus,
  canPlayerBuild,
  emitBattleCeaseIfTimerCrossed,
  tickBattlePhase as engineTickBattlePhase,
  enterBuildSkippingBattle,
  moveGrunts,
  nextReadyCannon,
  prepareControllerCannonPhase,
  resetCannonFacings,
  setBattleCountdown,
  shouldSkipBattle,
  tickBuildUpgrades,
} from "../game/index.ts";
import { DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS } from "../shared/core/action-schedule.ts";
import {
  BATTLE_MESSAGE,
  type ImpactEvent,
} from "../shared/core/battle-events.ts";
import {
  ageImpacts,
  type Crosshair,
  clearImpacts,
} from "../shared/core/battle-types.ts";
import {
  BALLOON_FLIGHT_DURATION,
  BATTLE_COUNTDOWN,
  BATTLE_TIMER,
  IMPACT_FLASH_DURATION,
  MODIFIER_REVEAL_TIMER,
} from "../shared/core/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import {
  type CannonPhantomPayload,
  type CannonPlacedPayload,
  cannonPhantomKey,
  type PiecePhantomPayload,
  type PiecePlacedPayload,
  phantomWireMode,
  piecePhantomKey,
} from "../shared/core/phantom-types.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import {
  type CannonController,
  isHuman,
  type PlayerController,
} from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import type { UpgradePickDialogState } from "../shared/ui/interaction-types.ts";
import type { PlayerStats } from "../shared/ui/overlay-types.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import { recordBattleVisualEvents } from "./runtime-battle-anim.ts";
import type { BannerShow, TimingApi } from "./runtime-contracts.ts";
import {
  type PhaseTransitionCtx,
  runTransition,
} from "./runtime-phase-machine.ts";
import {
  assertStateInstalled,
  type RuntimeState,
  setMode,
} from "./runtime-state.ts";
import {
  ACCUM_BATTLE,
  ACCUM_BUILD,
  ACCUM_CANNON,
  ACCUM_GRUNT,
  ACCUM_MODIFIER_REVEAL,
  advancePhaseTimer,
  isRemotePlayer,
  localControllers,
  resetAccum,
  tickGruntsIfDue,
} from "./runtime-tick-context.ts";
import type {
  OnlinePhaseTicks,
  RuntimeConfig,
  RuntimeLifeLost,
} from "./runtime-types.ts";

interface PhaseTicksDeps extends Pick<RuntimeConfig, "log"> {
  runtimeState: RuntimeState;
  /** Injected timing primitives — replaces bare `performance.now()` access. */
  timing: TimingApi;
  /** Network send — closes over RuntimeConfig.network.send at the call site.
   *  Used by `tickBattlePhase` to broadcast raw battle events (fire, tower
   *  damage, impact) which are themselves protocol messages. */
  send: RuntimeConfig["network"]["send"];

  // Pre-built typed-payload senders — protocol knowledge stays in the
  // composition root. For local play these close over the config's no-op
  // network.send; for online they prepend the message type and send.
  sendOpponentCannonPlaced: (msg: CannonPlacedPayload) => void;
  sendOpponentCannonPhantom: (msg: CannonPhantomPayload) => void;
  sendOpponentPiecePlaced: (msg: PiecePlacedPayload) => void;
  sendOpponentPhantom: (msg: PiecePhantomPayload) => void;
  /** Broadcast "I'm done placing cannons" for a local human-kind slot.
   *  No-op for local play; emits `OPPONENT_CANNON_PHASE_DONE` online with
   *  the lockstep `applyAt` already stamped so the originator's local
   *  enqueue and the receiver's wire-receipt enqueue land on the same
   *  logical sim tick. */
  sendOpponentCannonPhaseDone: (
    playerId: ValidPlayerSlot,
    applyAt: number,
  ) => void;

  /** Online coordination bag — see `OnlinePhaseTicks`. Undefined for local
   *  play; every field is independently optional within the bag itself. */
  online?: OnlinePhaseTicks;

  // Sibling systems / parent callbacks
  requestRender: () => void;
  /** Park a post-convergence callback — threaded through to
   *  `PhaseTransitionCtx` so `runTransition` can gate every mutate +
   *  display step on the camera reaching fullMapVp. See
   *  `CameraSystem.onCameraReady`. */
  onCameraReady: (onReady: () => void) => void;
  /** Park a pitch-settle callback — threaded through to
   *  `PhaseTransitionCtx` so `proceedToBattle`'s postDisplay can gate
   *  balloon-anim entry on the build→battle tilt-in completing.
   *  See `CameraSystem.onPitchSettled`. */
  onPitchSettled: (callback: () => void) => void;
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
  lifeLost: Pick<RuntimeLifeLost, "show">;
  /** Handlers called after the life-lost dialog resolves. `onGameOver`
   *  dispatches the game-over transition; `onReselect` seeds the
   *  reselect queue and enters the castle-reselect flow; `onAdvance`
   *  dispatches `advance-to-cannon`. Host-only — watcher path builds
   *  its own route bundle in `online-phase-transitions.ts`. */
  lifeLostRoute: {
    onGameOver: (winner: { id: number }, reason: GameOverReason) => void;
    onReselect: (continuing: readonly ValidPlayerSlot[]) => void;
    onAdvance: () => void;
  };
  scoreDelta: {
    capturePreScores: () => void;
    show: (onDone: () => void) => void;
    isActive: () => boolean;
    reset: () => void;
  };
  /** Save human crosshair at end of battle so it can be restored next battle. */
  saveBattleCrosshair?: () => void;
  /** Called after beginBattle completes (crosshair override, etc.). */
  onBeginBattle?: () => void;
  /** Upgrade-pick hook bag — all four functions are wired together or not
   *  at all. Grouping them into a single optional field encodes that
   *  invariant at the type level, so the `upgradePick` ctx object can be
   *  assembled without non-null assertions.
   *  - `tryShow`: show upgrade pick overlay. Returns true if shown (caller
   *    should defer Mode.GAME). `onDone` fires when all picks are resolved.
   *  - `prepare`: pre-create the dialog for progressive reveal during banner.
   *  - `getDialog`: read the live dialog state — the machine passes resolved
   *    picks into `applyUpgradePicks`.
   *  - `clear`: tear down the dialog. Called from `upgrade-pick-done.mutate`
   *    right after the picks are applied, keeping dialog lifetime scoped to
   *    the UPGRADE_PICK phase. Watcher wiring in `online-phase-transitions.ts`
   *    routes to `runtime.upgradePick.set(null)`. */
  upgradePick?: {
    tryShow: (onDone: () => void) => boolean;
    prepare: () => boolean;
    getDialog: () => UpgradePickDialogState | null;
    clear: () => void;
  };
  /** End-game side effects (set game-over frame, stop sound, switch to
   *  Mode.STOPPED, arm demo timer). Wired to `lifecycle.endGame` from
   *  composition. The machine's `round-limit-reached` /
   *  `last-player-standing` mutate calls this through `ctx.endGame`. */
  endGame: (winner: { id: number }) => void;
  /** Request an immediate untilt ease at battle-end. Called every tick
   *  while the phase-ticks system waits for `getPitchState() === "flat"`
   *  before firing the battle-done banner capture. */
  beginUntilt: () => void;
  /** Pitch state machine. Gates the battle-done transition so the
   *  banner snapshot captures a flat scene — wait until `"flat"` (or
   *  fall through on the safety timeout). */
  getPitchState: () => "flat" | "tilting" | "tilted" | "untilting";
  /** True when every cannon's eased displayed facing has converged to
   *  its target. Gates battle-end so the post-battle `resetCannonFacings`
   *  rotation completes before the camera untilt begins — frame-synced
   *  instead of wall-clock timed. Sourced from
   *  `runtime-cannon-animator.ts`'s `allSettled`. */
  cannonRotationSettled: () => boolean;
  /** Start the build→battle tilt. Called from `proceedToBattle` at
   *  battle-banner end. */
  beginBattleTilt: () => void;
  /** Re-engage the current phase's auto-zoom. Called from the life-lost
   *  display step before the popup (spec: scores → zoom → popup). */
  engageAutoZoom: () => void;
}

export interface PhaseTicksSystem {
  /** Dispatch the `advance-to-cannon` transition (post-life-lost continue
   *  path). The mutate runs `enterCannonPhase` only — castle finalize was
   *  already done by an earlier transition. */
  dispatchAdvanceToCannon: () => void;
  /** Dispatch the `castle-done` transition. Used by both the round-1
   *  initial-selection path and the reselect cycle. The mutate runs
   *  `finalizeRoundCleanup` (gated on `round > 1` because round 1 has no
   *  prior round to clean up after — cleanup-deferral, not cycle-type) +
   *  `finalizeFreshCastles` + `finalizeCastleConstruction` +
   *  `enterCannonPhase`. */
  dispatchCastleDone: () => void;
  /** Dispatch the game-over transition (`last-player-standing` or
   *  `round-limit-reached`); the mutate calls `ctx.endGame(winner)`. */
  dispatchGameOver: (winner: { id: number }, reason: GameOverReason) => void;
  startBattle: () => void;
  tickBalloonAnim: (dt: number) => void;
  beginBattle: () => void;
  startBuildPhase: () => void;
  tickCannonPhase: (dt: number) => boolean;
  tickBattleCountdown: (dt: number) => void;
  tickBattlePhase: (dt: number) => boolean;
  tickBuildPhase: (dt: number) => boolean;
  tickGame: (dt: number) => void;
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
    runTransition("advance-to-cannon", buildHostPhaseCtx());
  }

  function dispatchCastleDone() {
    runTransition("castle-done", buildHostPhaseCtx());
  }

  function dispatchGameOver(winner: { id: number }, reason: GameOverReason) {
    runTransition(reason, {
      ...buildHostPhaseCtx(),
      winner,
    });
  }

  // -------------------------------------------------------------------------
  // Battle
  // -------------------------------------------------------------------------

  function startBattle() {
    const { state } = runtimeState;
    if (shouldSkipBattle(state)) {
      runTransition("ceasefire", buildHostPhaseCtx());
      return;
    }
    runTransition("cannon-place-done", buildHostPhaseCtx());
  }

  /** Single host-side `PhaseTransitionCtx` factory shared by every call
   *  site (advance-to-cannon, ceasefire, cannon-place-done, battle-done,
   *  round-end, plus the deferred castle-done / game-over once they land
   *  here too).
   *
   *  Every hook any host-role mutate/postDisplay might need is populated.
   *  Hooks the active transition doesn't read are inert — the cost of
   *  including them is one closure allocation per `runTransition` call. */
  function buildHostPhaseCtx(): PhaseTransitionCtx {
    const remotePlayerSlots = runtimeState.frameMeta.remotePlayerSlots;
    const local = localControllers(runtimeState.controllers, remotePlayerSlots);
    const isHost = runtimeState.frameMeta.hostAtFrameStart;
    const { battleAnim } = runtimeState;
    return {
      state: runtimeState.state,
      runtimeState,
      timing: deps.timing,
      showBanner: deps.showBanner,
      hideBanner: deps.hideBanner,
      onCameraReady: deps.onCameraReady,
      setMode: (mode) => setMode(runtimeState, mode),
      log: deps.log,
      scoreDelta: deps.scoreDelta,
      battle: {
        setFlights: (flights) => {
          battleAnim.flights = [...flights];
        },
        setTerritory: (territory) => {
          battleAnim.territory = territory.map((set) => new Set(set));
        },
        setWalls: (walls) => {
          battleAnim.walls = walls.map((set) => new Set(set));
        },
        clearImpacts: () => clearImpacts(battleAnim),
        begin: beginBattle,
      },
      initLocalCannonControllers: () => {
        resetAccum(runtimeState.accum, ACCUM_CANNON);
        for (const ctrl of runtimeState.controllers) {
          if (isRemotePlayer(ctrl.playerId, remotePlayerSlots)) continue;
          const prep = prepareControllerCannonPhase(
            ctrl.playerId,
            runtimeState.state,
          );
          if (!prep) continue;
          ctrl.placeCannons(runtimeState.state, prep.maxSlots);
          ctrl.cannonCursor = prep.cursorPos;
          ctrl.startCannonPhase(runtimeState.state);
        }
      },
      upgradePick: deps.upgradePick
        ? {
            prepare: deps.upgradePick.prepare,
            tryShow: deps.upgradePick.tryShow,
            getDialog: deps.upgradePick.getDialog,
            clear: deps.upgradePick.clear,
          }
        : undefined,
      ceasefireSkipBattle: () => enterBuildSkippingBattle(runtimeState.state),
      startBuildPhaseLocal: startBuildPhase,
      endBattleLocalControllers: () => {
        for (const ctrl of local) ctrl.endBattle();
      },
      saveBattleCrosshair: deps.saveBattleCrosshair,
      getPitchState: deps.getPitchState,
      onPitchSettled: deps.onPitchSettled,
      beginBattleTilt: deps.beginBattleTilt,
      engageAutoZoom: deps.engageAutoZoom,
      lifeLost: {
        show: deps.lifeLost.show,
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
    const { battleAnim } = runtimeState;
    let allDone = true;
    for (const flight of battleAnim.flights) {
      flight.progress = Math.min(
        1,
        flight.progress + dt / BALLOON_FLIGHT_DURATION,
      );
      if (flight.progress < 1) allDone = false;
    }
    deps.requestRender();
    if (allDone) {
      battleAnim.flights = [];
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
    deps.scoreDelta.capturePreScores();
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
          // through the post-cannon-place transition (modifier roll, AI
          // upgrade-pick precompute, grunt spawn).
          const playerId = ctrl.playerId;
          const applyAt = state.simTick + DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS;
          state.pendingCannonPlaceDone.add(playerId);
          runtimeState.actionSchedule.schedule({
            applyAt,
            playerId,
            apply: (drainState) => {
              drainState.pendingCannonPlaceDone.delete(playerId);
              drainState.cannonPlaceDone.add(playerId);
            },
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
        mode: phantomWireMode(phantom),
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
    runTransition("enter-battle", buildHostPhaseCtx());
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
    // therefore skip their battleTick, which would otherwise overwrite
    // `cannon.facing` via `aimCannons` every frame and fight the
    // battle-end facing reset below.
    const weaponsActive = state.timer > 0 || state.cannonballs.length > 0;

    // Controller ticks (pass 1) must precede engine combat (pass 2): new
    // cannonballs spawned during `battleTick` need to exist before the
    // engine advances them and resolves hits on the same frame. Both run
    // locally on every peer — AI fires are deterministic from strategy.rng
    // + state, human fires broadcast CANNON_FIRED via the human-input path.
    if (weaponsActive) tickLocalBattleControllers(local, state, dt);
    const result = engineTickBattlePhase(state, dt);

    // Record visuals + stats from the same combat result, on every peer.
    // The bus must not drive runtime-affecting state — battleAnim.*
    // gates the battle-end transition, gameStats feeds the end-game UI.
    recordBattleVisualEvents(result, battleAnim, state);
    accumulateBattleStats(
      result.impactEvents,
      runtimeState.scoreDisplay.gameStats,
    );

    // Haptics is handled by the haptics observer subsystem (bus subscriber).

    syncCrosshairs(weaponsActive, dt);
    deps.requestRender();

    if (state.timer > 0 || state.cannonballs.length > 0) return false;
    // Safe margin: let impact flashes, ice-thaw, and wall-burn animations
    // finish before capturing the "old scene" snapshot for the Build banner.
    // Without this, mid-animation explosion/thaw/burn visuals bake into the
    // prev-scene image.
    if (
      battleAnim.impacts.length > 0 ||
      battleAnim.thawing.length > 0 ||
      battleAnim.wallBurns.length > 0 ||
      battleAnim.cannonDestroys.length > 0 ||
      battleAnim.gruntKills.length > 0 ||
      battleAnim.houseDestroys.length > 0
    )
      return false;

    // Rotate cannons back to rest while the camera is still tilted. The
    // call is idempotent (same defaultFacing → same cannon.facing every
    // tick), so we don't need a "done it once" flag — the cannon-animator
    // picks up the targets each tick and eases displayed → target. We
    // hold the phase until `cannonRotationSettled()` returns true,
    // frame-synced with the visual ease.
    resetCannonFacings(state);
    if (!deps.cannonRotationSettled()) return false;

    // Pre-banner untilt: trigger the camera to ease pitch → 0 and wait for
    // it to settle BEFORE the battle-done transition runs. Otherwise the
    // banner's prev-scene snapshot bakes in the tilted view and the
    // untilt then plays under the banner (visible flat-flash then
    // re-tilt on next-phase enter).
    deps.beginUntilt();
    if (deps.getPitchState() !== "flat") return false;

    runTransition("battle-done", buildHostPhaseCtx());
    return true;
  }

  function tickBuildPhase(dt: number): boolean {
    if (deps.scoreDelta.isActive()) {
      deps.requestRender();
      return false;
    }
    const remotePlayerSlots = runtimeState.frameMeta.remotePlayerSlots;
    const { state, accum } = runtimeState;
    const local = localControllers(runtimeState.controllers, remotePlayerSlots);

    // --- Engine tick (advance upgrade-effect timers; timerMax includes any active upgrade bonus) ---
    tickBuildUpgrades(state, dt);
    const timerMax = state.buildTimer + buildTimerBonus(state);
    advancePhaseTimer(accum, "build", state, dt, timerMax);

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
    // watcher see the same wall set when grunts step. The watcher applies
    // wire-received placements before its own `tickGruntsIfDue` (see
    // online-watcher-tick.ts); the host must mirror that order or grunts
    // diverge by one frame, drifting state-dependent RNG draws.
    tickGruntsIfDue(accum, dt, state, moveGrunts);

    deps.requestRender();
    if (state.timer > 0) return false;

    // --- End of phase: delegate to the round-end transition ---
    runTransition("round-end", buildHostPhaseCtx());
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
        // castle-select runs in Mode.SELECTION / CASTLE_BUILD.
        // tickGame never reaches these branches while those phases
        // are active. Explicit no-ops for exhaustiveness.
        break;
    }
    online?.tickMigrationAnnouncement?.(dt);
  }

  /** Accumulate per-player battle stats (walls destroyed, cannons killed) from
   *  the engine's impact-event list. Driven from `result.impactEvents` on
   *  every tick — never from a bus subscription, since `gameStats` is in
   *  `runtimeState` and runtime state must not depend on the bus. */
  function accumulateBattleStats(
    events: ReadonlyArray<ImpactEvent>,
    gameStats: readonly PlayerStats[],
  ): void {
    for (const evt of events) {
      if (evt.type === BATTLE_MESSAGE.WALL_DESTROYED) {
        const stats =
          evt.shooterId !== undefined ? gameStats[evt.shooterId] : undefined;
        if (stats) stats.wallsDestroyed++;
      } else if (
        evt.type === BATTLE_MESSAGE.CANNON_DAMAGED &&
        evt.newHp === 0
      ) {
        const stats =
          evt.shooterId !== undefined ? gameStats[evt.shooterId] : undefined;
        if (stats) stats.cannonsKilled++;
      }
    }
  }

  return {
    dispatchAdvanceToCannon,
    dispatchCastleDone,
    dispatchGameOver,
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

/** Finalize a LOCAL controller at the end of cannon phase.
 *  Local controllers own an auto-placement queue that must be flushed before
 *  `initCannons` runs the round-1 safety net, so this routes through
 *  `finalizeCannonPhase` which guarantees flush → init order. Calling
 *  `initCannons` directly on a local controller would skip the flush and
 *  corrupt cannon state. */
function finalizeLocalCannonController(
  ctrl: CannonController & { readonly playerId: number },
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
  ctrl: CannonController & { readonly playerId: number },
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
