import { cannonSlotsUsed } from "../game/index.ts";
import {
  MAX_FRAME_DT,
  SIM_TICK_DT,
  SimTickAccumulator,
} from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import {
  isActivePlayer,
  type PlayerSlotId,
  type ValidPlayerSlot,
} from "../shared/core/player-slot.ts";
import type {
  BattleViewState,
  BuildViewState,
  CannonViewState,
  InputReceiver,
  PlayerController,
} from "../shared/core/system-interfaces.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import type { TimingApi } from "./runtime-contracts.ts";
import {
  computeFrameContext,
  isPaused,
  isSessionLive,
  type RuntimeState,
  tickMainLoop,
} from "./runtime-state.ts";
import type { RuntimeConfig } from "./runtime-types.ts";

/** Action adapters executed locally; online callers wrap them to also
 *  broadcast. Named `actions` (not `network`) because offline games use
 *  the same surface — adapters collapse to local-only fallbacks. */
interface RuntimeInputAdapters {
  actions: {
    maybeSendAimUpdate?: (x: number, y: number) => void;
    tryPlaceCannon?: (
      ctrl: PlayerController & InputReceiver,
      gameState: CannonViewState,
      max: number,
    ) => boolean;
    tryPlacePiece: (
      ctrl: PlayerController & InputReceiver,
      gameState: BuildViewState,
    ) => boolean;
    fire: (ctrl: PlayerController, gameState: BattleViewState) => void;
  };
}

interface RuntimeLoopDeps {
  runtimeState: RuntimeState;
  /** Injected timing primitives — replaces bare `requestAnimationFrame` access
   *  when scheduling the next main-loop tick. */
  timing: TimingApi;
  myPlayerId: () => PlayerSlotId;
  amHost: () => boolean;
  remotePlayerSlots: () => ReadonlySet<ValidPlayerSlot>;
  getPointerPlayer: () => { playerId: ValidPlayerSlot } | null;
  clearHumanCache: () => void;
  isSelectionReady: () => boolean;
  isMobileAutoZoom: () => boolean;
  tickCamera: () => void;
  tickScoreDelta: (dt: number) => void;
  /** Tick the cannon-facing animator (mode-independent, like score-delta).
   *  Eased displayed facings live in the runtime so the battle-end gate
   *  can poll `cannonAnimator.allSettled()` without depending on the
   *  renderer — the renderer just reads displayed values via the setter
   *  installed at composition time. */
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
   *  `mainLoop`, never by inflating dt. */
  function clampedFrameDt(now: number): number {
    const fixed = deps.runtimeState.fixedStepMs;
    if (fixed !== undefined) {
      deps.runtimeState.lastTime = now;
      return fixed / 1000;
    }
    const raw = Math.min(
      (now - deps.runtimeState.lastTime) / 1000,
      MAX_FRAME_DT,
    );
    deps.runtimeState.lastTime = now;
    return raw;
  }

  /** Maximum simulation ticks per real frame. Prevents runaway catch-up
   *  when a long pause is followed by a resume (e.g. tab hidden).
   *  At 16× speed with ~16ms frames, expect ~16 ticks; with 100ms E2E
   *  frames expect ~96. Cap generously above both. */
  const MAX_TICKS_PER_FRAME = 128;

  const simAccum = new SimTickAccumulator();

  /** Run the per-tick logic once with a fixed dt (SIM_TICK_DT). Extracted
   *  from `mainLoop` so we can call it N times per real frame. Returns
   *  false when the loop should stop scheduling further frames. */
  function runOneSubStep(): boolean {
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
    // Drain runs immediately after the increment, before any phase-tick
    // logic. This is the single point where wire-broadcast actions
    // mutate state on every peer — both originator and receiver enqueue
    // with the same `applyAt`, the queue sorts by `(applyAt, playerId)`,
    // and `applyPiecePlacement` (and friends) fire in identical order on
    // every peer. RNG-consuming downstream logic (recheckTerritory →
    // removeEnclosedGruntsAndRespawn) consumes state.rng identically.
    if (isSessionLive(deps.runtimeState)) {
      deps.runtimeState.state.simTick++;
      deps.runtimeState.actionSchedule.drainUpTo(
        deps.runtimeState.state.simTick,
        deps.runtimeState.state,
      );
    }

    const pointer = deps.getPointerPlayer();
    const myId = deps.myPlayerId();
    const humanId: ValidPlayerSlot | null = isActivePlayer(myId)
      ? myId
      : (pointer?.playerId ?? null);
    const humanIsReselecting =
      pointer !== null &&
      deps.runtimeState.selection.reselectionPids.includes(pointer.playerId);

    const sessionLive = isSessionLive(deps.runtimeState);
    deps.runtimeState.frameMeta = computeFrameContext({
      mode: deps.runtimeState.mode,
      phase: sessionLive ? deps.runtimeState.state.phase : Phase.CASTLE_SELECT,
      timer: sessionLive ? deps.runtimeState.state.timer : 0,
      paused: isPaused(deps.runtimeState),
      quitPending: deps.runtimeState.quit.pending,
      hasLifeLostDialog: deps.runtimeState.dialogs.lifeLost !== null,
      isSelectionReady: deps.isSelectionReady(),
      humanIsReselecting,
      hasPointerPlayer: pointer !== null,
      pointerPlayerId: pointer?.playerId ?? null,
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
        humanIsReselecting,
      ),
    });

    deps.tickCamera();
    deps.tickScoreDelta(dt);
    deps.tickCannonAnimator(dt);

    return tickMainLoop({
      dt,
      mode: deps.runtimeState.mode,
      paused: isPaused(deps.runtimeState),
      quitPending: deps.runtimeState.quit.pending,
      quitTimer: deps.runtimeState.quit.timer,
      quitMessage: deps.runtimeState.quit.message,
      frame: deps.runtimeState.frame,
      setQuitPending: (quitPending: boolean) => {
        deps.runtimeState.quit.pending = quitPending;
      },
      setQuitTimer: (quitTimer: number) => {
        deps.runtimeState.quit.timer = quitTimer;
      },
      requestRender: deps.requestRender,
      tickMode: deps.tickMode,
    });
  }

  function mainLoop(now: number): void {
    const realDt = clampedFrameDt(now);
    // Speed multiplier scales how much simulation time is fed into the
    // accumulator — higher speed = more fixed ticks per real frame.
    const simDt = realDt * deps.runtimeState.speedMultiplier;
    const ticks = Math.min(simAccum.drain(simDt), MAX_TICKS_PER_FRAME);

    let shouldContinue = true;
    for (let i = 0; i < ticks; i++) {
      if (deps.runtimeState.mode === Mode.STOPPED) {
        shouldContinue = false;
        break;
      }
      shouldContinue = runOneSubStep();
      if (!shouldContinue) break;
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
    if (shouldContinue && deps.runtimeState.mode !== Mode.STOPPED) {
      deps.timing.requestFrame(mainLoop);
    }
  }

  return { clearFrameData, mainLoop };
}

export function createRuntimeInputAdapters(params: {
  config: RuntimeConfig;
  localPlacePiece: (
    ctrl: PlayerController & InputReceiver,
    gameState: BuildViewState,
  ) => boolean;
  localFire: (ctrl: PlayerController, gameState: BattleViewState) => void;
}): RuntimeInputAdapters {
  const { config } = params;
  return {
    actions: {
      maybeSendAimUpdate: config.onlineActions?.maybeSendAimUpdate,
      tryPlaceCannon: config.onlineActions?.tryPlaceCannon,
      tryPlacePiece:
        config.onlineActions?.tryPlacePiece ??
        ((ctrl, gameState) => params.localPlacePiece(ctrl, gameState)),
      fire:
        config.onlineActions?.fire ??
        ((ctrl, gameState) => params.localFire(ctrl, gameState)),
    },
  };
}

/** True when this client's human has confirmed a castle. Used to trigger a
 *  local unzoom on mobile the moment the player has picked, without waiting
 *  for the global phase dispatch (which waits for all players + animations). */
function computeHumanCastleConfirmed(
  runtimeState: RuntimeState,
  humanId: ValidPlayerSlot | null,
  humanIsReselecting: boolean,
): boolean {
  if (humanId === null) return false;
  if (!isSessionLive(runtimeState)) return false;
  const state = runtimeState.state;
  if (state.phase !== Phase.CASTLE_SELECT) return false;
  // Reselect cycle (round > 1): only the queued reselectors can build.
  // Initial selection (round === 1): every active human can build.
  if (state.round > 1 && !humanIsReselecting) return false;
  const player = state.players[humanId];
  return player != null && player.castle !== null;
}

/** True when this client's human has filled their cannon-slot quota. Used to
 *  trigger a local unzoom on mobile the moment the player is done placing,
 *  without waiting for the global phase dispatch. */
function computeHumanCannonsComplete(
  runtimeState: RuntimeState,
  humanId: ValidPlayerSlot | null,
): boolean {
  if (humanId === null) return false;
  if (!isSessionLive(runtimeState)) return false;
  const state = runtimeState.state;
  if (state.phase !== Phase.CANNON_PLACE) return false;
  const player = state.players[humanId];
  const maxSlots = state.cannonLimits[humanId] ?? 0;
  if (!player || maxSlots <= 0) return false;
  return cannonSlotsUsed(player) >= maxSlots;
}
