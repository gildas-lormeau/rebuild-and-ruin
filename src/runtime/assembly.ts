import { fireNextReadyCannon } from "../game/battle-system.ts";
import { placePiece } from "../game/build-system.ts";
import type { UIContext } from "../render/render-ui-screens.ts";
import { MAX_FRAME_DT } from "../shared/game-constants.ts";
import { Phase } from "../shared/game-phase.ts";
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
  safeState,
  setMode,
  tickMainLoop,
} from "./runtime-state.ts";
import type { RuntimeConfig } from "./runtime-types.ts";

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
  getMyPlayerId: () => PlayerSlotId;
  getIsHost: () => boolean;
  getRemoteHumanSlots: () => Set<number>;
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
    const { gameOver } = deps.runtimeState.frame;
    deps.runtimeState.frame = { crosshairs: [], phantoms: {} };
    if (gameOver) deps.runtimeState.frame.gameOver = gameOver;
    deps.clearHumanCache();
  }

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
      hasLifeLostDialog: deps.runtimeState.lifeLostDialog !== null,
      isSelectionReady: deps.isSelectionReady(),
      humanIsReselecting:
        pointer !== null &&
        deps.runtimeState.reselectQueue.includes(pointer.playerId),
      hasPointerPlayer: pointer !== null,
      myPlayerId: deps.getMyPlayerId(),
      hostAtFrameStart: deps.getIsHost(),
      remoteHumanSlots: deps.getRemoteHumanSlots(),
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
      requestAnimationFrame(mainLoop);
    }
  }

  return { clearFrameData, mainLoop };
}

export function createRuntimeUiContext(params: {
  runtimeState: RuntimeState;
  getLobbyRemaining: () => number;
  isOnline: boolean;
}): UIContext {
  const { runtimeState, getLobbyRemaining, isOnline } = params;
  return {
    getState: () => safeState(runtimeState),
    getOverlay: () => runtimeState.overlay,
    settings: runtimeState.settings,
    getMode: () => runtimeState.mode,
    setMode: (mode) => {
      setMode(runtimeState, mode);
    },
    getPaused: () => runtimeState.paused,
    setPaused: (paused) => {
      runtimeState.paused = paused;
    },
    optionsCursor: {
      get value() {
        return runtimeState.optionsUI.cursor;
      },
      set value(value) {
        runtimeState.optionsUI.cursor = value;
      },
    },
    controlsState: runtimeState.controlsState,
    getOptionsReturnMode: () => runtimeState.optionsUI.returnMode,
    setOptionsReturnMode: (mode) => {
      runtimeState.optionsUI.returnMode = mode;
    },
    lobby: runtimeState.lobby,
    getFrame: () => runtimeState.frame,
    getLobbyRemaining,
    isOnline,
  };
}

export function createRuntimeInputAdapters(params: {
  config: RuntimeConfig;
  runtimeState: RuntimeState;
  isOnline: boolean;
}): RuntimeInputAdapters {
  const { config, runtimeState, isOnline } = params;
  return {
    network: {
      isOnline,
      maybeSendAimUpdate: config.onlineConfig?.maybeSendAimUpdate,
      tryPlaceCannonAndSend: config.onlineConfig?.tryPlaceCannonAndSend,
      tryPlacePieceAndSend:
        config.onlineConfig?.tryPlacePieceAndSend ??
        ((ctrl, gameState) => {
          const intent = ctrl.tryPlacePiece(gameState);
          if (!intent) return false;
          const placed = placePiece(
            runtimeState.state,
            intent.playerId,
            intent.piece,
            intent.row,
            intent.col,
          );
          if (placed) {
            ctrl.advanceBag(true);
            ctrl.clampBuildCursor(intent.piece);
          }
          return placed;
        }),
      fireAndSend:
        config.onlineConfig?.fireAndSend ??
        ((ctrl, gameState) => {
          const intent = ctrl.fire(gameState);
          if (!intent) return;
          const fired = fireNextReadyCannon(
            runtimeState.state,
            intent.playerId,
            ctrl.cannonRotationIdx,
            intent.targetRow,
            intent.targetCol,
          );
          if (fired) ctrl.cannonRotationIdx = fired.rotationIdx;
        }),
      getIsHost: config.getIsHost,
    },
  };
}
