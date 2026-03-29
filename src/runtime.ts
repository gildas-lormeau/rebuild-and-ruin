/**
 * Shared game runtime factory — composition root that wires subsystems.
 *
 * createGameRuntime(config) creates all subsystems (camera, selection,
 * life-lost, phase-ticks, lobby, options, input, lifecycle), wires
 * their deps, and returns a narrow GameRuntime handle.
 *
 * Used by both main.ts (local play) and online-client-runtime.ts (online).
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
} from "./game-ui-helpers.ts";
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
  safeState,
} from "./runtime-state.ts";
import { updateTouchControls } from "./runtime-touch-ui.ts";
import type { GameRuntime, RuntimeConfig } from "./runtime-types.ts";
import { createSoundSystem } from "./sound-system.ts";
import { unpackTile } from "./spatial.ts";
import { computeFrameContext, Mode, Phase } from "./types.ts";

export type { GameRuntime } from "./runtime-types.ts";

export function createGameRuntime(config: RuntimeConfig): GameRuntime {
  const { renderer } = config;
  const { container: gameContainer } = renderer;

  // -------------------------------------------------------------------------
  // Mutable state (shared bag — see runtime-state.ts)
  // -------------------------------------------------------------------------

  const rs = createRuntimeState();
  const haptics = createHapticsSystem();
  haptics.setLevel(rs.settings.haptics);
  const sound = createSoundSystem();
  sound.setLevel(rs.settings.sound);

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
    const newSeed = computeGameSeed(rs.settings);
    if (newSeed !== rs.lobby.seed) {
      rs.lobby.seed = newSeed;
      rs.lobby.map = generateMap(newSeed);
    }
  }

  // -------------------------------------------------------------------------
  // Frame/timing helpers
  // -------------------------------------------------------------------------

  function resetFrame(): void {
    const { gameOver } = rs.frame;
    rs.frame = { crosshairs: [], phantoms: {} };
    if (gameOver) rs.frame.gameOver = gameOver;
    cachedFirstHuman = undefined;
  }

  function clampedFrameDt(now: number): number {
    const dt = Math.min((now - rs.lastTime) / 1000, MAX_FRAME_DT);
    rs.lastTime = now;
    return dt;
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  const DEV = IS_DEV;

  /** Expose mode, phase, and targeting data for E2E test automation (dev only). */
  function exposeTestGlobals(): void {
    if (typeof window === "undefined") return;
    const w = globalThis as unknown as Record<string, unknown>;
    w.__testMode = Mode[rs.mode];
    w.__testPhase = isStateReady(rs) ? Phase[rs.state.phase] : "";
    w.__testTimer = isStateReady(rs) ? rs.state.timer : 0;
    const myPid = config.getMyPlayerId();
    if (isStateReady(rs) && myPid >= 0) {
      const enemies: { x: number; y: number }[] = [];
      for (const p of rs.state.players) {
        if (p.id === myPid || p.eliminated) continue;
        for (const c of p.cannons) {
          if (c.hp > 0)
            enemies.push({
              x: (c.col + 0.5) * TILE_SIZE,
              y: (c.row + 0.5) * TILE_SIZE,
            });
        }
      }
      w.__testEnemyCannons = enemies;
      const targets: { x: number; y: number }[] = [...enemies];
      for (const p of rs.state.players) {
        if (p.id === myPid || p.eliminated) continue;
        for (const key of p.walls) {
          const { r, c } = unpackTile(key);
          targets.push({ x: (c + 0.5) * TILE_SIZE, y: (r + 0.5) * TILE_SIZE });
        }
      }
      w.__testEnemyTargets = targets;
      const myCtrl = rs.controllers[myPid];
      if (myCtrl) {
        const ch = myCtrl.getCrosshair();
        if (ch) w.__testCrosshair = { x: ch.x, y: ch.y };
      }
    }
  }

  function mainLoop(now: number): void {
    const dt = clampedFrameDt(now);
    rs.frameDt = dt;
    resetFrame();

    rs.ctx = computeFrameContext({
      mode: rs.mode,
      phase: isStateReady(rs) ? rs.state.phase : Phase.CASTLE_SELECT,
      timer: isStateReady(rs) ? rs.state.timer : 0,
      paused: rs.paused,
      quitPending: rs.quitPending,
      hasLifeLostDialog: rs.lifeLostDialog !== null,
      isSelectionReady: isSelectionReady(),
      humanIsReselecting: rs.reselectQueue.includes(
        firstHuman()?.playerId ?? -1,
      ),
      myPlayerId: config.getMyPlayerId(),
      firstHumanPlayerId: firstHuman()?.playerId ?? -1,
      isHost: config.getIsHost(),
      remoteHumanSlots: config.getRemoteHumanSlots(),
      mobileAutoZoom: camera.isMobileAutoZoom(),
    });

    tickCamera();

    // Tick score delta display timer (mode-independent so it counts during banner/castle-build)
    if (rs.scoreDeltaTimer > 0) {
      rs.scoreDeltaTimer -= dt;
      if (rs.scoreDeltaTimer <= 0) {
        rs.scoreDeltas = [];
        rs.scoreDeltaTimer = 0;
        const cb = rs.scoreDeltaOnDone;
        rs.scoreDeltaOnDone = null;
        cb?.();
      }
    }

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
      mode: rs.mode,
      paused: rs.paused,
      quitPending: rs.quitPending,
      quitTimer: rs.quitTimer,
      quitMessage: rs.quitMessage,
      frame: rs.frame,
      setQuitPending: (v: boolean) => {
        rs.quitPending = v;
      },
      setQuitTimer: (v: number) => {
        rs.quitTimer = v;
      },
      render,
      ticks: modeTickers,
    });

    if (DEV) exposeTestGlobals();
    if (shouldContinue && rs.mode !== Mode.STOPPED)
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

  function isSelectionReady(): boolean {
    return rs.accum.selectAnnouncement >= SELECT_ANNOUNCEMENT_DURATION;
  }

  // -------------------------------------------------------------------------
  // Banner
  // -------------------------------------------------------------------------

  /** Show a phase-transition banner with text and optional battle reveal.
   *  @param onDone — Called exactly once when the banner animation completes.
   *    Must not be called again or stored for later — the banner system nulls
   *    its internal reference after invoking it. */
  function showBanner(
    text: string,
    onDone: () => void,
    reveal = false,
    newBattle?: { territory: Set<number>[]; walls: Set<number>[] },
    subtitle?: string,
  ) {
    // Unzoom before banner so the full map is visible during transition
    camera.lightUnzoom();
    if (rs.banner.active) {
      config.log(
        `showBanner "${text}" while banner "${rs.banner.text}" is still active`,
      );
    }
    showBannerTransition({
      banner: rs.banner,
      state: rs.state,
      battleAnim: rs.battleAnim,
      text,
      subtitle,
      onDone,
      reveal,
      newBattle,
      setModeBanner: () => {
        rs.mode = Mode.BANNER;
      },
    });
    haptics.phaseChange();
    sound.phaseStart();
  }

  function tickBanner(dt: number) {
    tickBannerTransition(rs.banner, dt, BANNER_DURATION, render);
  }

  // -------------------------------------------------------------------------
  // Territory / human helpers
  // -------------------------------------------------------------------------

  function snapshotTerritory(): Set<number>[] {
    return snapshotTerritoryImpl(rs.state.players);
  }

  let cachedFirstHuman: (PlayerController & InputReceiver) | null | undefined;

  function firstHuman(): (PlayerController & InputReceiver) | null {
    if (cachedFirstHuman !== undefined) return cachedFirstHuman;
    // Prefer the player who joined via mouse/trackpad
    if (rs.mouseJoinedSlot >= 0) {
      const ctrl = rs.controllers.find(
        (c) => c.playerId === rs.mouseJoinedSlot,
      );
      if (ctrl && isHuman(ctrl) && !rs.state.players[ctrl.playerId]?.eliminated)
        return (cachedFirstHuman = ctrl);
    }
    for (const ctrl of rs.controllers) {
      if (isHuman(ctrl) && !rs.state.players[ctrl.playerId]?.eliminated)
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
    getState: () => safeState(rs),
    getCtx: () => rs.ctx,
    getFrameDt: () => rs.frameDt,
    setFrameAnnouncement: (text) => {
      rs.frame.announcement = text;
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
    rs,
    send: config.send,
    log: config.log,
    camera,
    sound,
    render: () => render(),
    firstHuman,
    startCannonPhase: (onDone) => phaseTicks.startCannonPhase(onDone),
    requestFrame: () => {
      if (rs.mode === Mode.STOPPED) requestAnimationFrame(mainLoop);
    },
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function render() {
    // Summary log: crosshairs, phantoms, impacts per frame (throttled 1/s)
    const chList = rs.frame.crosshairs ?? [];
    const selH = rs.overlay.selection?.highlights;
    config.logThrottled(
      "render-summary",
      createRenderSummaryMessage({
        phaseName: Phase[rs.state.phase],
        timer: rs.state.timer,
        crosshairs: chList,
        aiPhantomsCount: rs.frame.phantoms?.aiPhantoms?.length ?? 0,
        humanPhantomsCount: rs.frame.phantoms?.humanPhantoms?.length ?? 0,
        aiCannonPhantomsCount: rs.frame.phantoms?.aiCannonPhantoms?.length ?? 0,
        impactsCount: rs.battleAnim.impacts.length,
        cannonballsCount: rs.state.cannonballs.length,
        selectionHighlights: selH,
      }),
    );

    // Refresh crosshairs from controller state when paused
    if (rs.state.phase === Phase.BATTLE && rs.paused) {
      phaseTicks.syncCrosshairs(rs.state.battleCountdown <= 0);
    }

    const bannerUi = createBannerUi(
      rs.banner.active,
      rs.banner.text,
      rs.banner.progress,
      rs.banner.subtitle,
    );

    rs.overlay = createOnlineOverlay({
      previousSelection: rs.overlay.selection,
      state: rs.state,
      banner: rs.banner,
      battleAnim: rs.battleAnim,
      frame: rs.frame,
      bannerUi,
      lifeLostDialog: rs.lifeLostDialog,
      playerNames: PLAYER_NAMES,
      playerColors: PLAYER_COLORS,
      getLifeLostPanelPos: (playerId) => lifeLost.panelPos(playerId),
    });

    // Status bar (rendered inside canvas)
    if (rs.overlay.ui) {
      rs.overlay.ui.statusBar = createStatusBar(rs.state, PLAYER_COLORS);
    }

    // Add score deltas to overlay (shown briefly before Place Cannons banner)
    if (rs.scoreDeltas.length > 0 && rs.overlay.ui) {
      rs.overlay.ui.scoreDeltas = rs.scoreDeltas;
      rs.overlay.ui.scoreDeltaProgress =
        1 - rs.scoreDeltaTimer / SCORE_DELTA_DISPLAY_TIME;
    }

    renderFrame(rs.state.map, rs.overlay, updateViewport());

    // Update touch controls (loupe, d-pad, zoom, quit, floating actions)
    updateTouchControls({
      mode: rs.mode,
      state: rs.state,
      phantoms: rs.frame.phantoms,
      directTouchActive: rs.directTouchActive,
      leftHanded: rs.settings.leftHanded,
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
    rs,
    log: config.log,
    showLobby: config.showLobby,
    onEndGame: config.onEndGame,
    camera,
    sound,
    selection,
    render: () => render(),
    resetFrame,
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
    rs,
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
    rs,
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
    getState: () => safeState(rs),
    getOverlay: () => rs.overlay,
    settings: rs.settings,
    getMode: () => rs.mode,
    setMode: (m) => {
      rs.mode = m;
    },
    getPaused: () => rs.paused,
    setPaused: (v) => {
      rs.paused = v;
    },
    optionsCursor: {
      get value() {
        return rs.optionsCursor;
      },
      set value(v) {
        rs.optionsCursor = v;
      },
    },
    controlsState: rs.controlsState,
    getOptionsReturnMode: () => rs.optionsReturnMode,
    setOptionsReturnMode: (m) => {
      rs.optionsReturnMode = m;
    },
    lobby: rs.lobby,
    getFrame: () => rs.frame,
    getLobbyRemaining: config.getLobbyRemaining,
    isOnline: !!config.isOnline,
  };

  // Initialize options system first (lobby depends on showOptions)
  options = createOptionsSystem({
    rs,
    uiCtx,
    renderFrame,
    updateDpad: (phase) => input.touch.dpad?.update(phase),
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
    rs,
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
    rs,
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
    rs,

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
    resetFrame,
    render,
    registerInputHandlers: input.register,
    showBanner,
    snapshotTerritory,
    aimAtEnemyCastle: camera.aimAtEnemyCastle,
  };
}
