import { MAX_FRAME_DT } from "../shared/game-constants.ts";
import { Phase } from "../shared/game-phase.ts";
import { createEmptyFrameData } from "../shared/overlay-types.ts";
import type { PlayerSlotId, ValidPlayerSlot } from "../shared/player-slot.ts";
import type {
  BattleViewState,
  BuildViewState,
  CannonViewState,
  InputReceiver,
  PlayerController,
} from "../shared/system-interfaces.ts";
import { Mode } from "../shared/ui-mode.ts";
import {
  computeFrameContext,
  isStateReady,
  type RuntimeState,
  tickMainLoop,
} from "./runtime-state.ts";
import type { RuntimeConfig, TimingApi } from "./runtime-types.ts";

interface RuntimeInputAdapters {
  network: {
    isOnline?: boolean;
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
    getIsHost: () => boolean;
  };
}

interface RuntimeLoopDeps {
  runtimeState: RuntimeState;
  /** Injected timing primitives — replaces bare `requestAnimationFrame` access
   *  when scheduling the next main-loop tick. */
  timing: TimingApi;
  getMyPlayerId: () => PlayerSlotId;
  getIsHost: () => boolean;
  getRemotePlayerSlots: () => Set<number>;
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

  /** Compute clamped frame delta time, scaled by the dev speed multiplier.
   *  Note: speedMultiplier affects ALL modes (lobby, banner, score deltas),
   *  not just gameplay ticks. This is intentional for dev testing but means
   *  lobby timers and UI transitions also run at the modified speed. */
  function clampedFrameDt(now: number): number {
    const raw = Math.min(
      (now - deps.runtimeState.lastTime) / 1000,
      MAX_FRAME_DT,
    );
    deps.runtimeState.lastTime = now;
    return raw * deps.runtimeState.speedMultiplier;
  }

  function mainLoop(now: number): void {
    const dt = clampedFrameDt(now);
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
      myPlayerId: deps.getMyPlayerId(),
      hostAtFrameStart: deps.getIsHost(),
      remotePlayerSlots: deps.getRemotePlayerSlots(),
      mobileAutoZoom: deps.isMobileAutoZoom(),
    });

    deps.tickCamera();
    deps.tickScoreDelta(dt);

    const shouldContinue = tickMainLoop({
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

    deps.onAfterFrame?.();
    if (shouldContinue && deps.runtimeState.mode !== Mode.STOPPED) {
      deps.timing.requestFrame(mainLoop);
    }
  }

  return { clearFrameData, mainLoop };
}

export function createRuntimeInputAdapters(params: {
  config: RuntimeConfig;
  isOnline: boolean;
  localPlacePiece: (
    ctrl: PlayerController & InputReceiver,
    gameState: BuildViewState,
  ) => boolean;
  localFire: (ctrl: PlayerController, gameState: BattleViewState) => void;
}): RuntimeInputAdapters {
  const { config, isOnline } = params;
  return {
    network: {
      isOnline,
      maybeSendAimUpdate: config.onlineConfig?.maybeSendAimUpdate,
      tryPlaceCannonAndSend: config.onlineConfig?.tryPlaceCannonAndSend,
      tryPlacePieceAndSend:
        config.onlineConfig?.tryPlacePieceAndSend ??
        ((ctrl, gameState) => params.localPlacePiece(ctrl, gameState)),
      fireAndSend:
        config.onlineConfig?.fireAndSend ??
        ((ctrl, gameState) => params.localFire(ctrl, gameState)),
      getIsHost: config.network.getIsHost,
    },
  };
}
