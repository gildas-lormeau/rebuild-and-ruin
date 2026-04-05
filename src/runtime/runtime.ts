/**
 * Shared game runtime factory — composition root that wires subsystems.
 *
 * createGameRuntime(config) creates all subsystems (camera, score-delta,
 * banner, selection, render, lifecycle, life-lost, upgrade-pick, phase-ticks,
 * lobby, options, input, human-lookup), wires their deps, and returns a
 * narrow GameRuntime handle.
 *
 * Used by both main.ts (local play) and runtime-online-game.ts (online).
 */

import { snapshotTerritory } from "../game/battle-system.ts";
import { generateMap } from "../game/map-generation.ts";
import { createHapticsSystem } from "../input/haptics-system.ts";
import { dispatchPointerMove } from "../input/input-dispatch.ts";
import { registerKeyboardHandlers } from "../input/input-keyboard.ts";
import { registerMouseHandlers } from "../input/input-mouse.ts";
import { registerTouchHandlers } from "../input/input-touch-canvas.ts";
import {
  createDpad,
  createEnemyZoomButton,
  createFloatingActions,
  createHomeZoomButton,
  createQuitButton,
} from "../input/input-touch-ui.ts";
import { createSoundSystem } from "../input/sound-system.ts";
import {
  computeLobbyLayout,
  createBannerUi,
  createOnlineOverlay,
  createRenderSummaryMessage,
  createStatusBar,
  gameOverButtonHitTest,
  handleLifeLostDialogClick,
  handleUpgradePickClick,
  lifeLostPanelPos,
  lobbyClickHitTest,
  updateSelectionOverlay,
} from "../render/render-composition.ts";
import { precomputeTerrainCache } from "../render/render-map.ts";
import {
  controlsScreenHitTest,
  optionsScreenHitTest,
} from "../render/render-ui-settings.ts";
import {
  MAX_FRAME_DT,
  SELECT_ANNOUNCEMENT_DURATION,
} from "../shared/game-constants.ts";
import { Mode, Phase } from "../shared/game-phase.ts";
import type { GameMap, Viewport } from "../shared/geometry-types.ts";
import { MAP_PX_H, MAP_PX_W, SCALE } from "../shared/grid.ts";
import type { RenderOverlay } from "../shared/overlay-types.ts";
import { IS_DEV, IS_TOUCH_DEVICE } from "../shared/platform.ts";
import { computeGameSeed } from "../shared/player-config.ts";
import {
  closeControls,
  closeOptions,
  createControlsOverlay,
  createLobbyOverlay,
  createOptionsOverlay,
  lobbyKeyJoin,
  lobbySkipStep,
  showControls,
  showOptions,
  tickLobby,
  togglePause,
  type UIContext,
  visibleOptions,
} from "../shared/screen-builders.ts";
import { cycleOption } from "../shared/settings-ui.ts";
import { createBannerSystem } from "./runtime-banner.ts";
import {
  bootstrapNewGameFromSettings,
  enterTowerSelection,
} from "./runtime-bootstrap.ts";
import { createCameraSystem } from "./runtime-camera.ts";
import { exposeE2EBridge } from "./runtime-e2e-bridge.ts";
import {
  buildLifecycleDeps,
  createGameLifecycle,
} from "./runtime-game-lifecycle.ts";
import { createPointerPlayerLookup } from "./runtime-human.ts";
import { createInputSystem, type TouchHandles } from "./runtime-input.ts";
import {
  createLifeLostSystem,
  type LifeLostSystem,
} from "./runtime-life-lost.ts";
import { createLobbySystem } from "./runtime-lobby.ts";
import { createOptionsSystem } from "./runtime-options.ts";
import {
  createPhaseTicksSystem,
  type PhaseTicksSystem,
} from "./runtime-phase-ticks.ts";
import { createRenderSystem } from "./runtime-render.ts";
import { createScoreDeltaSystem } from "./runtime-score-deltas.ts";
import { createSelectionSystem } from "./runtime-selection.ts";
import {
  computeFrameContext,
  createRuntimeState,
  isStateReady,
  safeState,
  setMode,
  tickMainLoop,
} from "./runtime-state.ts";
import { type GameRuntime, type RuntimeConfig } from "./runtime-types.ts";
import {
  createUpgradePickSystem,
  type UpgradePickSystem,
} from "./runtime-upgrade-pick.ts";

export type { GameRuntime } from "./runtime-types.ts";

export function createGameRuntime(config: RuntimeConfig): GameRuntime {
  const { renderer } = config;
  const { container: gameContainer } = renderer;
  const isOnline = !!config.onlineConfig;

  // -------------------------------------------------------------------------
  // Mutable state (shared bag — see runtime-state.ts)
  // -------------------------------------------------------------------------

  const runtimeState = createRuntimeState();
  const haptics = createHapticsSystem();
  haptics.setLevel(runtimeState.settings.haptics);
  const sound = createSoundSystem();
  sound.setLevel(runtimeState.settings.sound);

  // Touch handles created early — render, options, and lifecycle read them
  // via closure. Populated later when createInputSystem() wires DOM handlers.
  const touchHandles: TouchHandles = {
    dpad: null,
    floatingActions: null,
    homeZoomButton: null,
    enemyZoomButton: null,
    quitButton: null,
    loupeHandle: null,
  };

  /** Refresh lobby seed + map preview only if the seed changed. */
  function refreshLobbySeed(): void {
    const newSeed = computeGameSeed(runtimeState.settings);
    if (newSeed !== runtimeState.lobby.seed) {
      runtimeState.lobby.seed = newSeed;
      config.log(`[lobby] seed: ${newSeed}`);
      runtimeState.lobby.map = generateMap(newSeed);
      precomputeTerrainCache(runtimeState.lobby.map);
    }
  }

  // -------------------------------------------------------------------------
  // Frame/timing helpers
  // -------------------------------------------------------------------------

  function clearFrameData(): void {
    // gameOver persists until the player acts (rematch/menu), so it
    // survives per-frame resets — everything else is transient.
    const { gameOver } = runtimeState.frame;
    runtimeState.frame = { crosshairs: [], phantoms: {} };
    if (gameOver) runtimeState.frame.gameOver = gameOver;
    clearHumanCache();
  }

  function clampedFrameDt(now: number): number {
    const dt = Math.min((now - runtimeState.lastTime) / 1000, MAX_FRAME_DT);
    runtimeState.lastTime = now;
    return dt;
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  // TickDispatch (runtime-state.ts) is Record<TickableMode, ...> where
  // TickableMode = Exclude<Mode, Mode.STOPPED>. Adding a new Mode without
  // a corresponding ticker entry here is a compile error.
  // Hoisted outside mainLoop — closures are stable, avoids per-frame allocation.
  const modeTickers = {
    [Mode.LOBBY]: (dt: number) => lobby.tickLobby(dt),
    [Mode.OPTIONS]: () => options.renderOptions(),
    [Mode.CONTROLS]: () => options.renderControls(),
    [Mode.SELECTION]: (dt: number) => selection.tick(dt),
    [Mode.BANNER]: (dt: number) => tickBanner(dt),
    [Mode.BALLOON_ANIM]: (dt: number) => phaseTicks.tickBalloonAnim(dt),
    [Mode.CASTLE_BUILD]: (dt: number) => selection.tickCastleBuild(dt),
    [Mode.LIFE_LOST]: (dt: number) => lifeLost.tick(dt),
    [Mode.UPGRADE_PICK]: (dt: number) => upgradePick.tick(dt),
    [Mode.GAME]: (dt: number) => phaseTicks.tickGame(dt),
  } satisfies Record<Exclude<Mode, Mode.STOPPED>, (dt: number) => void>;

  function mainLoop(now: number): void {
    const dt = clampedFrameDt(now);
    runtimeState.frameDt = dt;
    clearFrameData();

    const pointer = pointerPlayer();

    runtimeState.frameMeta = computeFrameContext({
      mode: runtimeState.mode,
      phase: isStateReady(runtimeState)
        ? runtimeState.state.phase
        : Phase.CASTLE_SELECT,
      timer: isStateReady(runtimeState) ? runtimeState.state.timer : 0,
      paused: runtimeState.paused,
      quitPending: runtimeState.quit.pending,
      hasLifeLostDialog: runtimeState.lifeLostDialog !== null,
      isSelectionReady: isSelectionReady(),
      humanIsReselecting:
        pointer !== null &&
        runtimeState.reselectQueue.includes(pointer.playerId),
      hasPointerPlayer: pointer !== null,
      myPlayerId: config.getMyPlayerId(),
      hostAtFrameStart: config.getIsHost(),
      remoteHumanSlots: config.getRemoteHumanSlots(),
      mobileAutoZoom: camera.isMobileAutoZoom(),
    });

    tickCamera();
    scoreDelta.tick(dt);

    const shouldContinue = tickMainLoop({
      dt,
      mode: runtimeState.mode,
      paused: runtimeState.paused,
      quitPending: runtimeState.quit.pending,
      quitTimer: runtimeState.quit.timer,
      quitMessage: runtimeState.quit.message,
      frame: runtimeState.frame,
      setQuitPending: (quitPending: boolean) => {
        runtimeState.quit.pending = quitPending;
      },
      setQuitTimer: (quitTimer: number) => {
        runtimeState.quit.timer = quitTimer;
      },
      render,
      ticks: modeTickers,
    });

    if (IS_DEV) exposeE2EBridge({ runtimeState, config, camera, renderer });
    if (shouldContinue && runtimeState.mode !== Mode.STOPPED)
      requestAnimationFrame(mainLoop);
  }

  // -------------------------------------------------------------------------
  // Rendering / frame helpers
  // -------------------------------------------------------------------------

  function renderFrame(
    map: GameMap,
    overlay: RenderOverlay | undefined,
    viewport?: Viewport | null,
  ): void {
    renderer.drawFrame(map, overlay, viewport, performance.now());
  }

  /** True once the selection announcement has finished playing and input is unblocked.
   *  Guard pattern: `if (!isSelectionReady()) return;` blocks input during announcement. */
  function isSelectionReady(): boolean {
    return (
      runtimeState.accum.selectAnnouncement >= SELECT_ANNOUNCEMENT_DURATION
    );
  }

  // -------------------------------------------------------------------------
  // Human-player lookup (delegated to runtime-human.ts)
  // -------------------------------------------------------------------------

  const {
    pointerPlayer,
    withPointerPlayer,
    clearCache: clearHumanCache,
  } = createPointerPlayerLookup(runtimeState);

  // -------------------------------------------------------------------------
  // Camera / zoom (delegated to runtime-camera.ts)
  // -------------------------------------------------------------------------

  const camera = createCameraSystem({
    getState: () => safeState(runtimeState),
    getCtx: () => runtimeState.frameMeta,
    getFrameDt: () => runtimeState.frameDt,
    setFrameAnnouncement: (text) => {
      runtimeState.frame.announcement = text;
    },
    getPointerPlayerCrosshair: () => {
      const h = pointerPlayer();
      if (!h) return null;
      const ch = h.getCrosshair();
      return { x: ch.x, y: ch.y };
    },
    setPointerPlayerCrosshair: (x, y) => {
      const h = pointerPlayer();
      if (h) h.setCrosshair(x, y);
    },
  });

  const { tickCamera, updateViewport } = camera;

  // -------------------------------------------------------------------------
  // Score delta sub-system (delegated to runtime-score-deltas.ts)
  // -------------------------------------------------------------------------

  const scoreDelta = createScoreDeltaSystem({
    runtimeState,
    clearPhaseZoom: camera.clearPhaseZoom,
  });

  // -------------------------------------------------------------------------
  // Banner sub-system (delegated to runtime-banner.ts)
  // -------------------------------------------------------------------------

  const {
    showBanner,
    tickBanner,
    clearSnapshots: clearBannerSnapshots,
    reset: resetBanner,
  } = createBannerSystem({
    runtimeState,
    clearPhaseZoom: camera.clearPhaseZoom,
    log: config.log,
    haptics,
    sound,
    render: () => render(),
  });

  // -------------------------------------------------------------------------
  // Selection sub-system (delegated to runtime-selection.ts)
  // -------------------------------------------------------------------------

  const selection = createSelectionSystem({
    runtimeState,
    send: config.send,
    log: config.log,
    camera,
    sound,
    syncSelectionOverlay: updateSelectionOverlay,
    render: () => render(),
    pointerPlayer,
    startCannonPhase: (onDone) => phaseTicks.startCannonPhase(onDone),
    enterTowerSelectionImpl: enterTowerSelection,
    clearBannerSnapshots,
    requestFrame: () => {
      if (runtimeState.mode === Mode.STOPPED) requestAnimationFrame(mainLoop);
    },
  });

  // -------------------------------------------------------------------------
  // Render sub-system (delegated to runtime-render.ts)
  // -------------------------------------------------------------------------

  const render = createRenderSystem({
    runtimeState,
    createBannerUi,
    createOnlineOverlay,
    createRenderSummaryMessage,
    createStatusBar,
    drawFrame: (map, overlay, viewport, now) =>
      renderer.drawFrame(map, overlay, viewport, now),
    logThrottled: config.logThrottled,
    syncCrosshairs: (expired) => phaseTicks.syncCrosshairs(expired),
    getLifeLostPanelPos: (pid) => lifeLost.panelPos(pid),
    updateViewport,
    pointerPlayer,
    getTouch: () => touchHandles,
    worldToScreen: camera.worldToScreen,
    screenToContainerCSS: renderer.screenToContainerCSS,
    getContainerHeight: () => gameContainer.clientHeight,
  });

  // -------------------------------------------------------------------------
  // Game lifecycle (delegated to runtime-game-lifecycle.ts)
  // -------------------------------------------------------------------------

  const lifecycle = createGameLifecycle(
    buildLifecycleDeps({
      runtimeState,
      config,
      render,
      requestMainLoop: () => requestAnimationFrame(mainLoop),
      bootstrapNewGame: () =>
        bootstrapNewGameFromSettings(
          runtimeState,
          config.log,
          config.getUrlRoundsOverride,
          {
            clearFrameData,
            resetUIState: () => lifecycle.resetUIState(),
            enterSelection: selection.enter,
          },
        ),
      selection,
      banner: { reset: resetBanner },
      camera,
      getLifeLost: () => lifeLost,
      getUpgradePick: () => upgradePick,
      scoreDelta,
      sound,
      input: {
        resetForLobby: (rs) => input.resetForLobby(rs),
      },
      hitTestGameOver: (canvasX, canvasY) => {
        const gameOver = runtimeState.frame.gameOver;
        if (!gameOver) return null;
        return gameOverButtonHitTest(
          canvasX / SCALE,
          canvasY / SCALE,
          MAP_PX_W,
          MAP_PX_H,
          gameOver,
        );
      },
      isTouchDevice: IS_TOUCH_DEVICE,
    }),
  );

  // -------------------------------------------------------------------------
  // Life-lost sub-system (delegated to runtime-life-lost.ts)
  // -------------------------------------------------------------------------

  const lifeLost: LifeLostSystem = createLifeLostSystem({
    runtimeState,
    send: config.send,
    log: config.log,
    render,
    panelPos: (pid) => lifeLostPanelPos(runtimeState.state, pid),
    endGame: lifecycle.endGame,
    startReselection: selection.startReselection,
    advanceToCannonPhase: selection.advanceToCannonPhase,
  });

  // -------------------------------------------------------------------------
  // Upgrade pick sub-system (delegated to runtime-upgrade-pick.ts)
  // -------------------------------------------------------------------------

  const upgradePick: UpgradePickSystem = createUpgradePickSystem({
    runtimeState,
    log: config.log,
    render,
    send: isOnline ? config.send : undefined,
  });

  // -------------------------------------------------------------------------
  // Phase ticks sub-system (delegated to runtime-phase-ticks.ts)
  // -------------------------------------------------------------------------

  const phaseTicks: PhaseTicksSystem = createPhaseTicksSystem({
    runtimeState,
    send: config.send,
    log: config.log,
    hostNetworking: config.onlineConfig?.hostNetworking,
    watcherTiming: config.onlineConfig?.watcherTiming,
    extendCrosshairs: config.onlineConfig?.extendCrosshairs,
    onLocalCrosshairCollected: config.onlineConfig?.onLocalCrosshairCollected,
    tickNonHost: config.onlineConfig?.tickNonHost,
    everyTick: config.onlineConfig?.everyTick,
    render,
    showBanner,
    lifeLost,
    scoreDelta,
    snapshotTerritory: () => snapshotTerritory(runtimeState.state.players),
    saveBattleCrosshair: IS_TOUCH_DEVICE
      ? camera.saveBattleCrosshair
      : undefined,
    onBeginBattle: IS_TOUCH_DEVICE ? camera.aimAtEnemyCastle : undefined,
    sound,
    haptics,
    tryShowUpgradePick: (onDone) => upgradePick.tryShow(onDone),
  });

  // -------------------------------------------------------------------------
  // UIContext — bridges internal state to game-ui-screens.ts functions
  // -------------------------------------------------------------------------

  const uiCtx: UIContext = {
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
    getLobbyRemaining: config.getLobbyRemaining,
    isOnline,
  };

  // Initialize options system first (lobby depends on showOptions)
  const options = createOptionsSystem({
    runtimeState,
    uiCtx,
    renderFrame,
    // Bridge boolean enable to dpad's Phase|null API (WALL_BUILD = any non-selection phase)
    updateDpad: (enabled) =>
      touchHandles.dpad?.update(enabled ? Phase.WALL_BUILD : null),
    setDpadLeftHanded: (left) => touchHandles.dpad?.setLeftHanded(left),
    refreshLobbySeed,
    sound,
    haptics,
    isOnline,
    getRemoteHumanSlots: config.getRemoteHumanSlots,
    onCloseOptions: config.onCloseOptions,
    controlsScreenHitTest,
    optionsScreenHitTest,
    closeControlsShared: closeControls,
    closeOptionsShared: closeOptions,
    createControlsOverlay,
    createOptionsOverlay,
    showControlsShared: showControls,
    showOptionsShared: showOptions,
    togglePauseShared: togglePause,
    visibleOptions,
    cycleOption,
  });

  // Initialize lobby system (needs options.showOptions)
  const lobby = createLobbySystem({
    runtimeState,
    uiCtx,
    renderFrame,
    refreshLobbySeed,
    showOptions: options.showOptions,
    isOnline,
    onTickLobbyExpired: config.onTickLobbyExpired,
    onLobbySlotJoined: config.onLobbySlotJoined,
    createLobbyOverlay,
    lobbyKeyJoin,
    lobbySkipStep,
    tickLobby,
    computeLobbyLayout,
    lobbyClickHitTest,
  });

  // -------------------------------------------------------------------------
  // Input sub-system (all deps now available — standard factory pattern)
  // -------------------------------------------------------------------------

  const input = createInputSystem({
    touchHandles,
    runtimeState,
    renderer,
    gameContainer,
    hitTests: {
      lifeLostDialogClick: (screenX, screenY) => {
        if (!runtimeState.lifeLostDialog) return null;
        return handleLifeLostDialogClick({
          state: runtimeState.state,
          lifeLostDialog: runtimeState.lifeLostDialog,
          screenX,
          screenY,
        });
      },
      upgradePickClick: (screenX, screenY) => {
        if (!runtimeState.upgradePickDialog) return null;
        return handleUpgradePickClick({
          W: MAP_PX_W,
          H: MAP_PX_H,
          dialog: runtimeState.upgradePickDialog,
          screenX,
          screenY,
        });
      },
      visibleOptionCount: () => visibleOptions(uiCtx).length,
    },
    network: {
      isOnline,
      maybeSendAimUpdate: config.onlineConfig?.maybeSendAimUpdate,
      tryPlaceCannonAndSend: config.onlineConfig?.tryPlaceCannonAndSend,
      tryPlacePieceAndSend: config.onlineConfig?.tryPlacePieceAndSend,
      fireAndSend: config.onlineConfig?.fireAndSend,
      getIsHost: config.getIsHost,
    },
    lobby,
    options,
    lifeLost,
    upgradePick,
    selection: { ...selection, isReady: isSelectionReady },
    camera,
    sound,
    haptics,
    inputHandlers: {
      dispatchPointerMove,
      registerKeyboard: registerKeyboardHandlers,
      registerMouse: registerMouseHandlers,
      registerTouch: registerTouchHandlers,
    },
    touchFactories: {
      createDpad,
      createQuitButton,
      createHomeZoomButton,
      createEnemyZoomButton,
      createFloatingActions,
    },
    lifecycle: {
      render,
      rematch: lifecycle.rematch,
      returnToLobby: lifecycle.returnToLobby,
      gameOverClick: lifecycle.gameOverClick,
    },
    pointerPlayer,
    withPointerPlayer,
  });

  // -------------------------------------------------------------------------
  // Return the runtime object
  // -------------------------------------------------------------------------

  return {
    runtimeState,

    // Sub-system handles
    selection,
    lifeLost,
    sound,
    haptics,
    lobby: { renderLobby: lobby.renderLobby },
    lifecycle: {
      startGame: lifecycle.startGame,
      resetUIState: lifecycle.resetUIState,
    },
    phaseTicks: {
      startCannonPhase: phaseTicks.startCannonPhase,
      beginBattle: phaseTicks.beginBattle,
    },

    upgradePick,
    scoreDelta: {
      show: scoreDelta.show,
      setPreScores: scoreDelta.setPreScores,
    },

    // Cross-cutting orchestration
    mainLoop,
    clearFrameData,
    render,
    showBanner,
    snapshotTerritory: () => snapshotTerritory(runtimeState.state.players),
    aimAtEnemyCastle: camera.aimAtEnemyCastle,
  };
}
