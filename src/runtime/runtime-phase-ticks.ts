import {
  advanceBattleCountdown,
  canBuildThisFrame,
  diffNewWalls,
  tickBattlePhase as engineTickBattlePhase,
  tickBuildPhase as engineTickBuildPhase,
  enterBuildSkippingBattle,
  nextReadyCombined,
  prepareControllerCannonPhase,
  resetCannonFacings,
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
} from "../shared/core/game-constants.ts";
import {
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
import { getInterior } from "../shared/core/player-interior.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import {
  type HapticsSystem,
  isHuman,
  type SoundSystem,
} from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import {
  PHASE_MUSIC as PHASE_MUSIC_SONGS,
  type PhaseMusic,
} from "../shared/platform/phase-music.ts";
import type { UpgradePickDialogState } from "../shared/ui/interaction-types.ts";
import type { PlayerStats } from "../shared/ui/overlay-types.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import type { GameOverReason } from "./runtime-life-lost-core.ts";
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
  /** Grab the current offscreen scene pixels into
   *  `banner.prevSceneImageData`. Called by the machine's mutate fns
   *  immediately before map-visible changes. */
  snapshotForNextBanner: () => void;
  /** Show a full-screen banner. `onDone` fires once when the sweep completes.
   *  Callers chain banners by nesting `showBanner` calls inside `onDone`. */
  showBanner: (text: string, onDone: () => void, subtitle?: string) => void;
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
  /** Read the live upgrade-pick dialog state — used by the machine to pass
   *  resolved picks into `applyUpgradePicks`. */
  getUpgradePickDialog?: () => UpgradePickDialogState | null;
  /** Tear down the upgrade-pick dialog. Called from the build banner's
   *  onDone (after the sweep) so `drawUpgradePick` can keep clipping the
   *  dialog against `banner.y` for the entire animation. The watcher path
   *  has its own counterpart at the `clearUpgradePickDialog` hook in
   *  `online-phase-transitions.ts`. */
  clearUpgradePickDialog?: () => void;
  /** End-game side effects (set game-over frame, stop sound, switch to
   *  Mode.STOPPED, arm demo timer). Wired to `lifecycle.endGame` from
   *  composition. The machine's `round-limit-reached` /
   *  `last-player-standing` mutate calls this through `ctx.endGame`. */
  endGame: (winner: { id: number }) => void;
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
  syncCrosshairs: (weaponsActive: boolean, dt?: number) => void;
  /** Subscribe the battle-event observers (sound / haptics / stats) to the
   *  current `state.bus`. Idempotent per-bus; safe (and required) to call
   *  after every new-game setState so rematches rebind to the fresh bus. */
  subscribeBusObservers: () => void;
}

/** Set of all battle event type strings — used to filter bus events. */
const BATTLE_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.values(BATTLE_MESSAGE),
);
/** Inline MIDI per game phase. `volumeScale` compensates for per-instrument
 *  loudness differences in MusyngKite (cello is ~4× louder than music_box).
 *  Phases missing from the map get silence. Battle is a one-shot Jaws
 *  stinger — plays once at phase start, silence after. */
const PHASE_MUSIC: Partial<
  Record<Phase, { song: PhaseMusic; loop: boolean; volumeScale: number }>
> = {
  [Phase.WALL_BUILD]: {
    song: PHASE_MUSIC_SONGS.build,
    loop: true,
    volumeScale: 4.0,
  },
  [Phase.CANNON_PLACE]: {
    song: PHASE_MUSIC_SONGS.cannon,
    loop: true,
    volumeScale: 2.5,
  },
  [Phase.BATTLE]: {
    song: PHASE_MUSIC_SONGS.battle,
    loop: false,
    volumeScale: 1.0,
  },
};

export function createPhaseTicksSystem(deps: PhaseTicksDeps): PhaseTicksSystem {
  const { runtimeState } = deps;
  const online = deps.online;

  // -------------------------------------------------------------------------
  // Bus → sound / haptics / stats (observation subscribers)
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
        const pov = runtimeState.frameMeta.povPlayerId;
        const evt = event as BattleEvent;
        deps.sound.battleEvents([evt], pov);
        deps.haptics.battleEvents([evt], pov);
        accumulateBattleStats([evt], runtimeState.scoreDisplay.gameStats);
      } else if (type === GAME_EVENT.BANNER_END) {
        // After any banner finishes, resume music for whatever phase
        // the game is currently in. Using runtimeState.state.phase
        // (not the banner event's phase field) so sub-banners like
        // modifier reveals correctly resume the current phase's
        // music instead of starting something unrelated.
        const entry = PHASE_MUSIC[runtimeState.state.phase];
        if (entry) {
          deps.sound.startPhaseMusic(entry.song, {
            loop: entry.loop,
            volumeScale: entry.volumeScale,
          });
        }
      }
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
      showBanner: deps.showBanner,
      snapshotForNextBanner: deps.snapshotForNextBanner,
      setMode: (mode) => setMode(runtimeState, mode),
      log: deps.log,
      scoreDelta: deps.scoreDelta,
      sound: {
        drumsStop: deps.sound.drumsStop,
        lifeLost: deps.sound.lifeLost,
      },
      soundDrumsQuiet: deps.sound.drumsQuiet,
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
      upgradePick: deps.tryShowUpgradePick
        ? {
            prepare: () => deps.prepareUpgradePick!(),
            tryShow: (onDone) => deps.tryShowUpgradePick!(onDone),
            getDialog: () => deps.getUpgradePickDialog?.() ?? null,
            clear: deps.clearUpgradePickDialog,
          }
        : undefined,
      clearUpgradePickDialog: deps.clearUpgradePickDialog,
      ceasefireSkipBattle: () => enterBuildSkippingBattle(runtimeState.state),
      startBuildPhaseLocal: startBuildPhase,
      endBattleLocalControllers: () => {
        for (const ctrl of local) ctrl.endBattle();
      },
      saveBattleCrosshair: deps.saveBattleCrosshair,
      lifeLost: {
        tryShow: deps.lifeLost.tryShow,
        resolve: (continuing) => {
          deps.lifeLost.onResolved(continuing);
        },
      },
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
            battleStart: (state, flights, modifierDiff) =>
              online?.broadcastBattleStart?.(state, [...flights], modifierDiff),
            buildStart: (state) => online?.broadcastBuildStart?.(state),
            buildEnd: (state, payload) =>
              online?.broadcastBuildEnd?.(state, {
                needsReselect: [...payload.needsReselect],
                eliminated: [...payload.eliminated],
                scores: [...payload.scores],
              }),
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
      frame.phantoms.cannonPhantoms!.push(phantom);

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
    // Broadcast only AI-originated balls — human-driven controllers
    // (including AssistedHuman) send their own CANNON_FIRED via the human
    // action path, so duplicating here would double-spawn on the receiver.
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
    // Record thaw animations for ice-break effect
    for (const evt of result.impactEvents) {
      if (evt.type === BATTLE_MESSAGE.ICE_THAWED) {
        battleAnim.thawing.push({ row: evt.row, col: evt.col, age: 0 });
      }
    }

    // Sound, haptics, and stats are now handled by bus subscribers (onAny above).

    syncCrosshairs(/* weaponsActive */ true, dt);
    deps.render();

    if (state.timer > 0 || state.cannonballs.length > 0) return false;
    // Safe margin: let impact flashes and ice-thaw animations finish before
    // capturing the "old scene" snapshot for the Build banner. Without this,
    // mid-animation explosion/thaw visuals bake into the prev-scene image.
    if (battleAnim.impacts.length > 0 || battleAnim.thawing.length > 0)
      return false;

    // Battle ended — delegate to the battle-done transition.
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
    const { state, accum, frame } = runtimeState;
    const local = localControllers(runtimeState.controllers, remotePlayerSlots);

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
          valid: phantom.valid,
        });
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
