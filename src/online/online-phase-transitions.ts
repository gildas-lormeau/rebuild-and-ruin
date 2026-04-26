import { prepareControllerCannonPhase, resetZoneState } from "../game/index.ts";
import { MESSAGE, type ServerMessage } from "../protocol/protocol.ts";
import type { TimingApi } from "../runtime/runtime-contracts.ts";
import {
  type PhaseTransitionCtx,
  ROLE_WATCHER,
  runTransition,
  type TransitionId,
} from "../runtime/runtime-phase-machine.ts";
import { type RuntimeState, setMode } from "../runtime/runtime-state.ts";
import type { GameRuntime } from "../runtime/runtime-types.ts";
import {
  type BalloonFlight,
  clearImpacts,
} from "../shared/core/battle-types.ts";
import { Phase } from "../shared/core/game-phase.ts";
import {
  isActivePlayer,
  type ValidPlayerSlot,
} from "../shared/core/player-slot.ts";
import { isPlayerAlive } from "../shared/core/player-types.ts";
import {
  FOCUS_REMATCH,
  LifeLostChoice,
} from "../shared/ui/interaction-types.ts";
import { PLAYER_COLORS } from "../shared/ui/player-config.ts";
import {
  applyBattleStartWatcherUI,
  applyCannonStartWatcherUI,
  type CheckpointDeps,
} from "./online-checkpoints.ts";
import type { OnlineSession } from "./online-session.ts";
import { setWatcherPhaseTimerAtBannerEnd } from "./online-types.ts";
import type { WatcherState } from "./online-watcher-tick.ts";

/** Dependencies the watcher-side transition handlers need.
 *
 *  Passed to every handler. Handlers build a `PhaseTransitionCtx` from this
 *  and dispatch to `runTransition(id, ctx)` — the state machine then runs
 *  the role-appropriate mutate/display/postDisplay steps.
 *
 *  - `getRuntime` is a closure so the bag can be constructed BEFORE the
 *    runtime itself (circular init order).
 *  - `session` carries the watcher's own player id plus early-choice maps
 *    that buffer dialog picks arriving ahead of the host's checkpoint. */
export interface WatcherDeps {
  readonly getRuntime: () => GameRuntime;
  readonly session: Pick<
    OnlineSession,
    "myPlayerId" | "earlyLifeLostChoices" | "earlyUpgradePickChoices"
  >;
  readonly watcher: Pick<
    WatcherState,
    "timing" | "remoteCrosshairs" | "watcherCrosshairPos"
  >;
  /** Injected timing primitives — threaded into the watcher-role
   *  `PhaseTransitionCtx` so display steps (e.g. `proceedToBattle`'s
   *  pitch-settle watchdog) schedule through the same mock clock that
   *  drives headless tests. */
  readonly timing: TimingApi;
}

/** Watcher-only: processes CANNON_START checkpoint and transitions to
 *  cannon phase. Dispatches to `advance-to-cannon` — the three host-side
 *  entry points (castle-select-done / castle-reselect-done /
 *  advance-to-cannon) all broadcast the same CANNON_START message and
 *  share watcher display + postDisplay, so one id is enough. */
export function handleCannonStartTransition(
  msg: ServerMessage,
  deps: WatcherDeps,
): void {
  if (msg.type !== MESSAGE.CANNON_START) return;
  const state = deps.getRuntime().runtimeState.state;
  // Dedup guard: full-state recovery already set phase. Just init the
  // local controller; skip banner + mode transition.
  if (state.phase === Phase.CANNON_PLACE) {
    initLocalCannonControllerIfActive(deps);
    return;
  }
  dispatchWatcher("advance-to-cannon", msg, deps);
}

/** Watcher-only: processes BATTLE_START checkpoint and transitions to
 *  battle phase. */
export function handleBattleStartTransition(
  msg: ServerMessage,
  deps: WatcherDeps,
): void {
  if (msg.type !== MESSAGE.BATTLE_START) return;
  dispatchWatcher("cannon-place-done", msg, deps);
}

/** Watcher-only: processes BUILD_START checkpoint and transitions to build
 *  phase. */
export function handleBuildStartTransition(
  msg: ServerMessage,
  deps: WatcherDeps,
): void {
  if (msg.type !== MESSAGE.BUILD_START) return;
  dispatchWatcher("battle-done", msg, deps);
}

/** Watcher-only: processes BUILD_END checkpoint. Score deltas + life-lost
 *  dialog are driven by the machine's display steps (`score-overlay` then
 *  `life-lost-dialog`). No banner — the banner sweep happens later when
 *  the host broadcasts CANNON_START (or the next life-lost resolution). */
export function handleBuildEndTransition(
  msg: ServerMessage,
  deps: WatcherDeps,
): void {
  if (msg.type !== MESSAGE.BUILD_END) return;
  dispatchWatcher("wall-build-done", msg, deps);
}

/** Watcher-only: builds the final game-over frame from the host's
 *  authoritative scores and runs the shared terminal sequence. Not
 *  machine-driven — game-over isn't a phase transition, it's a
 *  terminal state. */
export function handleGameOverTransition(
  msg: ServerMessage,
  deps: WatcherDeps,
): void {
  if (msg.type !== MESSAGE.GAME_OVER) return;
  const runtime = deps.getRuntime();
  runtime.lifecycle.finalizeGameOver(() => {
    runtime.runtimeState.frame.gameOver = {
      winner: msg.winner,
      scores: msg.scores.map((score, idx) => ({
        ...score,
        color: PLAYER_COLORS[idx % PLAYER_COLORS.length]!.wall,
      })),
      focused: FOCUS_REMATCH,
    };
  });
}

/** Dispatch a watcher-role transition from a LOCAL trigger (no incoming
 *  server message). Used by phase ticks that expire deterministically
 *  on both sides — e.g. `tickWatcher` detecting `MODIFIER_REVEAL` timer
 *  expiry and dispatching `enter-battle`. The ctx is built with no
 *  `incomingMsg`; transitions that read one must not be dispatched via
 *  this helper. */
export function dispatchWatcherLocal(
  id: TransitionId,
  deps: WatcherDeps,
): void {
  runTransition(id, buildWatcherPhaseCtx(undefined, deps));
}

function dispatchWatcher(
  id: TransitionId,
  msg: ServerMessage,
  deps: WatcherDeps,
): void {
  runTransition(id, buildWatcherPhaseCtx(msg, deps));
}

/** Assemble the watcher-role `PhaseTransitionCtx` consumed by the machine.
 *
 *  Every hook that the watcher actually uses in the current set of
 *  transitions (advance-to-cannon, cannon-place-done, battle-done,
 *  wall-build-done) is populated. Host-only hooks (broadcast, endGame,
 *  initLocalCannonControllers w/ entry, etc.) are omitted. */
function buildWatcherPhaseCtx(
  msg: ServerMessage | undefined,
  deps: WatcherDeps,
): PhaseTransitionCtx {
  const runtime = deps.getRuntime();
  const runtimeState = runtime.runtimeState;
  const myPlayerId = deps.session.myPlayerId;
  return {
    state: runtimeState.state,
    runtimeState,
    role: ROLE_WATCHER,
    timing: deps.timing,
    showBanner: runtime.showBanner,
    hideBanner: runtime.hideBanner,
    onCameraReady: runtime.onCameraReady,
    setMode: (mode) => setMode(runtimeState, mode),
    log: (text) => {
      // Watcher logs go through the shared runtime log (not client.devLog);
      // the log string is informational and low-volume on the watcher.
      if (text) void text;
    },
    scoreDelta: {
      show: (onDone) => runtime.scoreDelta.show(onDone),
      // Reset / isActive are host-only concerns; watcher never reads them.
      reset: () => {},
      isActive: () => false,
      setPreScores: (scores) => runtime.scoreDelta.setPreScores([...scores]),
    },
    lifeLost: {
      show: (needsReselect, eliminated, onResolved) =>
        showLifeLostDialogWithEarlyChoices(
          runtime,
          needsReselect,
          eliminated,
          deps.session.earlyLifeLostChoices,
          onResolved,
        ),
    },
    // Watcher route: the host's next checkpoint (CANNON_START / the
    // next life-lost outcome) drives continue / reselect, so both
    // stay no-op. Game-over is terminal — when the watcher observes
    // round-limit or last-player-standing locally (which can race
    // ahead of the host's MESSAGE.GAME_OVER), we run the shared
    // terminal sequence with a no-op frame painter; the authoritative
    // frame arrives via `handleGameOverTransition` when the message
    // lands, and re-running teardown there is idempotent.
    lifeLostRoute: {
      onGameOver: () => runtime.lifecycle.finalizeGameOver(() => {}),
      onReselect: () => {},
      onContinue: () => {},
    },
    notifyLifeLost: (pid) => {
      if (pid === myPlayerId) runtimeState.controllers[pid]?.onLifeLost();
    },
    upgradePick: {
      prepare: () => runtime.upgradePick.prepare(),
      tryShow: (onDone) =>
        showUpgradePickWithEarlyChoices(
          runtime,
          onDone,
          deps.session.earlyUpgradePickChoices,
        ),
      getDialog: () => runtime.upgradePick.get(),
      clear: () => runtime.upgradePick.set(null),
    },
    battle: buildWatcherBattleHooks(runtime),
    checkpoint: buildWatcherCheckpointHooks(deps),
    watcher: buildWatcherHooks(deps),
    incomingMsg: msg,
    // Pids of players who reselected this round — populated by selection
    // system as confirmations come in. Read by the watcher's CANNON_PLACE
    // entry mutate to call `finalizeReselectedPlayers` (mirrors host).
    reselectionPids: runtimeState.selection.reselectionPids,
    getPitchState: runtime.getPitchState,
    beginBattleTilt: runtime.beginBattleTilt,
    engageAutoZoom: runtime.engageAutoZoom,
  };
}

function buildWatcherBattleHooks(runtime: GameRuntime) {
  const battleAnim = runtime.runtimeState.battleAnim;
  return {
    setFlights: (flights: { flight: BalloonFlight; progress: number }[]) => {
      battleAnim.flights = flights;
    },
    setTerritory: (territory: readonly Set<number>[]) => {
      battleAnim.territory = territory as Set<number>[];
    },
    setWalls: (walls: readonly Set<number>[]) => {
      battleAnim.walls = walls as Set<number>[];
    },
    clearImpacts: () => clearImpacts(battleAnim),
    begin: () => runtime.phaseTicks.beginBattle(),
  };
}

function buildWatcherCheckpointHooks(deps: WatcherDeps) {
  return {
    applyCannonStart: () => {
      applyCannonStartWatcherUI(buildCheckpointDeps(deps));
      // Selection overlay is a UI concern tied to the host's state handoff;
      // clear it here so the cannon banner reveals against a clean scene.
      clearSelectionOverlay(deps.getRuntime().runtimeState);
    },
    applyBattleStartWatcherUI: () => {
      applyBattleStartWatcherUI(buildCheckpointDeps(deps));
    },
  };
}

function buildWatcherHooks(deps: WatcherDeps) {
  return {
    setPhaseTimerAtBannerEnd: (phaseDuration: number) => {
      setWatcherPhaseTimerAtBannerEnd(
        deps.watcher.timing,
        phaseDuration,
        deps.timing.now(),
      );
    },
    initLocalCannonControllerIfActive: () =>
      initLocalCannonControllerIfActive(deps),
    initLocalBuildControllerIfActive: () =>
      initLocalBuildControllerIfActive(deps),
    resetRemovedPlayerZones: (
      needsReselect: readonly ValidPlayerSlot[],
      eliminated: readonly ValidPlayerSlot[],
    ) => {
      const state = deps.getRuntime().runtimeState.state;
      for (const pid of [...needsReselect, ...eliminated]) {
        const zone = state.playerZones[pid];
        if (zone !== undefined) resetZoneState(state, zone);
      }
    },
  };
}

function buildCheckpointDeps(deps: WatcherDeps): CheckpointDeps {
  const runtime = deps.getRuntime();
  return {
    state: runtime.runtimeState.state,
    accum: runtime.runtimeState.accum,
    remoteCrosshairs: deps.watcher.remoteCrosshairs,
    watcherCrosshairPos: deps.watcher.watcherCrosshairPos,
    snapshotTerritory: () => runtime.snapshotTerritory(),
  };
}

function initLocalCannonControllerIfActive(deps: WatcherDeps): void {
  const myPlayerId = deps.session.myPlayerId;
  if (!isActivePlayer(myPlayerId)) return;
  const runtime = deps.getRuntime();
  const state = runtime.runtimeState.state;
  const ctrl = runtime.runtimeState.controllers[myPlayerId];
  if (!ctrl) return;
  const prep = prepareControllerCannonPhase(ctrl.playerId, state);
  if (!prep) return;
  ctrl.placeCannons(state, prep.maxSlots);
  ctrl.cannonCursor = prep.cursorPos;
  ctrl.startCannonPhase(state);
}

function initLocalBuildControllerIfActive(deps: WatcherDeps): void {
  const myPlayerId = deps.session.myPlayerId;
  if (!isActivePlayer(myPlayerId)) return;
  const runtime = deps.getRuntime();
  const state = runtime.runtimeState.state;
  const player = state.players[myPlayerId];
  if (!isPlayerAlive(player)) return;
  runtime.runtimeState.controllers[myPlayerId]?.startBuildPhase(state);
}

function clearSelectionOverlay(runtimeState: RuntimeState): void {
  const overlay = runtimeState.overlay;
  if (overlay.selection) {
    overlay.selection.highlights = undefined;
    overlay.selection.highlighted = null;
    overlay.selection.selected = null;
  }
}

function showLifeLostDialogWithEarlyChoices(
  runtime: GameRuntime,
  needsReselect: readonly ValidPlayerSlot[],
  eliminated: readonly ValidPlayerSlot[],
  earlyChoices: Map<number, LifeLostChoice>,
  onResolved: (continuing: readonly ValidPlayerSlot[]) => void,
): boolean {
  const shown = runtime.lifeLost.show(needsReselect, eliminated, onResolved);
  const dialog = runtime.lifeLost.get();
  if (dialog) {
    for (const [playerId, choice] of earlyChoices) {
      const entry = dialog.entries.find((e) => e.playerId === playerId);
      if (entry && entry.choice === LifeLostChoice.PENDING) {
        entry.choice = choice;
      }
    }
  }
  earlyChoices.clear();
  return shown;
}

function showUpgradePickWithEarlyChoices(
  runtime: GameRuntime,
  onDone: () => void,
  earlyChoices: Map<number, string>,
): boolean {
  const shown = runtime.upgradePick.tryShow(onDone);
  if (!shown) return false;
  const dialog = runtime.upgradePick.get();
  if (dialog) {
    for (const [playerId, choice] of earlyChoices) {
      const entry = dialog.entries.find(
        (e) =>
          e.playerId === playerId &&
          e.choice === null &&
          e.offers.includes(choice as never),
      );
      if (entry) entry.choice = choice as never;
    }
    earlyChoices.clear();
  }
  return true;
}
