/**
 * Shared game runtime factory — consolidates all orchestration code
 * from main.ts (local) and online-client.ts (online).
 *
 * createGameRuntime(config) returns a RuntimeState bag (rs) plus
 * methods that operate on it. See runtime-state.ts for the state type.
 */

import {
  type InputReceiver,
  isHuman,
  type PlayerController,
} from "./controller-interfaces.ts";
import {
  snapshotTerritory as snapshotTerritoryImpl,
  tickMainLoop,
} from "./game-ui-helpers.ts";
import type { UIContext } from "./game-ui-screens.ts";
import { TILE_SIZE } from "./grid.ts";
import { createHapticsSystem } from "./haptics-system.ts";
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
import { createLobbySystem, type LobbySystem } from "./runtime-lobby.ts";
import { createOptionsSystem, type OptionsSystem } from "./runtime-options.ts";
import {
  createPhaseTicksSystem,
  type PhaseTicksSystem,
} from "./runtime-phase-ticks.ts";
import {
  createSelectionSystem,
  type SelectionSystem,
} from "./runtime-selection.ts";
import { createRuntimeState } from "./runtime-state.ts";
import { updateTouchControls } from "./runtime-touch-ui.ts";
import type { GameRuntime, RuntimeConfig } from "./runtime-types.ts";
import { createSoundSystem } from "./sound-system.ts";
import { pxToTile, towerCenterPx, unpackTile } from "./spatial.ts";
import {
  BANNER_DURATION,
  computeFrameContext,
  MAX_FRAME_DT,
  Mode,
  Phase,
  SCORE_DELTA_DISPLAY_TIME,
  SELECT_ANNOUNCEMENT_DURATION,
} from "./types.ts";

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

  // Sub-systems initialized after uiCtx (forward-declared, assigned once)
  // deno-lint-ignore prefer-const
  let lobby: LobbySystem;
  // deno-lint-ignore prefer-const
  let options: OptionsSystem;

  // Input system (forward-declared, assigned after all sub-systems are created)
  // deno-lint-ignore prefer-const
  let input: ReturnType<typeof createInputSystem>;

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
    w.__testPhase = rs.state ? Phase[rs.state.phase] : "";
    w.__testTimer = rs.state ? rs.state.timer : 0;
    const myPid = config.getMyPlayerId();
    if (rs.state && myPid >= 0) {
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
      phase: rs.state?.phase ?? Phase.CASTLE_SELECT,
      timer: rs.state?.timer ?? 0,
      paused: rs.paused,
      quitPending: rs.quitPending,
      hasLifeLostDialog: rs.lifeLostDialog !== null,
      isSelectionReady: isSelectionReady(),
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
      ticks: {
        [Mode.LOBBY]: (dt: number) => lobby.tickLobby(dt),
        [Mode.OPTIONS]: () => options.renderOptions(),
        [Mode.CONTROLS]: () => options.renderControls(),
        [Mode.SELECTION]: (dt: number) => selection.tick(dt),
        [Mode.BANNER]: tickBanner,
        [Mode.BALLOON_ANIM]: (dt: number) => phaseTicks.tickBalloonAnim(dt),
        [Mode.CASTLE_BUILD]: (dt: number) => selection.tickCastleBuild(dt),
        [Mode.LIFE_LOST]: (dt: number) => lifeLost.tick(dt),
        [Mode.GAME]: (dt: number) => phaseTicks.tickGame(dt),
      },
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
  // Touch battle targeting (aimAtEnemyCastle)
  // -------------------------------------------------------------------------

  /** Crosshair position from the previous battle (null = first battle). */
  let lastBattleCrosshair: { x: number; y: number } | null = null;

  /**
   * Position the human crosshair at the start of battle (touch devices).
   * - First battle: aim at best enemy's home tower.
   * - Subsequent battles: restore last position (unless that opponent died).
   * - Without auto-zoom: don't move the cursor (first tap positions it).
   */
  function aimAtEnemyCastle(): void {
    if (!rs.state) return;
    const human = firstHuman();
    if (!human) return;

    if (!camera.isMobileAutoZoom()) return;

    // Subsequent battle: restore last position if targeted opponent is alive
    if (lastBattleCrosshair) {
      const row = pxToTile(lastBattleCrosshair.y);
      const col = pxToTile(lastBattleCrosshair.x);
      const zone = rs.state.map.zones[row]?.[col];
      if (zone !== undefined) {
        const pid = rs.state.playerZones.indexOf(zone);
        if (
          pid >= 0 &&
          pid !== camera.myPlayerId() &&
          !rs.state.players[pid]?.eliminated
        ) {
          human.setCrosshair(lastBattleCrosshair.x, lastBattleCrosshair.y);
          return;
        }
      }
      // Targeted opponent died or invalid — fall through to best enemy
    }

    // First battle or opponent died: aim at best enemy's home tower
    const zone = camera.getBestEnemyZone();
    if (zone === null) return;
    const pid = rs.state.playerZones.indexOf(zone);
    const tower = pid >= 0 ? rs.state.players[pid]?.homeTower : null;
    if (!tower) return;
    const px = towerCenterPx(tower);
    human.setCrosshair(px.x, px.y);
    lastBattleCrosshair = { x: px.x, y: px.y };
  }

  // -------------------------------------------------------------------------
  // Banner
  // -------------------------------------------------------------------------

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
    getState: () => rs.state,
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
    startCannonPhase: () => phaseTicks.startCannonPhase(),
    showBanner,
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
    resetBattleCrosshair: () => {
      lastBattleCrosshair = null;
    },
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
      ? () => {
          const human = firstHuman();
          if (human) {
            const ch = human.getCrosshair();
            lastBattleCrosshair = { x: ch.x, y: ch.y };
          }
        }
      : undefined,
    onBeginBattle: IS_TOUCH_DEVICE ? aimAtEnemyCastle : undefined,
    sound,
    haptics,
  });

  // -------------------------------------------------------------------------
  // UIContext — bridges internal state to game-ui-screens.ts functions
  // -------------------------------------------------------------------------

  const uiCtx: UIContext = {
    getState: () => rs.state,
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
    refreshLobbySeed: () => lobby.refreshLobbySeed(),
    sound,
    haptics,
    isOnline: !!config.isOnline,
    getRemoteHumanSlots: config.getRemoteHumanSlots,
    onCloseOptions: config.onCloseOptions,
  });

  // Initialize lobby system (needs options.showOptions)
  lobby = createLobbySystem({
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
    phaseTicks: { startCannonPhase: phaseTicks.startCannonPhase },

    // Cross-cutting orchestration
    mainLoop,
    resetFrame,
    render,
    registerInputHandlers: input.register,
    showBanner,
    snapshotTerritory,
    aimAtEnemyCastle,
  };
}
