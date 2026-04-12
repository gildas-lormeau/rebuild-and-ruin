import { MAX_FRAME_DT } from "../shared/core/game-constants.ts";
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
import {
  computeFrameContext,
  isStateReady,
  type RuntimeState,
  tickMainLoop,
} from "./runtime-state.ts";
import type { RuntimeConfig, TimingApi } from "./runtime-types.ts";

/** Action surface consumed by the input dispatcher.
 *
 *  This is NOT NetworkApi (the runtime/ ↔ peers seam). It's the bag of
 *  network-aware game-action wrappers (`tryPlacePieceAndSend` etc.) with
 *  local fallbacks installed when offline. The "AndSend" suffix on each
 *  method is a misnomer in local mode — there the function just executes
 *  the action and skips the network step.
 *
 *  Named `actions` (not `network`) to avoid confusion with
 *  `RuntimeConfig.network: NetworkApi`. */
interface RuntimeInputAdapters {
  actions: {
    maybeSendAimUpdate?: (x: number, y: number) => void;
    tryPlaceCannonAndSend?: (
      ctrl: PlayerController & InputReceiver,
      gameState: CannonViewState,
      max: number,
    ) => boolean;
    tryPlacePieceAndSend: (
      ctrl: PlayerController & InputReceiver,
      gameState: BuildViewState,
    ) => boolean;
    fireAndSend: (ctrl: PlayerController, gameState: BattleViewState) => void;
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
  ticks: Record<Exclude<Mode, Mode.STOPPED>, (dt: number) => void>;
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

  /** Compute clamped frame delta time. Always returns the *real* elapsed
   *  delta — speed-up is achieved by sub-stepping inside `mainLoop`, NOT
   *  by inflating dt. Multiplying dt would let grunts and cannonballs skip
   *  past collision boundaries (a single tick would advance them across
   *  multiple tiles), drift the RNG consumption order, and cause phase
   *  timers to skip event boundaries. */
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

  /** Maximum sub-step count per real frame. Capped because higher values
   *  pin the CPU without producing perceptibly faster gameplay (the browser
   *  needs to display each frame). Matches the cap in `__dev.speed`. */
  const MAX_SUB_STEPS = 16;

  /** Run the per-tick logic once with the given `dt`. Extracted from
   *  `mainLoop` so we can call it N times per real frame when
   *  `speedMultiplier > 1` — N sub-steps with normal-sized dt is the
   *  *only* way to speed up the simulation without breaking determinism.
   *  Returns false when the loop should stop scheduling further frames
   *  (Mode.STOPPED). */
  function runOneSubStep(dt: number): boolean {
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
      paused: deps.runtimeState.paused,
      quitPending: deps.runtimeState.quit.pending,
      hasLifeLostDialog: deps.runtimeState.dialogs.lifeLost !== null,
      isSelectionReady: deps.isSelectionReady(),
      humanIsReselecting:
        pointer !== null &&
        deps.runtimeState.selection.reselectionPids.includes(pointer.playerId),
      hasPointerPlayer: pointer !== null,
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
      paused: deps.runtimeState.paused,
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
      ticks: deps.ticks,
    });
  }

  function mainLoop(now: number): void {
    const dt = clampedFrameDt(now);
    const subSteps = Math.max(
      1,
      Math.min(MAX_SUB_STEPS, Math.floor(deps.runtimeState.speedMultiplier)),
    );

    let shouldContinue = true;
    for (let i = 0; i < subSteps; i++) {
      if (deps.runtimeState.mode === Mode.STOPPED) {
        shouldContinue = false;
        break;
      }
      shouldContinue = runOneSubStep(dt);
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
      tryPlaceCannonAndSend: config.onlineActions?.tryPlaceCannonAndSend,
      tryPlacePieceAndSend:
        config.onlineActions?.tryPlacePieceAndSend ??
        ((ctrl, gameState) => params.localPlacePiece(ctrl, gameState)),
      fireAndSend:
        config.onlineActions?.fireAndSend ??
        ((ctrl, gameState) => params.localFire(ctrl, gameState)),
    },
  };
}
