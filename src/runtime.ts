/**
 * Shared game runtime factory — composition root that wires subsystems.
 *
 * createGameRuntime(config) creates all subsystems (camera, selection,
 * life-lost, phase-ticks, lobby, options, input, lifecycle), wires
 * their deps, and returns a narrow GameRuntime handle.
 *
 * Used by both main.ts (local play) and online-client-runtime.ts (online).
 *
 * ### Sub-system deps destructuring convention
 *
 * Each createXSystem(deps) factory destructures only frequently-used deps
 * (typically `runtimeState` and `uiCtx`) at the factory top level. Rarely-used deps
 * are accessed inline as `deps.X`. This keeps closures lean while avoiding
 * verbose `deps.` prefixes on hot paths. The pattern is intentionally not
 * uniform across sub-systems — it reflects each sub-system's actual usage.
 *
 * ### Overlay mutation convention
 *
 * Two overlay patterns coexist by design:
 * - **Persistent state** (game overlays): mutated in-place via `runtimeState.overlay.X = ...`
 *   because the overlay persists across frames and is read by the main render loop.
 * - **Transient overlays** (lobby, options): created fresh via factory functions
 *   (`createLobbyOverlay`, `createOptionsOverlay`) and passed directly to
 *   `renderFrame(map, overlay)` — these don't persist in `runtimeState.overlay`.
 */

import {
  type InputReceiver,
  isHuman,
  type PlayerController,
} from "./controller-interfaces.ts";
import {
  BANNER_DURATION,
  MAX_FRAME_DT,
  SCORE_DELTA_DISPLAY_TIME,
  SELECT_ANNOUNCEMENT_DURATION,
} from "./game-constants.ts";
import {
  snapshotTerritory as snapshotTerritoryImpl,
  tickMainLoop,
} from "./game-helpers.ts";
import type { UIContext } from "./game-ui-screens.ts";
import { computeGameSeed } from "./game-ui-settings.ts";
import { TILE_SIZE } from "./grid.ts";
import { createHapticsSystem } from "./haptics-system.ts";
import { generateMap } from "./map-generation.ts";
import { showBannerTransition, tickBannerTransition } from "./phase-banner.ts";
import { IS_DEV, IS_TOUCH_DEVICE } from "./platform.ts";
import { PLAYER_COLORS, PLAYER_NAMES } from "./player-config.ts";
import {
  createBannerUi,
  createOnlineOverlay,
  createRenderSummaryMessage,
  createStatusBar,
} from "./render-composition.ts";
import type { MapData, RenderOverlay, Viewport } from "./render-types.ts";
import { createCameraSystem } from "./runtime-camera.ts";
import { createGameLifecycle } from "./runtime-game-lifecycle.ts";
import { createInputSystem } from "./runtime-input.ts";
import {
  createLifeLostSystem,
  type LifeLostSystem,
} from "./runtime-life-lost.ts";
import { createLobbySystem } from "./runtime-lobby.ts";
import { createOptionsSystem, type OptionsSystem } from "./runtime-options.ts";
import {
  createPhaseTicksSystem,
  type PhaseTicksSystem,
} from "./runtime-phase-ticks.ts";
import {
  createSelectionSystem,
  type SelectionSystem,
} from "./runtime-selection.ts";
import {
  createRuntimeState,
  isStateReady,
  NO_SLOT,
  safeState,
} from "./runtime-state.ts";
import { updateTouchControls } from "./runtime-touch-ui.ts";
import type { GameRuntime, RuntimeConfig } from "./runtime-types.ts";
import { createSoundSystem } from "./sound-system.ts";
import { unpackTile } from "./spatial.ts";
import { computeFrameContext, fireOnce, Mode, Phase } from "./types.ts";

export type { GameRuntime } from "./runtime-types.ts";

export function createGameRuntime(config: RuntimeConfig): GameRuntime {
  const { renderer } = config;
  const { container: gameContainer } = renderer;

  // -------------------------------------------------------------------------
  // Mutable state (shared bag — see runtime-state.ts)
  // -------------------------------------------------------------------------

  const runtimeState = createRuntimeState();
  const haptics = createHapticsSystem();
  haptics.setLevel(runtimeState.settings.haptics);
  const sound = createSoundSystem();
  sound.setLevel(runtimeState.settings.sound);

  // Forward-declared: options must exist before lobby (lobby triggers
  // showOptions), and input must exist before the game-lifecycle system
  // (lifecycle registers cleanup). Both are assigned immediately after
  // their factory calls below — the `let` is required by declaration order.
  // deno-lint-ignore prefer-const
  let options: OptionsSystem;
  // deno-lint-ignore prefer-const
  let input: ReturnType<typeof createInputSystem>;

  /** Refresh lobby seed + map preview only if the seed changed. */
  function refreshLobbySeed(): void {
    const newSeed = computeGameSeed(runtimeState.settings);
    if (newSeed !== runtimeState.lobby.seed) {
      runtimeState.lobby.seed = newSeed;
      runtimeState.lobby.map = generateMap(newSeed);
    }
  }

  // -------------------------------------------------------------------------
  // Frame/timing helpers
  // -------------------------------------------------------------------------

  function clearFrameData(): void {
    const { gameOver } = runtimeState.frame;
    runtimeState.frame = { crosshairs: [], phantoms: {} };
    if (gameOver) runtimeState.frame.gameOver = gameOver;
    cachedFirstHuman = undefined;
  }

  function clampedFrameDt(now: number): number {
    const dt = Math.min((now - runtimeState.lastTime) / 1000, MAX_FRAME_DT);
    runtimeState.lastTime = now;
    return dt;
  }

  /** Tick the score delta display timer (mode-independent — counts during banner/castle-build).
   *  Lifecycle: showBuildScoreDeltas sets deltas+timer+onDone → this ticks down →
   *  clears deltas and fires onDone exactly once when the timer expires.
   *  Re-entrancy: onDone must NOT call showBuildScoreDeltas() — that would restart
   *  the timer and create an infinite display loop. */
  function tickScoreDeltaDisplay(dt: number): void {
    if (runtimeState.scoreDeltaTimer <= 0) return;
    runtimeState.scoreDeltaTimer -= dt;
    if (runtimeState.scoreDeltaTimer <= 0) {
      runtimeState.scoreDeltas = [];
      runtimeState.scoreDeltaTimer = 0;
      // fireOnce: invokes runtimeState.scoreDeltaOnDone at most once, then clears it
      fireOnce(runtimeState, "scoreDeltaOnDone");
    }
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  const DEV = IS_DEV;

  /** Expose mode, phase, and targeting data for E2E test automation (dev only). */
  function exposeTestGlobals(): void {
    if (typeof window === "undefined") return;
    const w = globalThis as unknown as Record<string, unknown>;
    w.__testMode = Mode[runtimeState.mode];
    w.__testPhase = isStateReady(runtimeState)
      ? Phase[runtimeState.state.phase]
      : "";
    w.__testTimer = isStateReady(runtimeState) ? runtimeState.state.timer : 0;
    const myPid = config.getMyPlayerId();
    if (isStateReady(runtimeState) && myPid >= 0) {
      const enemies: { x: number; y: number }[] = [];
      for (const player of runtimeState.state.players) {
        if (player.id === myPid || player.eliminated) continue;
        for (const c of player.cannons) {
          if (c.hp > 0)
            enemies.push({
              // +0.5 converts tile top-left to tile center (pixel coords)
              x: (c.col + 0.5) * TILE_SIZE,
              y: (c.row + 0.5) * TILE_SIZE,
            });
        }
      }
      w.__testEnemyCannons = enemies;
      const targets: { x: number; y: number }[] = [...enemies];
      for (const player of runtimeState.state.players) {
        if (player.id === myPid || player.eliminated) continue;
        for (const key of player.walls) {
          const { r, c } = unpackTile(key);
          targets.push({ x: (c + 0.5) * TILE_SIZE, y: (r + 0.5) * TILE_SIZE });
        }
      }
      w.__testEnemyTargets = targets;
      const myCtrl = runtimeState.controllers[myPid];
      if (myCtrl) {
        const ch = myCtrl.getCrosshair();
        if (ch) w.__testCrosshair = { x: ch.x, y: ch.y };
      }
    }
  }

  function mainLoop(now: number): void {
    const dt = clampedFrameDt(now);
    runtimeState.frameDt = dt;
    clearFrameData();

    runtimeState.frameCtx = computeFrameContext({
      mode: runtimeState.mode,
      phase: isStateReady(runtimeState)
        ? runtimeState.state.phase
        : Phase.CASTLE_SELECT,
      timer: isStateReady(runtimeState) ? runtimeState.state.timer : 0,
      paused: runtimeState.paused,
      quitPending: runtimeState.quitPending,
      hasLifeLostDialog: runtimeState.lifeLostDialog !== null,
      isSelectionReady: isSelectionReady(),
      humanIsReselecting: runtimeState.reselectQueue.includes(
        firstHuman()?.playerId ?? -1,
      ),
      myPlayerId: config.getMyPlayerId(),
      firstHumanPlayerId: firstHuman()?.playerId ?? -1,
      isHost: config.getIsHost(),
      remoteHumanSlots: config.getRemoteHumanSlots(),
      mobileAutoZoom: camera.isMobileAutoZoom(),
    });

    tickCamera();
    tickScoreDeltaDisplay(dt);

    const modeTickers = {
      [Mode.LOBBY]: (dt: number) => lobby.tickLobby(dt),
      [Mode.OPTIONS]: () => options.renderOptions(),
      [Mode.CONTROLS]: () => options.renderControls(),
      [Mode.SELECTION]: (dt: number) => selection.tick(dt),
      [Mode.BANNER]: tickBanner,
      [Mode.BALLOON_ANIM]: (dt: number) => phaseTicks.tickBalloonAnim(dt),
      [Mode.CASTLE_BUILD]: (dt: number) => selection.tickCastleBuild(dt),
      [Mode.LIFE_LOST]: (dt: number) => lifeLost.tick(dt),
      [Mode.GAME]: (dt: number) => phaseTicks.tickGame(dt),
    };

    const shouldContinue = tickMainLoop({
      dt,
      mode: runtimeState.mode,
      paused: runtimeState.paused,
      quitPending: runtimeState.quitPending,
      quitTimer: runtimeState.quitTimer,
      quitMessage: runtimeState.quitMessage,
      frame: runtimeState.frame,
      setQuitPending: (quitPending: boolean) => {
        runtimeState.quitPending = quitPending;
      },
      setQuitTimer: (quitTimer: number) => {
        runtimeState.quitTimer = quitTimer;
      },
      render,
      ticks: modeTickers,
    });

    if (DEV) exposeTestGlobals();
    if (shouldContinue && runtimeState.mode !== Mode.STOPPED)
      requestAnimationFrame(mainLoop);
  }

  // -------------------------------------------------------------------------
  // Rendering / frame helpers
  // -------------------------------------------------------------------------

  function renderFrame(
    map: MapData,
    overlay: RenderOverlay | undefined,
    viewport?: Viewport | null,
  ): void {
    renderer.drawFrame(map, overlay, viewport);
  }

  /** True once the selection announcement has finished playing and input is unblocked.
   *  Guard pattern: `if (!isSelectionReady()) return;` blocks input during announcement. */
  function isSelectionReady(): boolean {
    return (
      runtimeState.accum.selectAnnouncement >= SELECT_ANNOUNCEMENT_DURATION
    );
  }

  // -------------------------------------------------------------------------
  // Banner
  // -------------------------------------------------------------------------

  /** Show a phase-transition banner with text and optional old-scene preservation.
   *  @param onDone — Called exactly once when the banner animation completes.
   *    Must not be called again or stored for later — the banner system nulls
   *    its internal reference after invoking it.
   *  @param preserveOldScene — When true, snapshot old castles/territory/walls
   *    before transitioning so the banner can show a before/after comparison. */
  /** Show a phase-transition banner.
   *  @param preserveOldScene When true, captures before-state (castles, territory, walls)
   *    for the banner's before/after visual comparison (e.g. build→cannon transition).
   *  @param newBattle Post-transition battle state snapshot (territory + walls) for the
   *    banner "after" scene. Only meaningful when preserveOldScene is true.
   *  @param subtitle Optional subtitle line below the main banner text. */
  function showBanner(
    text: string,
    onDone: () => void,
    preserveOldScene = false,
    newBattle?: { territory: Set<number>[]; walls: Set<number>[] },
    subtitle?: string,
  ) {
    // Unzoom before banner so the full map is visible during transition
    camera.clearPhaseZoom();
    if (runtimeState.banner.active) {
      config.log(
        `showBanner "${text}" while banner "${runtimeState.banner.text}" is still active`,
      );
    }
    showBannerTransition({
      banner: runtimeState.banner,
      state: runtimeState.state,
      battleAnim: runtimeState.battleAnim,
      text,
      subtitle,
      onDone,
      preserveOldScene,
      newBattle,
      setModeBanner: () => {
        runtimeState.mode = Mode.BANNER;
      },
    });
    haptics.phaseChange();
    sound.phaseStart();
  }

  function tickBanner(dt: number) {
    tickBannerTransition(runtimeState.banner, dt, BANNER_DURATION, render);
  }

  // -------------------------------------------------------------------------
  // Territory / human helpers
  // -------------------------------------------------------------------------

  function snapshotTerritory(): Set<number>[] {
    return snapshotTerritoryImpl(runtimeState.state.players);
  }

  let cachedFirstHuman: (PlayerController & InputReceiver) | null | undefined;

  function firstHuman(): (PlayerController & InputReceiver) | null {
    if (cachedFirstHuman !== undefined) return cachedFirstHuman;
    // Prefer the player who joined via mouse/trackpad
    if (runtimeState.mouseJoinedSlot !== NO_SLOT) {
      const ctrl = runtimeState.controllers.find(
        (c) => c.playerId === runtimeState.mouseJoinedSlot,
      );
      if (
        ctrl &&
        isHuman(ctrl) &&
        !runtimeState.state.players[ctrl.playerId]?.eliminated
      )
        return (cachedFirstHuman = ctrl);
    }
    for (const ctrl of runtimeState.controllers) {
      if (
        isHuman(ctrl) &&
        !runtimeState.state.players[ctrl.playerId]?.eliminated
      )
        return (cachedFirstHuman = ctrl);
    }
    return (cachedFirstHuman = null);
  }

  /** Run `action` with the first human controller. No-op if no human exists
   *  (e.g. all-AI game) — the action callback will NOT be called. */
  function withFirstHuman(
    action: (human: PlayerController & InputReceiver) => void,
  ): void {
    const human = firstHuman();
    if (!human) return;
    action(human);
  }

  // -------------------------------------------------------------------------
  // Camera / zoom (delegated to runtime-camera.ts)
  // -------------------------------------------------------------------------

  const camera = createCameraSystem({
    getState: () => safeState(runtimeState),
    getCtx: () => runtimeState.frameCtx,
    getFrameDt: () => runtimeState.frameDt,
    setFrameAnnouncement: (text) => {
      runtimeState.frame.announcement = text;
    },
    getFirstHumanCrosshair: () => {
      const h = firstHuman();
      if (!h) return null;
      const ch = h.getCrosshair();
      return { x: ch.x, y: ch.y };
    },
    setFirstHumanCrosshair: (x, y) => {
      const h = firstHuman();
      if (h) h.setCrosshair(x, y);
    },
  });

  const { tickCamera, updateViewport } = camera;

  // -------------------------------------------------------------------------
  // Selection sub-system (delegated to runtime-selection.ts)
  // -------------------------------------------------------------------------

  const selection: SelectionSystem = createSelectionSystem({
    runtimeState,
    send: config.send,
    log: config.log,
    camera,
    sound,
    render: () => render(),
    firstHuman,
    startCannonPhase: (onDone) => phaseTicks.startCannonPhase(onDone),
    requestFrame: () => {
      if (runtimeState.mode === Mode.STOPPED) requestAnimationFrame(mainLoop);
    },
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function render() {
    // Summary log: crosshairs, phantoms, impacts per frame (throttled 1/s)
    const chList = runtimeState.frame.crosshairs ?? [];
    const selH = runtimeState.overlay.selection?.highlights;
    config.logThrottled(
      "render-summary",
      createRenderSummaryMessage({
        phaseName: Phase[runtimeState.state.phase],
        timer: runtimeState.state.timer,
        crosshairs: chList,
        aiPhantomsCount: runtimeState.frame.phantoms?.aiPhantoms?.length ?? 0,
        humanPhantomsCount:
          runtimeState.frame.phantoms?.humanPhantoms?.length ?? 0,
        aiCannonPhantomsCount:
          runtimeState.frame.phantoms?.aiCannonPhantoms?.length ?? 0,
        impactsCount: runtimeState.battleAnim.impacts.length,
        cannonballsCount: runtimeState.state.cannonballs.length,
        selectionHighlights: selH,
      }),
    );

    // Refresh crosshairs from controller state when paused
    if (runtimeState.state.phase === Phase.BATTLE && runtimeState.paused) {
      phaseTicks.syncCrosshairs(runtimeState.state.battleCountdown <= 0);
    }

    const bannerUi = createBannerUi(
      runtimeState.banner.active,
      runtimeState.banner.text,
      runtimeState.banner.progress,
      runtimeState.banner.subtitle,
    );

    runtimeState.overlay = createOnlineOverlay({
      previousSelection: runtimeState.overlay.selection,
      state: runtimeState.state,
      banner: runtimeState.banner,
      battleAnim: runtimeState.battleAnim,
      frame: runtimeState.frame,
      bannerUi,
      lifeLostDialog: runtimeState.lifeLostDialog,
      playerNames: PLAYER_NAMES,
      playerColors: PLAYER_COLORS,
      getLifeLostPanelPos: (playerId) => lifeLost.panelPos(playerId),
    });

    // Status bar (rendered inside canvas)
    if (runtimeState.overlay.ui) {
      runtimeState.overlay.ui.statusBar = createStatusBar(
        runtimeState.state,
        PLAYER_COLORS,
      );
    }

    // Add score deltas to overlay (shown briefly before Place Cannons banner)
    if (runtimeState.scoreDeltas.length > 0 && runtimeState.overlay.ui) {
      runtimeState.overlay.ui.scoreDeltas = runtimeState.scoreDeltas;
      runtimeState.overlay.ui.scoreDeltaProgress =
        1 - runtimeState.scoreDeltaTimer / SCORE_DELTA_DISPLAY_TIME;
    }

    renderFrame(runtimeState.state.map, runtimeState.overlay, updateViewport());

    // Update touch controls (loupe, d-pad, zoom, quit, floating actions)
    updateTouchControls({
      mode: runtimeState.mode,
      state: runtimeState.state,
      phantoms: runtimeState.frame.phantoms,
      directTouchActive: runtimeState.directTouchActive,
      leftHanded: runtimeState.settings.leftHanded,
      firstHuman,
      dpad: input.touch.dpad,
      floatingActions: input.touch.floatingActions,
      homeZoomButton: input.touch.homeZoomButton,
      enemyZoomButton: input.touch.enemyZoomButton,
      quitButton: input.touch.quitButton,
      loupeHandle: input.touch.loupeHandle,
      worldToScreen: camera.worldToScreen,
      screenToContainerCSS: renderer.screenToContainerCSS,
      containerHeight: gameContainer.clientHeight,
    });
  }

  // -------------------------------------------------------------------------
  // Game lifecycle (delegated to runtime-game-lifecycle.ts)
  // -------------------------------------------------------------------------

  const lifecycle = createGameLifecycle({
    runtimeState,
    log: config.log,
    showLobby: config.showLobby,
    onEndGame: config.onEndGame,
    camera,
    sound,
    selection,
    render: () => render(),
    clearFrameData,
    requestMainLoop: () => requestAnimationFrame(mainLoop),
    resetTouchForLobby: () => {
      input.touch.floatingActions?.update(false, 0, 0, false, false);
      input.touch.dpad?.update(null);
      input.touch.quitButton?.update(null);
      input.touch.homeZoomButton?.update(false);
      input.touch.enemyZoomButton?.update(false);
      input.touch.loupeHandle?.update(false, 0, 0);
    },
    resetBattleCrosshair: camera.resetBattleCrosshair,
  });

  // -------------------------------------------------------------------------
  // Life-lost sub-system (delegated to runtime-life-lost.ts)
  // -------------------------------------------------------------------------

  const lifeLost: LifeLostSystem = createLifeLostSystem({
    runtimeState,
    send: config.send,
    log: config.log,
    render: () => render(),
    firstHuman,
    endGame: lifecycle.endGame,
    startReselection: selection.startReselection,
    advanceToCannonPhase: selection.advanceToCannonPhase,
  });

  // -------------------------------------------------------------------------
  // Phase ticks sub-system (delegated to runtime-phase-ticks.ts)
  // -------------------------------------------------------------------------

  const phaseTicks: PhaseTicksSystem = createPhaseTicksSystem({
    runtimeState,
    send: config.send,
    log: config.log,
    hostNetworking: config.hostNetworking,
    watcherTiming: config.watcherTiming,
    extendCrosshairs: config.extendCrosshairs,
    onLocalCrosshairCollected: config.onLocalCrosshairCollected,
    tickNonHost: config.tickNonHost,
    everyTick: config.everyTick,
    render: () => render(),
    firstHuman,
    showBanner,
    lifeLost,
    selection,
    snapshotTerritory,
    saveBattleCrosshair: IS_TOUCH_DEVICE
      ? camera.saveBattleCrosshair
      : undefined,
    onBeginBattle: IS_TOUCH_DEVICE ? camera.aimAtEnemyCastle : undefined,
    sound,
    haptics,
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
      runtimeState.mode = mode;
    },
    getPaused: () => runtimeState.paused,
    setPaused: (paused) => {
      runtimeState.paused = paused;
    },
    optionsCursor: {
      get value() {
        return runtimeState.optionsCursor;
      },
      set value(value) {
        runtimeState.optionsCursor = value;
      },
    },
    controlsState: runtimeState.controlsState,
    getOptionsReturnMode: () => runtimeState.optionsReturnMode,
    setOptionsReturnMode: (mode) => {
      runtimeState.optionsReturnMode = mode;
    },
    lobby: runtimeState.lobby,
    getFrame: () => runtimeState.frame,
    getLobbyRemaining: config.getLobbyRemaining,
    isOnline: !!config.isOnline,
  };

  // Initialize options system first (lobby depends on showOptions)
  options = createOptionsSystem({
    runtimeState,
    uiCtx,
    renderFrame,
    // Bridge boolean enable to dpad's Phase|null API (WALL_BUILD = any non-selection phase)
    updateDpad: (enabled) =>
      input.touch.dpad?.update(enabled ? Phase.WALL_BUILD : null),
    setDpadLeftHanded: (left) => input.touch.dpad?.setLeftHanded(left),
    refreshLobbySeed,
    sound,
    haptics,
    isOnline: !!config.isOnline,
    getRemoteHumanSlots: config.getRemoteHumanSlots,
    onCloseOptions: config.onCloseOptions,
  });

  // Initialize lobby system (needs options.showOptions)
  const lobby = createLobbySystem({
    runtimeState,
    uiCtx,
    renderFrame,
    showOptions: options.showOptions,
    isOnline: !!config.isOnline,
    onTickLobbyExpired: config.onTickLobbyExpired,
    onLobbySlotJoined: config.onLobbySlotJoined,
  });

  // -------------------------------------------------------------------------
  // Input sub-system (delegated to runtime-input.ts)
  // -------------------------------------------------------------------------

  input = createInputSystem({
    runtimeState,
    renderer,
    gameContainer,
    uiCtx,
    isOnline: config.isOnline,
    maybeSendAimUpdate: config.maybeSendAimUpdate,
    tryPlaceCannonAndSend: config.tryPlaceCannonAndSend,
    tryPlacePieceAndSend: config.tryPlacePieceAndSend,
    fireAndSend: config.fireAndSend,
    getIsHost: config.getIsHost,
    lobby,
    options,
    lifeLost,
    selection,
    camera,
    sound,
    haptics,
    firstHuman,
    withFirstHuman,
    isSelectionReady,
    render,
    rematch: lifecycle.rematch,
    returnToLobby: lifecycle.returnToLobby,
    gameOverClick: lifecycle.gameOverClick,
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

    // Cross-cutting orchestration
    mainLoop,
    clearFrameData,
    render,
    registerInputHandlers: input.register,
    showBanner,
    snapshotTerritory,
    aimAtEnemyCastle: camera.aimAtEnemyCastle,
  };
}
