import type { BattleCombatResult, GameOverReason } from "../game/index.ts";
import {
  advanceBattleCountdown,
  canBuildThisFrame,
  diffNewWalls,
  emitBattleCeaseIfTimerCrossed,
  tickBattlePhase as engineTickBattlePhase,
  tickBuildPhase as engineTickBuildPhase,
  enterBuildSkippingBattle,
  nextReadyCombined,
  prepareControllerCannonPhase,
  resetCannonFacings,
  setBattleCountdown,
  shouldSkipBattle,
  tickGrunts,
} from "../game/index.ts";
import {
  BATTLE_MESSAGE,
  type BattleEvent,
  type CannonFiredMessage,
  createCannonFiredMsg,
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
import {
  emitGameEvent,
  GAME_EVENT,
  type GameEventBus,
} from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import {
  type CannonPhantomPayload,
  type CannonPlacedPayload,
  cannonPhantomKey,
  filterAlivePhantoms,
  type PiecePhantomPayload,
  type PiecePlacedPayload,
  phantomWireMode,
  piecePhantomKey,
} from "../shared/core/phantom-types.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import { cannonSize } from "../shared/core/spatial.ts";
import {
  type CannonController,
  isHuman,
  type PlayerController,
} from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import type { UpgradePickDialogState } from "../shared/ui/interaction-types.ts";
import type { PlayerStats } from "../shared/ui/overlay-types.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import type { BannerShow, TimingApi } from "./runtime-contracts.ts";
import {
  type PhaseTransitionCtx,
  ROLE_HOST,
  runTransition,
} from "./runtime-phase-machine.ts";
import {
  assertStateReady,
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

  /** Online coordination bag — see `OnlinePhaseTicks`. Undefined for local
   *  play; every field is independently optional within the bag itself. */
  online?: OnlinePhaseTicks;

  // Sibling systems / parent callbacks
  render: () => void;
  /** Park a post-convergence callback — threaded through to
   *  `PhaseTransitionCtx` so `runTransition` can gate every mutate +
   *  display step on the camera reaching fullMapVp. See
   *  `CameraSystem.onCameraReady`. */
  onCameraReady: (onReady: () => void) => void;
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
   *  reselect queue and enters the castle-reselect flow; `onContinue`
   *  dispatches `advance-to-cannon`. Host-only — watcher path builds
   *  its own route bundle in `online-phase-transitions.ts`. */
  lifeLostRoute: {
    onGameOver: (winner: { id: number }, reason: GameOverReason) => void;
    onReselect: (continuing: readonly ValidPlayerSlot[]) => void;
    onContinue: () => void;
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
  /** True while the renderer is still easing cannon facings toward
   *  their targets. Gates battle-end so the post-battle
   *  `resetCannonFacings` rotation completes before the camera
   *  untilt begins — frame-synced instead of wall-clock timed. */
  isCannonRotationEasing: () => boolean;
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
  startCannonPhase: () => void;
  /** Dispatch the `castle-select-done` transition: round-1 / initial
   *  castle selection is complete; the mutate finalizes castle
   *  construction (spawn houses + bonus squares) and enters cannon phase. */
  enterCannonAfterCastleSelect: () => void;
  /** Dispatch the `castle-reselect-done` transition: a player who lost a
   *  life finished re-selecting; the mutate runs `finalizeReselectedPlayers`
   *  with the given pids, then finalize castle construction + enter cannon. */
  enterCannonAfterCastleReselect: (
    reselectionPids: readonly ValidPlayerSlot[],
  ) => void;
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
  /** Subscribe the stats accumulator to the current `state.bus`. Idempotent
   *  per-bus; safe (and required) to call after every new-game setState so
   *  rematches rebind to the fresh bus. */
  subscribeBusObservers: () => void;
}

/** Set of all battle event type strings — used to filter bus events. */
const BATTLE_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.values(BATTLE_MESSAGE),
);

export function createPhaseTicksSystem(deps: PhaseTicksDeps): PhaseTicksSystem {
  const { runtimeState } = deps;
  const online = deps.online;

  // True once the battle-end `resetCannonFacings` call has been made for
  // this round. Prevents re-resetting on every tick while we wait for
  // the renderer to finish easing. Cleared at the start of the next
  // `beginBattle` so it resets even when the battle-done transition is
  // bypassed (e.g. a game-over short-circuit).
  let rotationResetDone = false;

  // -------------------------------------------------------------------------
  // Bus → stats accumulator (observation subscriber)
  //
  // Each new game installs a fresh `state.bus`, so subscription must run
  // AFTER setState. The caller invokes `subscribeBusObservers` from the
  // bootstrap `onStateReady` hook; the bus-identity guard keeps it
  // idempotent within a single game (extra calls are a no-op) and lets
  // it resubscribe cleanly on rematch (new bus identity).
  // -------------------------------------------------------------------------

  let subscribedBus: GameEventBus | undefined;
  function subscribeBusObservers(): void {
    const bus = runtimeState.state.bus;
    if (subscribedBus === bus) return;
    subscribedBus = bus;
    bus.onAny((type, event) => {
      if (BATTLE_EVENT_TYPES.has(type)) {
        accumulateBattleStats(
          [event as BattleEvent],
          runtimeState.scoreDisplay.gameStats,
        );
      }
    });
    bus.on(BATTLE_MESSAGE.WALL_DESTROYED, (event) => {
      runtimeState.battleAnim.wallBurns.push({
        row: event.row,
        col: event.col,
        age: 0,
      });
    });
    bus.on(BATTLE_MESSAGE.CANNON_DAMAGED, (event) => {
      if (event.newHp > 0) return;
      const cannon =
        runtimeState.state.players[event.playerId]?.cannons[event.cannonIdx];
      if (!cannon) return;
      runtimeState.battleAnim.cannonDestroys.push({
        row: cannon.row,
        col: cannon.col,
        size: cannonSize(cannon.mode),
        age: 0,
      });
    });
    bus.on(BATTLE_MESSAGE.GRUNT_KILLED, (event) => {
      runtimeState.battleAnim.gruntKills.push({
        row: event.row,
        col: event.col,
        age: 0,
      });
    });
    bus.on(BATTLE_MESSAGE.HOUSE_DESTROYED, (event) => {
      runtimeState.battleAnim.houseDestroys.push({
        row: event.row,
        col: event.col,
        age: 0,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Crosshairs
  // -------------------------------------------------------------------------

  function syncCrosshairs(weaponsActive: boolean, dt: number): void {
    const remotePlayerSlots = runtimeState.frameMeta.remotePlayerSlots;
    const isHost = runtimeState.frameMeta.hostAtFrameStart;
    const { state, controllers } = runtimeState;
    const crosshairs: Crosshair[] = [];

    for (const ctrl of controllers) {
      if (isRemotePlayer(ctrl.playerId, remotePlayerSlots)) continue;
      const readyCannon = nextReadyCombined(state, ctrl.playerId);
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
      // Host-only fan-out: gated here at the call site so the wiring closure
      // never has to know about role state.
      if (isHost) {
        online?.broadcastLocalCrosshair?.(ctrl, ch, !!readyCannon);
      }
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

  function startCannonPhase() {
    runTransition("advance-to-cannon", buildHostPhaseCtx());
  }

  function enterCannonAfterCastleSelect() {
    runTransition("castle-select-done", buildHostPhaseCtx());
  }

  function enterCannonAfterCastleReselect(
    reselectionPids: readonly ValidPlayerSlot[],
  ) {
    runTransition("castle-reselect-done", {
      ...buildHostPhaseCtx(),
      reselectionPids,
    });
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
   *  wall-build-done, plus the deferred castle-select-done /
   *  castle-reselect-done / game-over once they land here too).
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
      role: ROLE_HOST,
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
            cannonStart: (state) => online?.broadcastCannonStart?.(state),
            battleStart: (rngState) => online?.broadcastBattleStart?.(rngState),
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
    deps.render();
    if (allDone) {
      battleAnim.flights = [];
      emitGameEvent(runtimeState.state.bus, GAME_EVENT.BALLOON_ANIM_END, {
        round: runtimeState.state.round,
      });
      beginBattle();
    }
  }

  function beginBattle() {
    // Reset the battle-end rotation-latch here, at the START of every new
    // battle, so the flag is always clean on entry regardless of whether
    // the previous battle's tick ran to the battle-done transition or
    // was short-circuited (e.g. by a game-over path that skipped the
    // end-of-tick clear).
    rotationResetDone = false;
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
    online?.watcherBeginBattle?.(deps.timing.now());
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
    const isHost = runtimeState.frameMeta.hostAtFrameStart;
    const { state } = runtimeState;
    const local = localControllers(runtimeState.controllers, remotePlayerSlots);

    advancePhaseTimer(
      runtimeState.accum,
      ACCUM_CANNON,
      state,
      dt,
      state.cannonPlaceTimer,
    );

    // PASS 1: tick local controllers, broadcast placements + phantoms.
    // Local phantoms live on `ctrl.currentCannonPhantom`; render reads
    // them directly from the controller union in `refreshOverlay`.
    for (const ctrl of local) {
      if (isPlayerEliminated(state.players[ctrl.playerId])) continue;
      const cannonsBefore = state.players[ctrl.playerId]!.cannons.length;
      const phantom = ctrl.cannonTick(state, dt);

      // Broadcast only for pure-AI locals. Human-shaped controllers
      // (including AiAssistedHuman) broadcast from inside their own
      // placement callbacks — emitting here would double-send.
      if (isHost && !isHuman(ctrl)) {
        const cannonsAfter = state.players[ctrl.playerId]!.cannons.length;
        for (
          let cannonIdx = cannonsBefore;
          cannonIdx < cannonsAfter;
          cannonIdx++
        ) {
          const cannon = state.players[ctrl.playerId]!.cannons[cannonIdx]!;
          deps.sendOpponentCannonPlaced({
            playerId: ctrl.playerId,
            row: cannon.row,
            col: cannon.col,
            mode: cannon.mode,
          });
        }
      }

      if (!phantom) continue;

      if (
        isHost &&
        (online?.shouldSendCannonPhantom?.(
          ctrl.playerId,
          cannonPhantomKey(phantom),
        ) ??
          true)
      ) {
        deps.sendOpponentCannonPhantom({
          playerId: ctrl.playerId,
          row: phantom.row,
          col: phantom.col,
          mode: phantomWireMode(phantom),
          valid: phantom.valid,
        });
      }
    }

    // Remote phantoms are consumed from `runtimeState.remotePhantoms`
    // by the render + touch layers; controllers own local previews in
    // `currentCannonPhantom`.
    const remoteCannonPhantoms = filterAlivePhantoms(
      online?.remoteCannonPhantoms?.() ?? [],
      state.players,
    );
    runtimeState.remotePhantoms = {
      piecePhantoms: runtimeState.remotePhantoms.piecePhantoms,
      cannonPhantoms: remoteCannonPhantoms,
    };

    deps.render();

    const allDone = local.every((ctrl) => {
      const player = state.players[ctrl.playerId]!;
      if (isPlayerEliminated(player)) return true;
      const max = state.cannonLimits[player.id] ?? 0;
      return ctrl.isCannonPhaseDone(state, max);
    });

    if (state.timer > 0 && !allDone) return false;

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

  /** MODIFIER_REVEAL phase tick (host). The phase has no game-mechanics
   *  content — it exists purely to hold the modifier-reveal banner on
   *  screen for a beat before battle begins. `enter-modifier-reveal`'s
   *  mutate set `state.timer = MODIFIER_REVEAL_TIMER`; we decrement it
   *  here and dispatch `enter-battle` when it expires. Watcher-side,
   *  `tickWatcher` does the equivalent via `tickWatcherTimers` +
   *  a local enter-battle dispatch — neither side exchanges a network
   *  message for this edge, it's driven by the deterministic phase
   *  duration on both sides. */
  function tickModifierRevealPhase(dt: number): boolean {
    advancePhaseTimer(
      runtimeState.accum,
      ACCUM_MODIFIER_REVEAL,
      runtimeState.state,
      dt,
      MODIFIER_REVEAL_TIMER,
    );
    deps.render();
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
    deps.render();
  }

  function tickBattlePhase(dt: number): boolean {
    const remotePlayerSlots = runtimeState.frameMeta.remotePlayerSlots;
    const isHost = runtimeState.frameMeta.hostAtFrameStart;
    const local = localControllers(runtimeState.controllers, remotePlayerSlots);
    const { state, battleAnim } = runtimeState;
    const broadcast = isHost ? deps.send : undefined;

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
    // engine advances them and resolves hits on the same frame. The ordering
    // is enforced by data flow — `fireEvents` is produced by pass 1 and
    // threaded as a required parameter into `resolveBattleCombatStep`.
    const fireEvents = weaponsActive
      ? tickLocalBattleControllers(local, state, dt)
      : [];
    const result = resolveBattleCombatStep(fireEvents, state, dt);

    // Broadcast CANNON_FIRED only — the watcher derives TOWER_KILLED and
    // every ImpactEvent locally by running the same engine combat tick
    // (tickWatcherBattlePhase calls tickBattlePhase). Both sides share
    // synced state at BATTLE_START + matching dt sequence, so impact
    // resolution converges without per-event wire chatter.
    if (broadcast) {
      for (const evt of result.fireEvents) broadcast(evt);
    }

    // Record visual impacts
    for (const imp of result.newImpacts) {
      battleAnim.impacts.push({ ...imp, age: 0 });
    }
    // Record thaw animations for ice-break effect
    for (const evt of result.impactEvents) {
      if (evt.type === BATTLE_MESSAGE.ICE_THAWED) {
        battleAnim.thawing.push({ row: evt.row, col: evt.col, age: 0 });
      }
    }

    // Haptics and stats are handled by bus subscribers (onAny above / haptics subsystem).

    syncCrosshairs(weaponsActive, dt);
    deps.render();

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
    // facing reset happens once here (not in startBuildPhase) so the
    // renderer sees `cannon.facing` change at this exact moment and
    // eases the displayed rotation toward it. We hold the phase until
    // the renderer reports the ease has settled — frame-synced, so a
    // paused tab can't skip the animation.
    if (!rotationResetDone) {
      resetCannonFacings(state);
      rotationResetDone = true;
    }
    if (deps.isCannonRotationEasing()) return false;

    // Pre-banner untilt: trigger the camera to ease pitch → 0 and wait for
    // it to settle BEFORE the battle-done transition runs. Otherwise the
    // banner's prev-scene snapshot bakes in the tilted view and the
    // untilt then plays under the banner (visible flat-flash then
    // re-tilt on next-phase enter).
    deps.beginUntilt();
    if (deps.getPitchState() !== "flat") return false;

    // Battle ended — delegate to the battle-done transition. The
    // `rotationResetDone` latch is cleared at the START of the next
    // `beginBattle`, not here, so any path that skips this transition
    // (e.g. game-over short-circuits) still gets a clean flag next round.
    runTransition("battle-done", buildHostPhaseCtx());
    return true;
  }

  function tickBuildPhase(dt: number): boolean {
    if (deps.scoreDelta.isActive()) {
      deps.render();
      return false;
    }
    const remotePlayerSlots = runtimeState.frameMeta.remotePlayerSlots;
    const isHost = runtimeState.frameMeta.hostAtFrameStart;
    const { state, accum } = runtimeState;
    const local = localControllers(runtimeState.controllers, remotePlayerSlots);

    // --- Engine tick (advances upgrade-effect timers, returns timer max) ---
    const { timerMax } = engineTickBuildPhase(state, dt);
    advancePhaseTimer(accum, "build", state, dt, timerMax);
    tickGruntsIfDue(accum, dt, state, (gameState: GameState) => {
      tickGrunts(gameState);
    });

    // --- PASS 1: Tick local controllers, detect new walls, collect phantoms ---
    for (const ctrl of local) {
      if (isPlayerEliminated(state.players[ctrl.playerId])) continue;
      if (!canBuildThisFrame(state, ctrl.playerId)) continue;
      const player = state.players[ctrl.playerId]!;

      // Snapshot walls BEFORE tick so we can diff new AI placements
      const shouldSnapshot = isHost && !isHuman(ctrl);
      const wallSnapshot = shouldSnapshot ? new Set(player.walls) : null;
      const phantoms = ctrl.buildTick(state, dt);

      // Broadcast new AI walls
      if (wallSnapshot) {
        const offsets = diffNewWalls(state, ctrl.playerId, wallSnapshot);
        if (offsets.length > 0) {
          deps.sendOpponentPiecePlaced({
            playerId: ctrl.playerId,
            row: 0,
            col: 0,
            offsets,
          });
        }
      }

      // Broadcast phantoms (dedup for network)
      for (const phantom of phantoms) {
        if (
          isHost &&
          (online?.shouldSendPiecePhantom?.(
            phantom.playerId,
            piecePhantomKey(phantom),
          ) ??
            true)
        ) {
          deps.sendOpponentPhantom({
            playerId: phantom.playerId,
            row: phantom.row,
            col: phantom.col,
            offsets: phantom.offsets,
            valid: phantom.valid,
          });
        }
      }
    }

    // Remote phantoms are consumed from `runtimeState.remotePhantoms`
    // by the render + touch layers; controllers own local previews in
    // `currentBuildPhantoms`.
    const remotePiecePhantoms = filterAlivePhantoms(
      online?.remotePiecePhantoms?.() ?? [],
      state.players,
    );
    runtimeState.remotePhantoms = {
      piecePhantoms: remotePiecePhantoms,
      cannonPhantoms: runtimeState.remotePhantoms.cannonPhantoms,
    };

    deps.render();
    if (state.timer > 0) return false;

    // --- End of phase: delegate to the wall-build-done transition ---
    runTransition("wall-build-done", buildHostPhaseCtx());
    return true;
  }

  // -------------------------------------------------------------------------
  // tickGame — dispatches to the correct phase tick
  // -------------------------------------------------------------------------

  /** Canonical state-ready guard — all phase ticks funnel through here,
   *  so a single assertion covers cannon, battle, build, and balloon ticks. */
  function tickGame(dt: number) {
    assertStateReady(runtimeState);
    if (runtimeState.frameMeta.hostAtFrameStart) {
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
          // Real timed phase — its banner's sweep-end flips mode to
          // GAME (see `enter-modifier-reveal.postDisplay`), then this
          // branch decrements `state.timer` and dispatches
          // `enter-battle` when it expires. Before the phase-timer
          // refactor this was an unreachable no-op because the banner
          // owned the delay via a `holdMs` setTimeout.
          tickModifierRevealPhase(dt);
          break;
        case Phase.UPGRADE_PICK:
        case Phase.CASTLE_SELECT:
        case Phase.CASTLE_RESELECT:
          // UPGRADE_PICK runs in Mode.UPGRADE_PICK (not Mode.GAME);
          // castle-select phases run in Mode.SELECTION / CASTLE_BUILD.
          // tickGame never reaches these branches while those phases
          // are active. Explicit no-ops for exhaustiveness.
          break;
      }
    } else {
      ageImpacts(runtimeState.battleAnim, dt, IMPACT_FLASH_DURATION);
      online?.tickWatcher?.(dt);
      deps.render();
    }
    online?.tickMigrationAnnouncement?.(dt);
  }

  /** Accumulate per-player battle stats (walls destroyed, cannons killed) from battle events.
   *  UI/stats concern — lives in runtime, not game domain. */
  function accumulateBattleStats(
    events: ReadonlyArray<BattleEvent>,
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
    startCannonPhase,
    enterCannonAfterCastleSelect,
    enterCannonAfterCastleReselect,
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
    subscribeBusObservers,
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
): CannonFiredMessage[] {
  const fireEvents: CannonFiredMessage[] = [];
  for (const ctrl of local) {
    if (isPlayerEliminated(state.players[ctrl.playerId])) continue;
    const ballsBefore = state.cannonballs.length;
    ctrl.battleTick(state, dt);
    if (!isHuman(ctrl)) {
      for (let idx = ballsBefore; idx < state.cannonballs.length; idx++) {
        fireEvents.push(createCannonFiredMsg(state.cannonballs[idx]!));
      }
    }
  }
  return fireEvents;
}

/** Pass 2 of the battle-phase tick: resolve engine combat (tower kills,
 *  cannonball impacts) against the state produced by pass 1. Takes
 *  `fireEvents` as a required parameter — not because the engine uses them,
 *  but because requiring them forces the caller to run
 *  `tickLocalBattleControllers` first. The returned bundle merges both
 *  passes into a single result for broadcast + animation. */
function resolveBattleCombatStep(
  fireEvents: readonly CannonFiredMessage[],
  state: GameState,
  dt: number,
): BattleCombatResult & { fireEvents: readonly CannonFiredMessage[] } {
  const { towerEvents, impactEvents, newImpacts } = engineTickBattlePhase(
    state,
    dt,
  );
  return { fireEvents, towerEvents, impactEvents, newImpacts };
}
