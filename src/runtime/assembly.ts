import {
  MAX_FRAME_DT,
  SIM_TICK_DT,
  SimTickAccumulator,
} from "../shared/core/game-constants.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type {
  PlayerSlotId,
  ValidPlayerSlot,
} from "../shared/core/player-slot.ts";
import type {
  BattleViewState,
  BuildViewState,
  CannonViewState,
  InputReceiver,
  PlayerController,
} from "../shared/core/system-interfaces.ts";
import { createEmptyFrameData } from "../shared/ui/overlay-types.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import type { TimingApi } from "./runtime-contracts.ts";
import {
  computeFrameContext,
  isPaused,
  isStateReady,
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
  render: () => void;
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
    deps.runtimeState.frame = createEmptyFrameData(deps.runtimeState.frame);
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

    const pointer = deps.getPointerPlayer();

    deps.runtimeState.frameMeta = computeFrameContext({
      mode: deps.runtimeState.mode,
      phase: isStateReady(deps.runtimeState)
        ? deps.runtimeState.state.phase
        : Phase.CASTLE_SELECT,
      timer: isStateReady(deps.runtimeState)
        ? deps.runtimeState.state.timer
        : 0,
      paused: isPaused(deps.runtimeState),
      quitPending: deps.runtimeState.quit.pending,
      hasLifeLostDialog: deps.runtimeState.dialogs.lifeLost !== null,
      isSelectionReady: deps.isSelectionReady(),
      humanIsReselecting:
        pointer !== null &&
        deps.runtimeState.selection.reselectionPids.includes(pointer.playerId),
      hasPointerPlayer: pointer !== null,
      pointerPlayerId: pointer?.playerId ?? null,
      myPlayerId: deps.myPlayerId(),
      hostAtFrameStart: deps.amHost(),
      remotePlayerSlots: deps.remotePlayerSlots(),
      mobileAutoZoom: deps.isMobileAutoZoom(),
    });

    deps.tickCamera();
    deps.tickScoreDelta(dt);

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
      render: deps.render,
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
