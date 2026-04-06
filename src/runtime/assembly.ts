import { fireNextReadyCannon } from "../game/battle-system.ts";
import { placePiece } from "../game/build-system.ts";
import type {
  ComputeLobbyLayoutFn,
  LobbyClickHitTestFn,
} from "../render/render-composition.ts";
import type {
  ControlsScreenHitTestFn,
  OptionsScreenHitTestFn,
} from "../render/render-ui-settings.ts";
import { MAX_FRAME_DT } from "../shared/game-constants.ts";
import { Phase } from "../shared/game-phase.ts";
import type { GameMap, Viewport } from "../shared/geometry-types.ts";
import type { RenderOverlay } from "../shared/overlay-types.ts";
import type { PlayerSlotId, ValidPlayerSlot } from "../shared/player-slot.ts";
import type { CycleOptionFn } from "../shared/settings-ui.ts";
import type {
  BattleViewState,
  BuildViewState,
  CannonViewState,
  HapticsSystem,
  InputReceiver,
  PlayerController,
  SoundSystem,
} from "../shared/system-interfaces.ts";
import { Mode } from "../shared/ui-mode.ts";
import type {
  CloseControlsFn,
  CloseOptionsFn,
  CreateControlsOverlayFn,
  CreateLobbyOverlayFn,
  CreateOptionsOverlayFn,
  LobbyKeyJoinFn,
  LobbySkipStepFn,
  ShowControlsFn,
  ShowOptionsFn,
  TickLobbyFn,
  TogglePauseFn,
  UIContext,
  VisibleOptionsFn,
} from "./runtime-screen-builders.ts";
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
      gs: CannonViewState,
      max: number,
    ) => boolean;
    tryPlacePieceAndSend: (
      ctrl: PlayerController & InputReceiver,
      gs: BuildViewState,
    ) => boolean;
    fireAndSend: (ctrl: PlayerController, gs: BattleViewState) => void;
    getIsHost: () => boolean;
  };
}

type RenderFrameFn = (
  map: GameMap,
  overlay: RenderOverlay | undefined,
  viewport?: Viewport | null,
) => void;

interface RuntimeOptionsDeps {
  runtimeState: RuntimeState;
  uiCtx: UIContext;
  renderFrame: RenderFrameFn;
  updateDpad: (enabled: boolean) => void;
  setDpadLeftHanded: (left: boolean) => void;
  refreshLobbySeed: () => void;
  sound: Pick<SoundSystem, "setLevel">;
  haptics: Pick<HapticsSystem, "setLevel">;
  isOnline: boolean;
  getRemoteHumanSlots: () => ReadonlySet<number>;
  onCloseOptions?: () => void;
  controlsScreenHitTest: ControlsScreenHitTestFn;
  optionsScreenHitTest: OptionsScreenHitTestFn;
  closeControlsShared: CloseControlsFn;
  closeOptionsShared: CloseOptionsFn;
  createControlsOverlay: CreateControlsOverlayFn;
  createOptionsOverlay: CreateOptionsOverlayFn;
  showControlsShared: ShowControlsFn;
  showOptionsShared: ShowOptionsFn;
  togglePauseShared: TogglePauseFn;
  visibleOptions: VisibleOptionsFn;
  cycleOption: CycleOptionFn;
}

interface RuntimeLobbyDeps {
  runtimeState: RuntimeState;
  uiCtx: UIContext;
  renderFrame: RenderFrameFn;
  refreshLobbySeed: () => void;
  showOptions: () => Promise<void>;
  isOnline: boolean;
  onTickLobbyExpired: () => void | Promise<void>;
  onLobbySlotJoined: (pid: ValidPlayerSlot) => void;
  createLobbyOverlay: CreateLobbyOverlayFn;
  lobbyKeyJoin: LobbyKeyJoinFn;
  lobbySkipStep: LobbySkipStepFn;
  tickLobby: TickLobbyFn;
  computeLobbyLayout: ComputeLobbyLayoutFn;
  lobbyClickHitTest: LobbyClickHitTestFn;
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
    const dt = Math.min(
      (now - deps.runtimeState.lastTime) / 1000,
      MAX_FRAME_DT,
    );
    deps.runtimeState.lastTime = now;
    return dt;
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

export function createRuntimeOptionsDeps(
  params: RuntimeOptionsDeps,
): RuntimeOptionsDeps {
  return params;
}

export function createRuntimeLobbyDeps(
  params: RuntimeLobbyDeps,
): RuntimeLobbyDeps {
  return params;
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
        ((ctrl, gs) => {
          const intent = ctrl.tryPlacePiece(gs);
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
        ((ctrl, gs) => {
          const intent = ctrl.fire(gs);
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
