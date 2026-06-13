import { isCannonPlacementComplete } from "../game/index.ts";
import {
  MAX_FRAME_DT,
  PHASE_ENDING_THRESHOLD,
  SIM_TICK_DT,
  SimTickAccumulator,
} from "../shared/core/game-constants.ts";
import { isTimedPhase, Phase } from "../shared/core/game-phase.ts";
import {
  isActivePlayer,
  type PlayerId,
  type ValidPlayerId,
} from "../shared/core/player-slot.ts";
import type { FrameContext } from "../shared/core/types.ts";
import {
  LifeLostChoice,
  type QuitState,
} from "../shared/ui/interaction-types.ts";
import {
  isGameplayMode,
  isTransitionMode,
  Mode,
} from "../shared/ui/ui-mode.ts";
import {
  bankLockstepDebt,
  consumeLockstepDebtTicks,
  isPaused,
  isSessionLive,
  lockstepDebtTicks,
  type RuntimeState,
} from "./state.ts";
import type { TimingApi } from "./timing-api.ts";

/** Modes that have tick handlers. STOPPED is handled by early-return. */
type TickableMode = Exclude<Mode, Mode.STOPPED>;

/** Single per-frame tick dispatcher. The composition root implements this
 *  as a `switch (mode)` with an `assertNever` default so an unhandled
 *  Mode is a loud runtime failure rather than a silent no-op. The
 *  `TickableMode`-typed parameter also forces a compile error if a new
 *  Mode is added without a corresponding case. */
type TickDispatch = (mode: TickableMode, dt: number) => void;

interface FrameContextInputs {
  mode: Mode;
  phase: Phase;
  timer: number;
  paused: boolean;
  quitPending: boolean;
  hasLifeLostDialog: boolean;
  /** True iff the life-lost dialog is open AND the local pov player has an
   *  unresolved entry. Drives the keep-zoom-on-local-zone branch in the
   *  camera. Computed by the caller so this layer doesn't depend on dialog
   *  internals. */
  lifeLostLocalPending: boolean;
  isSelectionReady: boolean;
  hasPointerPlayer: boolean;
  /** Resolved point-of-view slot — online: myPlayerId, local: pointer
   *  player slot, demo: 0. Derived once per substep by the caller (the
   *  same value feeds the lifeLostLocalPending check). */
  povPlayerId: ValidPlayerId;
  myPlayerId: PlayerId;
  hostAtFrameStart: boolean;
  remotePlayerSlots: ReadonlySet<ValidPlayerId>;
  mobileAutoZoom: boolean;
  humanCannonsComplete: boolean;
  humanCastleConfirmed: boolean;
}

interface RuntimeLoopDeps {
  runtimeState: RuntimeState;
  /** True while this runtime is a peer in a live online lockstep match.
   *  Gates the sim-debt mechanism: frame gaps beyond MAX_FRAME_DT are
   *  banked (`bankLockstepDebt`) instead of dropped, then repaid as extra
   *  sub-steps. Offline, dropping the gap is correct (solo sim — nobody
   *  else's timeline to fall behind). */
  isLockstepSession: () => boolean;
  /** Injected timing primitives — replaces bare `requestAnimationFrame` access
   *  when scheduling the next main-loop tick. */
  timing: TimingApi;
  myPlayerId: () => PlayerId;
  amHost: () => boolean;
  remotePlayerSlots: () => ReadonlySet<ValidPlayerId>;
  getPointerPlayer: () => { playerId: ValidPlayerId } | null;
  clearHumanCache: () => void;
  isSelectionReady: () => boolean;
  isMobileAutoZoom: () => boolean;
  tickCamera: () => void;
  tickScoreDelta: (dt: number) => void;
  /** Tick the cannon-facing animator. Must run AFTER the mode tick: it reads
   *  `frame.crosshairs`, which is emptied by `clearFrameData` each substep and
   *  only repopulated by the mode tick's `syncCrosshairs`. Eased displayed
   *  facings live in the runtime so the renderer just reads displayed values
   *  via the setter installed at composition time. At battle-end the phase
   *  machine snaps them to rest (`snapToRest`) for the banner snapshot but
   *  never gates a transition on the ease — cosmetic facing must not drive
   *  game-flow timing. */
  tickCannonAnimator: (dt: number) => void;
  /** The real render entrypoint. Called once per browser frame from
   *  `mainLoop`, and only when `runtimeState.renderDirty` is set — the
   *  dirty flag is the dedup mechanism that prevents the spiral-of-death
   *  (multiple substeps per browser frame each issuing their own render). */
  render: () => void;
  /** Mark the frame as needing a render. Tick handlers call this instead
   *  of `render` directly so that N substeps coalesce into a single render
   *  per browser frame. */
  requestRender: () => void;
  /** Single dispatcher invoked once per sim sub-step. Implemented as a
   *  switch + assertNever in the composition root so an unknown mode is
   *  a loud failure rather than a silent no-op. */
  tickMode: (mode: Exclude<Mode, Mode.STOPPED>, dt: number) => void;
  onAfterFrame?: () => void;
}

export function createRuntimeLoop(deps: RuntimeLoopDeps): {
  clearFrameData: () => void;
  mainLoop: (now: number) => void;
} {
  function clearFrameData(): void {
    // Preserve sticky fields (gameOver) that outlive a single tick.
    // If you add a sticky field to FrameData, preserve it here.
    const prev = deps.runtimeState.frame;
    deps.runtimeState.frame = {
      crosshairs: [],
      ...(prev?.gameOver !== undefined ? { gameOver: prev.gameOver } : {}),
    };
    deps.clearHumanCache();
  }

  /** Returns real elapsed dt, capped at MAX_FRAME_DT — tab-hide / long
   *  pauses produce huge deltas and would let entities skip collision
   *  boundaries in a single tick. Speed-up happens via sub-stepping in
   *  `mainLoop`, never by inflating dt.
   *
   *  Offline, the excess beyond the cap is discarded (resume where you
   *  left off). Online it is BANKED as lockstep debt and repaid by extra
   *  sub-steps over the following frames — a peer that silently dropped
   *  the gap would run permanently behind the other peers, its `applyAt`
   *  stamps would land in their past, and the match would fork. */
  function clampedFrameDt(now: number): number {
    const fixed = deps.runtimeState.fixedStepMs;
    if (fixed !== undefined) {
      deps.runtimeState.lastTime = now;
      return fixed / 1000;
    }
    const raw = (now - deps.runtimeState.lastTime) / 1000;
    deps.runtimeState.lastTime = now;
    if (raw <= MAX_FRAME_DT) return raw;
    if (deps.isLockstepSession()) {
      bankLockstepDebt(deps.runtimeState, raw - MAX_FRAME_DT);
    }
    return MAX_FRAME_DT;
  }

  /** Maximum simulation ticks per real frame. Prevents runaway catch-up
   *  when a long pause is followed by a resume (e.g. tab hidden).
   *  At 16× speed with ~16ms frames, expect ~16 ticks; with 100ms E2E
   *  frames expect ~96. Cap generously above both. */
  const MAX_TICKS_PER_FRAME = 128;

  /** Lockstep debt repayment rate — extra sub-steps per frame while owed
   *  sim time exists. 32 replays a 2s tab-hide in ~4 frames and a 60s one
   *  in ~2s, while keeping the per-frame budget bounded on slow devices.
   *  Healthy frames add ≤ MAX_FRAME_DT/SIM_TICK_DT (= 6) regular ticks on
   *  top, comfortably under MAX_TICKS_PER_FRAME. */
  const LOCKSTEP_CATCHUP_TICKS_PER_FRAME = 32;

  /** Only surface the catch-up banner for real gaps — sub-150ms stalls
   *  (GC, decode jank) repay invisibly within a frame or two. */
  const LOCKSTEP_ANNOUNCE_DEBT_TICKS = 9;

  const simAccum = new SimTickAccumulator();

  /** Run the per-tick logic once with a fixed dt (SIM_TICK_DT). Extracted
   *  from `mainLoop` so we can call it N times per real frame. */
  function runOneSubStep(): void {
    const dt = SIM_TICK_DT;
    deps.runtimeState.frameDt = dt;
    clearFrameData();

    // Advance the game's logical-tick counter once per fixed sim tick on
    // every peer. Gated on `isSessionLive` so we only count ticks that
    // map to actual gameplay — lobby/pre-init runs RAF before state
    // exists, and post-`returnToLobby` runs RAF against a frozen state
    // we must not touch. This counter is the basis for `applyAt` stamps
    // on the scheduled-actions queue — every peer must increment in
    // lockstep for cross-peer determinism.
    //
    // Gated on the pause flag for the same reason: a paused substep skips
    // `tickMode` (the pause gate in `tickMainLoop` below), so counting it
    // would detach simTick from game progress — and draining would apply
    // scheduled actions under a frozen sim. The gate never skews peers:
    // no pause source can hold a live online sim — `togglePause` and
    // mid-game F1 are disabled while online, and the composition root's
    // visibility listener skips the visibility pause for live online
    // sessions (the hidden-tab freeze is instead banked as lockstep debt
    // and replayed — see `clampedFrameDt`). `isSessionLive` already
    // implies a gameplay mode, so this matches the `tickMainLoop` skip
    // exactly.
    //
    // Drain runs immediately after the increment, before any phase-tick
    // logic. This is the single point where wire-broadcast actions
    // mutate state on every peer — both originator and receiver enqueue
    // with the same `applyAt`, the queue sorts by `(applyAt, playerId)`,
    // and `applyPiecePlacement` (and friends) fire in identical order on
    // every peer. RNG-consuming downstream logic (recheckTerritory →
    // removeEnclosedGruntsAndRespawn) consumes state.rng identically.
    if (isSessionLive(deps.runtimeState) && !isPaused(deps.runtimeState)) {
      deps.runtimeState.state.simTick++;
      deps.runtimeState.actionSchedule.drainUpTo(
        deps.runtimeState.state.simTick,
        deps.runtimeState.state,
      );
    }

    // Catch-up is presentational too: while meaningfully behind, tell the
    // player why the board is fast-forwarding. Per-substep frame data, so
    // the banner disappears on its own the moment the debt is repaid.
    if (lockstepDebtTicks(deps.runtimeState) >= LOCKSTEP_ANNOUNCE_DEBT_TICKS) {
      deps.runtimeState.frame.announcement = "CATCHING UP…";
    }

    const pointer = deps.getPointerPlayer();
    const myId = deps.myPlayerId();
    const humanId: ValidPlayerId | null = isActivePlayer(myId)
      ? myId
      : (pointer?.playerId ?? null);
    // Single povPlayerId derivation — online → myId, local → pointer
    // slot, demo → 0. Feeds both the dialog membership check below
    // (computed here so this layer doesn't import the lifeLost types
    // tier) and `frameMeta.povPlayerId` via computeFrameContext.
    const povSlot: ValidPlayerId = isActivePlayer(myId)
      ? myId
      : ((pointer?.playerId ?? 0) as ValidPlayerId);
    const lifeLostDialog = deps.runtimeState.dialogs.lifeLost;
    const lifeLostLocalPending =
      lifeLostDialog !== null &&
      lifeLostDialog.entries.some(
        (entry) =>
          entry.playerId === povSlot && entry.choice === LifeLostChoice.PENDING,
      );

    const sessionLive = isSessionLive(deps.runtimeState);
    deps.runtimeState.frameMeta = computeFrameContext({
      mode: deps.runtimeState.mode,
      phase: sessionLive ? deps.runtimeState.state.phase : Phase.CASTLE_SELECT,
      timer: sessionLive ? deps.runtimeState.state.timer : 0,
      paused: isPaused(deps.runtimeState),
      quitPending: deps.runtimeState.quit.pending,
      hasLifeLostDialog: lifeLostDialog !== null,
      lifeLostLocalPending,
      isSelectionReady: deps.isSelectionReady(),
      hasPointerPlayer: pointer !== null,
      povPlayerId: povSlot,
      myPlayerId: myId,
      hostAtFrameStart: deps.amHost(),
      remotePlayerSlots: deps.remotePlayerSlots(),
      mobileAutoZoom: deps.isMobileAutoZoom(),
      humanCannonsComplete: computeHumanCannonsComplete(
        deps.runtimeState,
        humanId,
      ),
      humanCastleConfirmed: computeHumanCastleConfirmed(
        deps.runtimeState,
        humanId,
      ),
    });

    deps.tickCamera();
    // The overlay ticks outside `tickMode` because it spans non-GAME
    // display modes (Mode.TRANSITION owns the round-end overlay), but it
    // must observe the same freezes as the rest of the sim: the pause
    // gate below and the non-ticking menu modes (mid-game OPTIONS /
    // CONTROLS). Un-gated, the overlay expires under the menu and its
    // continuation advances the round-end chain — popping the life-lost
    // dialog or routing the next phase entry out from under the frozen
    // screen.
    if (
      isGameplayMode(deps.runtimeState.mode) &&
      !isPaused(deps.runtimeState)
    ) {
      deps.tickScoreDelta(dt);
    }

    tickMainLoop({
      dt,
      mode: deps.runtimeState.mode,
      paused: isPaused(deps.runtimeState),
      quit: deps.runtimeState.quit,
      frame: deps.runtimeState.frame,
      setQuit: (quit) => {
        deps.runtimeState.quit = quit;
      },
      requestRender: deps.requestRender,
      tickMode: deps.tickMode,
    });

    // MUST run after `tickMainLoop`: the cannon-animator reads
    // `frame.crosshairs`, which `clearFrameData` empties at the top of this
    // substep and only the mode tick (`syncCrosshairs`) repopulates. Ticking
    // it before the mode tick made the animator read an empty crosshair list
    // every frame, so cannons never tracked the crosshair during battle.
    // Frozen under pause for the same reason `tickScoreDelta` is: the paused
    // mode tick skips `syncCrosshairs`, so the list is empty here and the
    // animator would ease every cannon to its rest facing while the render
    // (which repopulates crosshairs for the paused frame) still draws them.
    if (!isPaused(deps.runtimeState)) deps.tickCannonAnimator(dt);
  }

  function mainLoop(now: number): void {
    const realDt = clampedFrameDt(now);
    // Speed multiplier scales how much simulation time is fed into the
    // accumulator — higher speed = more fixed ticks per real frame.
    const simDt = realDt * deps.runtimeState.speedMultiplier;
    let ticks = Math.min(simAccum.drain(simDt), MAX_TICKS_PER_FRAME);
    // Repay banked lockstep debt as extra sub-steps: a deterministic
    // fast-forward replay against the action queue (the socket kept
    // receiving while the tab was hidden, so every remote action is
    // already enqueued at its stamped tick). Gated on the same predicate
    // as the simTick increment — a paused or dead-session sub-step would
    // burn debt without advancing the sim.
    if (
      deps.isLockstepSession() &&
      !isPaused(deps.runtimeState) &&
      lockstepDebtTicks(deps.runtimeState) > 0
    ) {
      ticks += consumeLockstepDebtTicks(
        deps.runtimeState,
        LOCKSTEP_CATCHUP_TICKS_PER_FRAME,
      );
    }

    for (let i = 0; i < ticks; i++) {
      // Skip substep work when no session is installed (initial state,
      // post-game-over, online disconnect). The loop itself keeps
      // self-scheduling so a fresh game can resume tick work without
      // anyone needing to "kick" the loop back on.
      if (deps.runtimeState.mode === Mode.STOPPED) break;
      runOneSubStep();
    }

    // Drain render-dirty once per browser frame. Tick handlers set the
    // flag via `requestRender`; the actual render fires here, after all
    // substeps have advanced state. Coalescing N substep renders into 1
    // is the spiral-of-death fix — only the last image is ever painted
    // by the browser anyway, so the wasted N-1 renders bought nothing.
    if (deps.runtimeState.renderDirty) {
      deps.runtimeState.renderDirty = false;
      deps.render();
    }

    deps.onAfterFrame?.();
    deps.timing.requestFrame(mainLoop);
  }

  return { clearFrameData, mainLoop };
}

/** Run the main loop tick: quit countdown, pause check, mode dispatch.
 *  No-ops in `Mode.STOPPED` (no active session). */
function tickMainLoop(params: {
  readonly dt: number;
  readonly mode: Mode;
  readonly paused: boolean;
  readonly quit: QuitState;
  readonly frame: { announcement?: string };
  readonly setQuit: (quit: QuitState) => void;
  readonly requestRender: () => void;
  readonly tickMode: TickDispatch;
}): void {
  const { dt, mode, frame, tickMode } = params;

  // Tick ESC-to-quit countdown
  if (params.quit.pending) {
    const next = params.quit.timer - dt;
    if (next <= 0) {
      params.setQuit({ pending: false });
    } else {
      params.setQuit({
        pending: true,
        timer: next,
        message: params.quit.message,
      });
      frame.announcement = params.quit.message;
    }
  }

  // Pause: keep rendering but skip all game ticks
  if (params.paused && isGameplayMode(mode)) {
    if (!frame.announcement) frame.announcement = "PAUSED";
    params.requestRender();
    return;
  }

  if (mode === Mode.STOPPED) return;

  tickMode(mode, dt);
}

function computeFrameContext(inputs: FrameContextInputs): FrameContext {
  const {
    mode,
    phase,
    timer,
    paused,
    quitPending,
    hasLifeLostDialog,
    lifeLostLocalPending,
    isSelectionReady,
    hasPointerPlayer,
    povPlayerId,
    myPlayerId,
    hostAtFrameStart,
    remotePlayerSlots,
    mobileAutoZoom,
    humanCannonsComplete,
    humanCastleConfirmed,
  } = inputs;

  // The local player has an unresolved life-lost entry: the camera should
  // hold their home zone instead of unzooming. Gated on mobileAutoZoom — on
  // desktop the popup sits over a fullMap view as before.
  const lifeLostKeepZoom = mobileAutoZoom && lifeLostLocalPending;

  const phaseEnding =
    !mobileAutoZoom &&
    timer > 0 &&
    timer <= PHASE_ENDING_THRESHOLD &&
    isTimedPhase(phase);

  const inBattle = phase === Phase.BATTLE;
  const isTransition = isTransitionMode(mode);
  const shouldUnzoom =
    paused ||
    quitPending ||
    (hasLifeLostDialog && !lifeLostKeepZoom) ||
    phaseEnding ||
    isTransition ||
    (mobileAutoZoom && (humanCannonsComplete || humanCastleConfirmed));

  return {
    myPlayerId,
    povPlayerId,
    hostAtFrameStart,
    remotePlayerSlots,
    mode,
    inBattle,
    isSelectionReady,
    hasPointerPlayer,
    shouldUnzoom,
    lifeLostKeepZoom,
    isTransition,
  };
}

/** True when this client's human has confirmed a castle. Used to trigger a
 *  local unzoom on mobile the moment the player has picked, without waiting
 *  for the global phase dispatch (which waits for all players + animations). */
function computeHumanCastleConfirmed(
  runtimeState: RuntimeState,
  humanId: ValidPlayerId | null,
): boolean {
  if (humanId === null) return false;
  if (!isSessionLive(runtimeState)) return false;
  const state = runtimeState.state;
  if (state.phase !== Phase.CASTLE_SELECT) return false;
  // `player.inGracePeriod` flips true at confirm-time (set by
  // `confirmTowerSelection`, cleared in `finalizeBattle`), covering both the
  // round-1 initial selection and the mid-game reselect cycle.
  const player = state.players[humanId];
  return (
    player != null && player.inGracePeriod && player.castleWallTiles.size > 0
  );
}

/** True when this client's human has filled their cannon-slot quota. Used to
 *  trigger a local unzoom on mobile the moment the player is done placing,
 *  without waiting for the global phase dispatch. */
function computeHumanCannonsComplete(
  runtimeState: RuntimeState,
  humanId: ValidPlayerId | null,
): boolean {
  if (humanId === null) return false;
  if (!isSessionLive(runtimeState)) return false;
  const state = runtimeState.state;
  if (state.phase !== Phase.CANNON_PLACE) return false;
  const player = state.players[humanId];
  const maxSlots = state.cannonLimits[humanId] ?? 0;
  if (!player || maxSlots <= 0) return false;
  return isCannonPlacementComplete(player, maxSlots, state);
}
