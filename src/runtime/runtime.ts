/**
 * Shared game runtime factory — composition root that wires subsystems.
 *
 * createGameRuntime(config) creates all subsystems (camera, score-delta,
 * banner, selection, render, lifecycle, life-lost, upgrade-pick, phase-ticks,
 * lobby, options, input, human-lookup), wires their deps, and returns a
 * narrow GameRuntime handle.
 *
 * Used by both main.ts (local play) and online-runtime-game.ts (online).
 */

import { aiChooseLifeLost } from "../ai/ai-life-lost.ts";
import {
  forcePickUpgradeEntry,
  tickAiUpgradePickEntry,
} from "../ai/ai-upgrade-pick.ts";
import {
  executeCannonFire,
  executePlacePiece,
  generateMap,
  snapshotTerritory,
} from "../game/index.ts";
import { createHapticsSystem } from "../input/haptics-system.ts";
import { dispatchPointerMove } from "../input/input-dispatch.ts";
import { registerKeyboardHandlers } from "../input/input-keyboard.ts";
import { registerMouseHandlers } from "../input/input-mouse.ts";
import { createSeedField } from "../input/input-seed-field.ts";
import { registerTouchHandlers } from "../input/input-touch-canvas.ts";
import {
  createDpad,
  createEnemyZoomButton,
  createFloatingActions,
  createHomeZoomButton,
  createQuitButton,
} from "../input/input-touch-ui.ts";
import { updateTouchControls } from "../input/input-touch-update.ts";
import { createSoundSystem } from "../input/sound-system.ts";
import {
  buildGameOverOverlay,
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
import {
  createControlsOverlay,
  createLobbyOverlay,
  createOptionsOverlay,
  visibleOptions,
} from "../render/render-ui-screens.ts";
import {
  controlsScreenHitTest,
  optionsScreenHitTest,
} from "../render/render-ui-settings.ts";
import { SELECT_ANNOUNCEMENT_DURATION } from "../shared/game-constants.ts";
import { Phase } from "../shared/game-phase.ts";
import type { GameMap, Viewport } from "../shared/geometry-types.ts";
import { MAP_PX_H, MAP_PX_W, SCALE } from "../shared/grid.ts";
import type { RenderOverlay } from "../shared/overlay-types.ts";
import { IS_DEV, IS_TOUCH_DEVICE } from "../shared/platform.ts";
import {
  computeGameSeed,
  MAX_SEED_LENGTH,
  SEED_CUSTOM,
} from "../shared/player-config.ts";
import { MESSAGE } from "../shared/protocol.ts";
import { cycleOption } from "../shared/settings-ui.ts";
import type { UIContext } from "../shared/ui-contracts.ts";
import { Mode } from "../shared/ui-mode.ts";
import { createRuntimeInputAdapters, createRuntimeLoop } from "./assembly.ts";
import { exposeDevConsole } from "./dev-console.ts";
import { createBannerSystem } from "./runtime-banner.ts";
import { bootstrapNewGameFromSettings } from "./runtime-bootstrap.ts";
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
import { createRuntimeState, safeState, setMode } from "./runtime-state.ts";
import { type GameRuntime, type RuntimeConfig } from "./runtime-types.ts";
import {
  createUpgradePickSystem,
  type UpgradePickSystem,
} from "./runtime-upgrade-pick.ts";

export function createGameRuntime(config: RuntimeConfig): GameRuntime {
  const { renderer, timing, keyboardEventSource } = config;
  const { container: gameContainer } = renderer;
  // "Online mode" = the host fan-out / watcher tick coordination is wired.
  // Action wrappers and onEndGame can be present independently but the
  // phase-tick bag is the canonical signal that this runtime is networked.
  const isOnline = !!config.onlinePhaseTicks;

  // -------------------------------------------------------------------------
  // Mutable state (shared bag — see runtime-state.ts)
  // -------------------------------------------------------------------------

  const runtimeState = createRuntimeState();
  const haptics = createHapticsSystem({ observer: config.observers?.haptics });
  haptics.setLevel(runtimeState.settings.haptics);
  const sound = createSoundSystem({ observer: config.observers?.sound });
  sound.setLevel(runtimeState.settings.sound);

  // Touch handles created early — render, options, and lifecycle read them
  // via closure. Populated once by createInputSystem(), then frozen (see below).
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
      const map = generateMap(newSeed);
      runtimeState.lobby.map = map;
      renderer.warmMapCache(map);
    }
  }

  // -------------------------------------------------------------------------
  // Frame/timing helpers
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  // TickDispatch (runtime-state.ts) is Record<TickableMode, ...> where
  // TickableMode = Exclude<Mode, Mode.STOPPED>. Adding a new Mode without
  // a corresponding ticker entry here is a compile error.
  // Hoisted outside mainLoop — closures are stable, avoids per-frame allocation.
  const modeTickers = {
    [Mode.LOBBY]: (dt: number) => {
      lobby.tickLobby(dt);
      lobby.renderLobby();
    },
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
  const { clearFrameData, mainLoop } = createRuntimeLoop({
    runtimeState,
    timing,
    myPlayerId: config.network.myPlayerId,
    amHost: config.network.amHost,
    remotePlayerSlots: config.network.remotePlayerSlots,
    getPointerPlayer: () => pointerPlayer(),
    clearHumanCache: () => clearHumanCache(),
    isSelectionReady,
    isMobileAutoZoom: () => camera.isMobileAutoZoom(),
    tickCamera: () => tickCamera(),
    tickScoreDelta: (dt: number) => scoreDelta.tick(dt),
    render: () => render(),
    ticks: modeTickers,
    onAfterFrame: () => {
      if (IS_DEV) {
        exposeE2EBridge({ runtimeState, config, camera, renderer });
        exposeDevConsole(runtimeState, timing);
      }
    },
  });

  // -------------------------------------------------------------------------
  // Rendering / frame helpers
  // -------------------------------------------------------------------------

  function renderFrame(
    map: GameMap,
    overlay: RenderOverlay | undefined,
    viewport?: Viewport | null,
  ): void {
    renderer.drawFrame(map, overlay, viewport, timing.now());
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
    setPrevEntities: setBannerPrevEntities,
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
    timing,
    hostAtFrameStart: config.network.amHost,
    sendTowerSelected: (pid, idx, confirmed) =>
      config.network.send({
        type: MESSAGE.OPPONENT_TOWER_SELECTED,
        playerId: pid,
        towerIdx: idx,
        confirmed,
      }),
    sendCastleWalls: (plans) =>
      config.network.send({ type: MESSAGE.CASTLE_WALLS, plans: [...plans] }),
    sendSelectStart: (timer) =>
      config.network.send({ type: MESSAGE.SELECT_START, timer }),
    log: config.log,
    camera,
    sound,
    syncSelectionOverlay: updateSelectionOverlay,
    render: () => render(),
    pointerPlayer,
    startCannonPhase: (onDone) => phaseTicks.startCannonPhase(onDone),
    clearBannerSnapshots,
    setPrevEntities: setBannerPrevEntities,
    requestFrame: () => {
      if (runtimeState.mode === Mode.STOPPED) timing.requestFrame(mainLoop);
    },
  });

  // -------------------------------------------------------------------------
  // Render sub-system (delegated to runtime-render.ts)
  // -------------------------------------------------------------------------

  const render = createRenderSystem({
    runtimeState,
    timing,
    createBannerUi,
    createOnlineOverlay,
    createRenderSummaryMessage,
    createStatusBar,
    drawFrame: (map, overlay, viewport, now) =>
      renderer.drawFrame(map, overlay, viewport, now),
    logThrottled: config.logThrottled,
    scoreDeltaProgress: () => scoreDelta.progress(),
    upgradePickInteractiveId: () => upgradePick.interactivePlayerId(),
    syncCrosshairs: (expired) => phaseTicks.syncCrosshairs(expired),
    getLifeLostPanelPos: (pid) => lifeLost.panelPos(pid),
    updateViewport,
    pointerPlayer,
    getTouch: () => touchHandles,
    worldToScreen: camera.worldToScreen,
    screenToContainerCSS: renderer.screenToContainerCSS,
    getContainerHeight: () => gameContainer.clientHeight,
    updateTouchControls,
  });

  // -------------------------------------------------------------------------
  // Game lifecycle (delegated to runtime-game-lifecycle.ts)
  // -------------------------------------------------------------------------

  const lifecycle = createGameLifecycle(
    buildLifecycleDeps({
      runtimeState,
      config,
      timing,
      render,
      requestMainLoop: () => timing.requestFrame(mainLoop),
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
          config.getUrlModeOverride,
        ),
      selection,
      banner: { reset: resetBanner },
      camera,
      getLifeLost: () => lifeLost,
      getUpgradePick: () => upgradePick,
      scoreDelta,
      sound,
      input: {
        resetForLobby: (runtimeState) => input.resetForLobby(runtimeState),
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
      buildGameOverOverlay,
    }),
  );

  // -------------------------------------------------------------------------
  // Life-lost sub-system (delegated to runtime-life-lost.ts)
  // -------------------------------------------------------------------------

  const lifeLost: LifeLostSystem = createLifeLostSystem({
    runtimeState,
    sendLifeLostChoice: (choice, playerId) =>
      config.network.send({ type: MESSAGE.LIFE_LOST_CHOICE, choice, playerId }),
    log: config.log,
    render,
    panelPos: (pid) => lifeLostPanelPos(runtimeState.state, pid),
    endGame: lifecycle.endGame,
    startReselection: selection.startReselection,
    advanceToCannonPhase: selection.advanceToCannonPhase,
    aiChoose: (entry) => aiChooseLifeLost(entry, runtimeState.state),
  });

  // -------------------------------------------------------------------------
  // Upgrade pick sub-system (delegated to runtime-upgrade-pick.ts)
  // -------------------------------------------------------------------------

  const upgradePick: UpgradePickSystem = createUpgradePickSystem({
    runtimeState,
    log: config.log,
    render,
    sendUpgradePick: isOnline
      ? (playerId, choice) =>
          config.network.send({ type: MESSAGE.UPGRADE_PICK, playerId, choice })
      : undefined,
    tickAiEntry: (entry, entryIdx, dt, autoDelay, dialogTimer) =>
      tickAiUpgradePickEntry(
        entry,
        entryIdx,
        dt,
        autoDelay,
        dialogTimer,
        runtimeState.state,
      ),
    forcePickEntry: (entry) => forcePickUpgradeEntry(entry, runtimeState.state),
  });

  // -------------------------------------------------------------------------
  // Touch battle targeting (shared by phase-ticks onBeginBattle + GameRuntime)
  // -------------------------------------------------------------------------

  function applyBattleTarget(): void {
    const target = camera.computeBattleTarget();
    if (!target) return;
    const h = pointerPlayer();
    if (h) h.setCrosshair(target.x, target.y);
  }

  // -------------------------------------------------------------------------
  // Phase ticks sub-system (delegated to runtime-phase-ticks.ts)
  // -------------------------------------------------------------------------

  const phaseTicks: PhaseTicksSystem = createPhaseTicksSystem({
    runtimeState,
    timing,
    send: config.network.send,
    log: config.log,
    sendOpponentCannonPlaced: (msg) =>
      config.network.send({ type: MESSAGE.OPPONENT_CANNON_PLACED, ...msg }),
    sendOpponentCannonPhantom: (msg) =>
      config.network.send({ type: MESSAGE.OPPONENT_CANNON_PHANTOM, ...msg }),
    sendOpponentPiecePlaced: (msg) =>
      config.network.send({ type: MESSAGE.OPPONENT_PIECE_PLACED, ...msg }),
    sendOpponentPhantom: (msg) =>
      config.network.send({ type: MESSAGE.OPPONENT_PHANTOM, ...msg }),
    online: config.onlinePhaseTicks,
    render,
    showBanner,
    lifeLost,
    scoreDelta,
    saveBattleCrosshair: IS_TOUCH_DEVICE
      ? () => {
          const h = pointerPlayer();
          if (!h) return;
          const ch = h.getCrosshair();
          camera.saveBattleCrosshair({ x: ch.x, y: ch.y });
        }
      : undefined,
    onBeginBattle: IS_TOUCH_DEVICE ? applyBattleTarget : undefined,
    sound,
    haptics,
    tryShowUpgradePick: (onDone) => upgradePick.tryShow(onDone),
    prepareUpgradePick: () => upgradePick.prepare(),
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
  const inputAdapters = createRuntimeInputAdapters({
    config,
    localPlacePiece: (ctrl, gameState) => {
      const intent = ctrl.tryPlacePiece(gameState);
      if (!intent) return false;
      return executePlacePiece(runtimeState.state, intent, ctrl);
    },
    localFire: (ctrl, gameState) => {
      const intent = ctrl.fire(gameState);
      if (!intent) return;
      executeCannonFire(runtimeState.state, intent, ctrl);
    },
  });
  const optionsDeps = {
    runtimeState,
    timing,
    uiCtx,
    renderFrame,
    updateDpad: (enabled: boolean) =>
      touchHandles.dpad?.update(enabled ? Phase.WALL_BUILD : null),
    setDpadLeftHanded: (left: boolean) =>
      touchHandles.dpad?.setLeftHanded(left),
    refreshLobbySeed,
    sound,
    haptics,
    isOnline,
    remotePlayerSlots: config.network.remotePlayerSlots,
    onCloseOptions: config.onCloseOptions,
    seedField: createSeedField(MAX_SEED_LENGTH, (digits) => {
      runtimeState.settings.seedMode = SEED_CUSTOM;
      runtimeState.settings.seed = digits;
    }),
    controlsScreenHitTest,
    optionsScreenHitTest,
    createControlsOverlay,
    createOptionsOverlay,
    visibleOptions,
    cycleOption,
  };

  // Initialize options system first (lobby depends on showOptions)
  const options = createOptionsSystem(optionsDeps);
  const lobbyDeps = {
    runtimeState,
    uiCtx,
    renderFrame,
    refreshLobbySeed,
    showOptions: options.showOptions,
    isOnline,
    onTickLobbyExpired: config.onTickLobbyExpired,
    onLobbySlotJoined: config.onLobbySlotJoined,
    createLobbyOverlay,
    computeLobbyLayout,
    lobbyClickHitTest,
  };

  // Initialize lobby system (needs options.showOptions)
  const lobby = createLobbySystem(lobbyDeps);

  // -------------------------------------------------------------------------
  // Input sub-system (all deps now available — standard factory pattern)
  // -------------------------------------------------------------------------

  const input = createInputSystem({
    touchHandles,
    runtimeState,
    renderer,
    gameContainer,
    keyboardEventSource,
    hitTests: {
      lifeLostDialogClick: (screenX, screenY) => {
        if (!runtimeState.dialogs.lifeLost) return null;
        return handleLifeLostDialogClick({
          state: runtimeState.state,
          lifeLostDialog: runtimeState.dialogs.lifeLost,
          screenX,
          screenY,
        });
      },
      upgradePickClick: (screenX, screenY) => {
        if (!runtimeState.dialogs.upgradePick) return null;
        return handleUpgradePickClick({
          W: MAP_PX_W,
          H: MAP_PX_H,
          dialog: runtimeState.dialogs.upgradePick,
          screenX,
          screenY,
        });
      },
      visibleOptionCount: () => visibleOptions(uiCtx).length,
    },
    isOnline,
    network: { amHost: config.network.amHost },
    actions: inputAdapters.actions,
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
    floatingActionsEl:
      gameContainer.querySelector<HTMLElement>("#floating-actions"),
    markTouchPanels: () => {
      gameContainer.classList.add("has-touch-panels");
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

  // All touch handle fields are now assigned — freeze to prevent accidental
  // reassignment. Subsystems call handle.update(), never reassign the slot.
  Object.freeze(touchHandles);

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
    aimAtEnemyCastle: applyBattleTarget,
    warmMapCache: (map) => renderer.warmMapCache(map),
  };
}
