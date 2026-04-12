import {
  advanceBattleCountdown,
  type CannonPhaseEntry,
  canBuildThisFrame,
  diffNewWalls,
  tickBattlePhase as engineTickBattlePhase,
  tickBuildPhase as engineTickBuildPhase,
  enterBattlePhase,
  enterBuildPhase,
  enterBuildSkippingBattle,
  enterCannonPhase,
  finishBuildPhase,
  nextReadyCombined,
  resetCannonFacings,
  shouldSkipBattle,
  snapshotCastles,
  snapshotEntities,
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
  type BalloonFlight,
  type Crosshair,
  clearImpacts,
} from "../shared/core/battle-types.ts";
import { getInterior } from "../shared/core/board-occupancy.ts";
import {
  BALLOON_FLIGHT_DURATION,
  BATTLE_COUNTDOWN,
  BATTLE_TIMER,
  IMPACT_FLASH_DURATION,
} from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import { modifierDef } from "../shared/core/modifier-defs.ts";
import {
  type CannonPhantomPayload,
  type CannonPlacedPayload,
  cannonPhantomKey,
  filterAlivePhantoms,
  NOOP_DEDUP_CHANNEL,
  type PiecePhantomPayload,
  type PiecePlacedPayload,
  phantomWireMode,
  piecePhantomKey,
} from "../shared/core/phantom-types.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import {
  type HapticsSystem,
  isHuman,
  type SoundSystem,
} from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import type { PlayerStats } from "../shared/ui/overlay-types.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
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
  advancePhaseTimer,
  isRemotePlayer,
  localControllers,
  resetAccum,
  tickGruntsIfDue,
} from "./runtime-tick-context.ts";
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
} from "./runtime-transition-steps.ts";
import type {
  OnlinePhaseTicks,
  RuntimeConfig,
  RuntimeLifeLost,
  TimingApi,
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
  showBanner: (
    text: string,
    onDone: () => void,
    preservePrevScene?: boolean,
    newBattle?: { territory: Set<number>[]; walls: Set<number>[] },
    subtitle?: string,
  ) => void;
  lifeLost: Pick<RuntimeLifeLost, "tryShow" | "onResolved">;
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
  sound: SoundSystem;
  haptics: HapticsSystem;
  /** Try to show upgrade pick overlay. Returns true if shown (caller should
   *  defer Mode.GAME). `onDone` is called when all picks are resolved. */
  tryShowUpgradePick?: (onDone: () => void) => boolean;
  /** Pre-create the upgrade pick dialog for progressive reveal during banner. */
  prepareUpgradePick?: () => boolean;
  /** Tear down the upgrade-pick dialog. Called from the build banner's
   *  onDone (after the sweep) so `drawUpgradePick` can keep clipping the
   *  dialog against `banner.y` for the entire animation. The watcher path
   *  has its own counterpart at `TransitionContext.clearUpgradePickDialog`
   *  in `online-phase-transitions.ts`. */
  clearUpgradePickDialog?: () => void;
}

export interface PhaseTicksSystem {
  startCannonPhase: (onBannerDone?: () => void) => void;
  startBattle: () => void;
  tickBalloonAnim: (dt: number) => void;
  beginBattle: () => void;
  startBuildPhase: () => void;
  tickCannonPhase: (dt: number) => boolean;
  tickBattleCountdown: (dt: number) => void;
  tickBattlePhase: (dt: number) => boolean;
  tickBuildPhase: (dt: number) => boolean;
  tickGame: (dt: number) => void;
  syncCrosshairs: (weaponsActive: boolean, dt?: number) => void;
}

/** Set of all battle event type strings — used to filter bus events. */
const BATTLE_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.values(BATTLE_MESSAGE),
);

export function createPhaseTicksSystem(deps: PhaseTicksDeps): PhaseTicksSystem {
  const { runtimeState } = deps;
  const online = deps.online;

  // -------------------------------------------------------------------------
  // Bus → sound / haptics / stats (observation subscribers)
  // Deferred: state.bus isn't available at system creation time.
  // -------------------------------------------------------------------------

  let busSubscribed = false;
  function subscribeBus(): void {
    if (busSubscribed) return;
    busSubscribed = true;
    runtimeState.state.bus.onAny((type, event) => {
      if (!BATTLE_EVENT_TYPES.has(type)) return;
      const pov = runtimeState.frameMeta.povPlayerId;
      const evt = event as BattleEvent;
      deps.sound.battleEvents([evt], pov);
      deps.haptics.battleEvents([evt], pov);
      accumulateBattleStats([evt], runtimeState.scoreDisplay.gameStats);
    });
  }

  // -------------------------------------------------------------------------
  // Crosshairs
  // -------------------------------------------------------------------------

  function syncCrosshairs(weaponsActive: boolean, dt = 0): void {
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

  function startCannonPhase(onBannerDone?: () => void) {
    subscribeBus();
    deps.sound.drumsQuiet();
    const remotePlayerSlots = runtimeState.frameMeta.remotePlayerSlots;
    deps.log(`startCannonPhase (round=${runtimeState.state.round})`);
    // Engine-owned phase entry: the struct is populated in applyCheckpoint
    // and consumed in initControllers. Closed over by both step adapters.
    let entry: CannonPhaseEntry | undefined;
    executeTransition(CANNON_START_STEPS, {
      showBanner: () => {
        if (onBannerDone) {
          // INVARIANT: Banner captures prevCastles BEFORE applyCheckpoint mutates state.
          // executeTransition guarantees this ordering via CANNON_START_STEPS.
          showCannonPhaseBanner(deps.showBanner, onBannerDone);
        }
      },
      applyCheckpoint: () => {
        // Engine owns the order: set phase → compute limits/facings →
        // compute per-player init data. Runtime just consumes the struct.
        entry = enterCannonPhase(runtimeState.state);
        resetAccum(runtimeState.accum, ACCUM_CANNON);
        if (runtimeState.frameMeta.hostAtFrameStart) {
          online?.broadcastCannonStart?.(runtimeState.state);
        }
      },
      initControllers: () => {
        if (!entry) return;
        for (const ctrl of runtimeState.controllers) {
          if (isRemotePlayer(ctrl.playerId, remotePlayerSlots)) continue;
          const prep = entry.playerInit[ctrl.playerId];
          if (!prep) continue;
          ctrl.placeCannons(runtimeState.state, prep.maxSlots);
          ctrl.cannonCursor = prep.cursorPos;
          ctrl.startCannonPhase(runtimeState.state);
        }
      },
    });
  }

  // -------------------------------------------------------------------------
  // Battle
  // -------------------------------------------------------------------------

  /** Send build checkpoint + enter build phase (via upgrade pick gate).
   *  Checkpoint is sent here — not in the transition steps — because it must
   *  precede the upgrade pick dialog (which reads post-battle state). */
  function enterBuildViaUpgradePick(): void {
    if (runtimeState.frameMeta.hostAtFrameStart) {
      online?.broadcastBuildStart?.(runtimeState.state);
    }
    const showBannerAndEnterBuild = () => {
      executeTransition(BUILD_START_STEPS, {
        showBanner: () =>
          showBuildPhaseBanner(deps.showBanner, () => {
            // Deferred clear of the upgrade-pick dialog. The dialog stays
            // in `runtimeState.dialogs.upgradePick` through the build
            // banner sweep so `drawUpgradePick` can progressively clip it
            // against `banner.y` (see `render-ui.ts:drawUpgradePick`).
            // Cleared here, on banner end, instead of in
            // `runtime-upgrade-pick.ts:tick` where the picks resolve.
            // Routed through `deps.clearUpgradePickDialog` (wired in
            // `runtime-composition.ts`) so the host path uses the same
            // subsystem boundary the watcher path uses.
            deps.clearUpgradePickDialog?.();
            setMode(runtimeState, Mode.GAME);
          }),
        applyCheckpoint: NOOP_STEP,
        initControllers: () => startBuildPhase(),
      });
    };
    gateUpgradePick(
      deps.showBanner,
      deps.tryShowUpgradePick,
      !!runtimeState.state.modern?.pendingUpgradeOffers,
      showBannerAndEnterBuild,
      deps.prepareUpgradePick,
    );
  }

  function startBattle() {
    subscribeBus();
    const { state, battleAnim, banner } = runtimeState;
    deps.sound.drumsStop();
    deps.log(`startBattle (round=${state.round})`);
    deps.scoreDelta.reset();

    if (shouldSkipBattle(state)) {
      enterBuildSkippingBattle(state);
      deps.log("ceasefire: skipping battle");
      enterBuildViaUpgradePick();
      return;
    }

    let flights: BalloonFlight[] = [];

    const proceedToBattle = () => {
      if (flights.length > 0) {
        battleAnim.flights = flights.map((flight) => ({
          flight,
          progress: 0,
        }));
        setMode(runtimeState, Mode.BALLOON_ANIM);
      } else {
        beginBattle();
      }
    };

    executeTransition(BATTLE_START_STEPS, {
      showBanner: () => {
        // Capture pre-mutation prev-scene snapshots BEFORE enterBattlePhase
        // mutates state. The banner subsystem's `preservePrevScene=true`
        // path uses `??=` so explicit pre-population wins over the implicit
        // capture. This is the same shape as the watcher in
        // online-phase-transitions.ts (`prevEntities` set before the recipe
        // runs).
        banner.prevCastles = snapshotCastles(state, banner.wallsBeforeSweep);
        banner.prevEntities = snapshotEntities(state);
        banner.wallsBeforeSweep = undefined;

        // Engine owns the load-bearing order: modifier roll → balloon
        // resolution → post-modifier snapshots.
        const entry = enterBattlePhase(state);
        flights = entry.flights;
        battleAnim.impacts = [];
        battleAnim.territory = entry.territory;
        battleAnim.walls = entry.walls;
        banner.newTerritory = entry.territory;
        banner.newWalls = entry.walls;
        if (runtimeState.frameMeta.hostAtFrameStart) {
          online?.broadcastBattleStart?.(state, flights, entry.modifierDiff);
        }

        // Now we know whether a modifier rolled, so we can call the
        // matching banner directly — same shape as the watcher path. No
        // mid-frame swap of `banner.text/modifierDiff/callback`, no
        // `pendingStartEvent` deferral required for correctness (the
        // bus event still fires next-tick as a one-tick dedup, but
        // its content is final at this point).
        if (entry.modifierDiff) {
          banner.modifierDiff = entry.modifierDiff;
          showModifierRevealBanner(
            deps.showBanner,
            modifierDef(entry.modifierDiff.id).label,
            () => {
              showBattlePhaseBanner(deps.showBanner, proceedToBattle);
            },
          );
        } else {
          showBattlePhaseBanner(deps.showBanner, proceedToBattle);
        }
      },
      applyCheckpoint: NOOP_STEP,
      snapshotForBanner: NOOP_STEP,
    });
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
    runtimeState.state.battleCountdown = BATTLE_COUNTDOWN;
    resetAccum(runtimeState.accum, ACCUM_BATTLE);
    setMode(runtimeState, Mode.GAME);
    // Watcher timing: record countdown start for non-host clients
    if (!runtimeState.frameMeta.hostAtFrameStart && online?.watcherTiming) {
      online.watcherTiming.countdownStartTime = deps.timing.now();
      online.watcherTiming.countdownDuration = BATTLE_COUNTDOWN;
    }
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
    console.assert(
      runtimeState.state.phase === Phase.WALL_BUILD,
      "startBuildPhase called outside WALL_BUILD",
    );
    resetCannonFacings(runtimeState.state);
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
    const { state, frame } = runtimeState;
    const local = localControllers(runtimeState.controllers, remotePlayerSlots);
    const cannonPhantomDedup =
      online?.cannonPhantomDedup?.() ?? NOOP_DEDUP_CHANNEL;

    advancePhaseTimer(
      runtimeState.accum,
      ACCUM_CANNON,
      state,
      dt,
      state.cannonPlaceTimer,
    );

    // Collect default facings for phantom rendering
    const defaultFacings = new Map<number, number>();
    for (const player of state.players) {
      defaultFacings.set(player.id, player.defaultFacing);
    }
    frame.phantoms = { cannonPhantoms: [], defaultFacings };

    // PASS 1: tick local controllers, collect placements + phantoms
    for (const ctrl of local) {
      if (isPlayerEliminated(state.players[ctrl.playerId])) continue;
      const cannonsBefore = state.players[ctrl.playerId]!.cannons.length;
      const phantom = ctrl.cannonTick(state, dt);

      if (isHost) {
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
      frame.phantoms.cannonPhantoms!.push(phantom);

      if (
        isHost &&
        cannonPhantomDedup.shouldSend(ctrl.playerId, cannonPhantomKey(phantom))
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

    // Merge remote phantoms
    const remoteCannonPhantoms = filterAlivePhantoms(
      online?.remoteCannonPhantoms?.() ?? [],
      state.players,
    );
    if (remoteCannonPhantoms.length > 0) {
      frame.phantoms.cannonPhantoms!.push(...remoteCannonPhantoms);
    }

    deps.render();

    const allDone = local.every((ctrl) => {
      const player = state.players[ctrl.playerId]!;
      if (isPlayerEliminated(player)) return true;
      const max = state.cannonLimits[player.id] ?? 0;
      return ctrl.isCannonPhaseDone(state, max);
    });

    if (state.timer > 0 && !allDone) return false;

    // PASS 2: finalize controllers for phase transition
    const remote = runtimeState.controllers.filter((ctrl) =>
      isRemotePlayer(ctrl.playerId, remotePlayerSlots),
    );
    // LOAD-BEARING SPLIT (do not merge local/remote):
    //   Remote humans: call initCannons() only (their cannons were flushed client-side).
    //   Local controllers: call finalizeCannonPhase() which flushes then inits.
    //   Using the wrong method corrupts cannon state.
    for (const ctrl of remote) {
      const max = state.cannonLimits[ctrl.playerId] ?? 0;
      ctrl.initCannons(state, max);
    }
    for (const ctrl of local) {
      const max = state.cannonLimits[ctrl.playerId] ?? 0;
      ctrl.finalizeCannonPhase(state, max);
    }
    startBattle();
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

    advancePhaseTimer(
      runtimeState.accum,
      ACCUM_BATTLE,
      state,
      dt,
      BATTLE_TIMER,
    );

    // Event collection order (LOAD-BEARING — do not reorder):
    //   1. Tick controllers → fire events (new cannonballs from battleTick)
    //   2. tickBattleCombat → tower kills + cannonball impacts
    // Step 2 depends on state produced by step 1.

    // Step 1: tick controllers → fire events
    const ballsBefore = state.cannonballs.length;
    for (const ctrl of local) {
      if (isPlayerEliminated(state.players[ctrl.playerId])) continue;
      ctrl.battleTick(state, dt);
    }
    const fireEvents: CannonFiredMessage[] = [];
    for (let idx = ballsBefore; idx < state.cannonballs.length; idx++) {
      fireEvents.push(createCannonFiredMsg(state.cannonballs[idx]!));
    }

    // Step 2: tower kills + cannonball impacts (load-bearing internal order)
    const { towerEvents, impactEvents, newImpacts } = engineTickBattlePhase(
      state,
      dt,
    );

    const result = { fireEvents, towerEvents, impactEvents, newImpacts };

    // Broadcast events to network
    if (broadcast) {
      for (const evt of result.fireEvents) broadcast(evt);
      for (const evt of result.towerEvents) broadcast(evt);
      for (const evt of result.impactEvents) broadcast(evt);
    }

    // Record visual impacts
    for (const imp of result.newImpacts) {
      battleAnim.impacts.push({ ...imp, age: 0 });
    }

    // Sound, haptics, and stats are now handled by bus subscribers (onAny above).

    syncCrosshairs(/* weaponsActive */ true, dt);
    deps.render();

    if (state.timer > 0 || state.cannonballs.length > 0) return false;

    // Battle ended — finalize controllers and transition
    // NOTE: Intentionally includes eliminated players — they need battle state
    // cleanup (clear fire targets, etc.) for potential castle reselection.
    for (const ctrl of local) {
      ctrl.endBattle();
    }
    deps.saveBattleCrosshair?.();
    // Engine owns the order: pre-transition snapshots are captured BEFORE
    // enterBuildFromBattle mutates state. Runtime wires the snapshots into
    // the banner overlay for the build-banner reveal.
    const entry = enterBuildPhase(
      state,
      battleAnim.territory,
      battleAnim.walls,
    );
    runtimeState.banner.prevCastles = entry.prevCastles;
    runtimeState.banner.prevTerritory = entry.prevTerritory;
    runtimeState.banner.prevWalls = entry.prevWalls;
    runtimeState.banner.prevEntities = entry.prevEntities;
    enterBuildViaUpgradePick();
    return true;
  }

  function tickBuildPhase(dt: number): boolean {
    if (deps.scoreDelta.isActive()) {
      deps.render();
      return false;
    }
    const remotePlayerSlots = runtimeState.frameMeta.remotePlayerSlots;
    const isHost = runtimeState.frameMeta.hostAtFrameStart;
    const { state, accum, frame, banner } = runtimeState;
    const local = localControllers(runtimeState.controllers, remotePlayerSlots);
    const piecePhantomDedup =
      online?.piecePhantomDedup?.() ?? NOOP_DEDUP_CHANNEL;

    // --- Engine tick (advances upgrade-effect timers, returns timer max) ---
    const { timerMax } = engineTickBuildPhase(state, dt);
    advancePhaseTimer(accum, "build", state, dt, timerMax);
    tickGruntsIfDue(accum, dt, state, (gameState: GameState) => {
      tickGrunts(gameState);
    });

    // --- PASS 1: Tick local controllers, detect new walls, collect phantoms ---
    frame.phantoms = { piecePhantoms: [] };
    for (const ctrl of local) {
      if (isPlayerEliminated(state.players[ctrl.playerId])) continue;
      if (!canBuildThisFrame(state, ctrl.playerId)) continue;
      const player = state.players[ctrl.playerId]!;
      const hadInterior = getInterior(player).size > 0;

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

      // First enclosure detection
      if (!hadInterior && getInterior(player).size > 0) {
        deps.sound.chargeFanfare(ctrl.playerId);
      }

      // Collect phantoms + dedup for network
      for (const phantom of phantoms) {
        frame.phantoms.piecePhantoms!.push({
          offsets: phantom.offsets,
          row: phantom.row,
          col: phantom.col,
          playerId: phantom.playerId,
          valid: phantom.valid ?? true,
        });
        if (
          isHost &&
          piecePhantomDedup.shouldSend(
            phantom.playerId,
            piecePhantomKey(phantom),
          )
        ) {
          deps.sendOpponentPhantom({
            playerId: phantom.playerId,
            row: phantom.row,
            col: phantom.col,
            offsets: phantom.offsets,
            valid: phantom.valid ?? true,
          });
        }
      }
    }

    // Merge remote phantoms
    const remotePiecePhantoms = filterAlivePhantoms(
      online?.remotePiecePhantoms?.() ?? [],
      state.players,
    );
    if (remotePiecePhantoms.length > 0) {
      frame.phantoms.piecePhantoms!.push(...remotePiecePhantoms);
    }

    deps.render();
    if (state.timer > 0) return false;

    // --- End of phase: finalize controllers + snapshot + life-lost ---

    // PASS 2: Finalize local controllers (remote humans are SKIPPED —
    // bag state is re-initialized via startBuildPhase at next round).
    for (const ctrl of local) {
      ctrl.finalizeBuildPhase(state);
    }

    // Engine owns the end-of-build orchestration: snapshot walls BEFORE
    // finalize (load-bearing — sweep would delete them), finalize territory
    // + life penalties, re-snapshot zone-dependent entities after reset.
    const { wallsBeforeSweep, prevEntities, needsReselect, eliminated } =
      finishBuildPhase(state);
    banner.wallsBeforeSweep = wallsBeforeSweep;
    banner.prevEntities = prevEntities;

    // Build-end checkpoint (host only) — the online hook serializes the
    // post-build player snapshot itself; the runtime supplies only the
    // structural summary it already computed.
    if (isHost) {
      online?.broadcastBuildEnd?.(state, {
        needsReselect,
        eliminated,
        scores: state.players.map((player) => player.score),
      });
    }

    // Life-lost dialog + score deltas
    runBuildEndSequence({
      needsReselect,
      eliminated,
      showScoreDeltas: deps.scoreDelta.show,
      notifyLifeLost: (pid) => {
        if (!isRemotePlayer(pid, remotePlayerSlots)) {
          runtimeState.controllers[pid]!.onLifeLost();
        }
      },
      showLifeLostDialog: (reselect, elim) => {
        deps.sound.lifeLost();
        deps.lifeLost.tryShow(reselect, elim);
      },
      onLifeLostResolved: deps.lifeLost.onResolved,
    });
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

      const { phase } = runtimeState.state;
      if (phase === Phase.CANNON_PLACE) {
        tickCannonPhase(dt);
      } else if (phase === Phase.BATTLE) {
        if (runtimeState.state.battleCountdown > 0) {
          tickBattleCountdown(dt);
        } else {
          tickBattlePhase(dt);
        }
      } else if (phase === Phase.WALL_BUILD) {
        tickBuildPhase(dt);
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
