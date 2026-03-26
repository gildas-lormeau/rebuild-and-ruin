/**
 * Shared game runtime factory — consolidates all orchestration code
 * from main.ts (local) and online-client.ts (online).
 *
 * createGameRuntime(config) returns a RuntimeState bag (rs) plus
 * methods that operate on it. See runtime-state.ts for the state type.
 */

import { createController, isHuman } from "./controller-factory.ts";
import { computeFrameContext } from "./frame-context.ts";
import { bootstrapGame } from "./game-bootstrap.ts";
import type { GameRuntime, RuntimeConfig } from "./game-runtime-types.ts";
import {
  lobbyClickHitTest,
  mainLoopTick,
  snapshotTerritory as snapshotTerritoryImpl,
} from "./game-ui-runtime.ts";
import type { UIContext } from "./game-ui-screens.ts";
import {
  buildControlsOverlay,
  buildLobbyOverlay,
  buildOptionsOverlay,
  closeControls as closeControlsShared,
  closeOptions as closeOptionsShared,
  lobbyKeyJoin as lobbyKeyJoinShared,
  lobbySkipStep,
  showControls as showControlsShared,
  showOptions as showOptionsShared,
  tickLobby as tickLobbyShared,
  togglePause as togglePauseShared,
  visibleOptions,
} from "./game-ui-screens.ts";
import {
  CANNON_HP_OPTIONS,
  computeGameSeed,
  createBattleAnimState,
  createTimerAccums,
  cycleOption,
  DIFFICULTY_PARAMS,
  FOCUS_MENU,
  FOCUS_REMATCH,
  Mode,
  ROUNDS_OPTIONS,
} from "./game-ui-types.ts";
import { GRID_COLS, GRID_ROWS, SCALE, TILE_SIZE } from "./grid.ts";
import { hapticPhaseChange, setHapticsLevel } from "./haptics.ts";
import { type RegisterOnlineInputDeps, registerOnlineInputHandlers } from "./input.ts";
import { clientToCanvas, dispatchPointerMove } from "./input-dispatch.ts";
import { registerTouchHandlers } from "./input-touch.ts";
import { CHOICE_ABANDON, CHOICE_CONTINUE, CHOICE_PENDING } from "./life-lost.ts";
import { createLoupe, type LoupeHandle } from "./loupe.ts";
import { generateMap } from "./map-generation.ts";
import {
  createBannerState,
  showBannerTransition,
  tickBannerTransition,
} from "./phase-banner.ts";
import { IS_DEV, IS_TOUCH_DEVICE } from "./platform.ts";
import {
  getPlayerColor,
  MAX_PLAYERS,
  PLAYER_COLORS,
  PLAYER_KEY_BINDINGS,
  PLAYER_NAMES,
} from "./player-config.ts";
import type { InputReceiver, PlayerController } from "./player-controller.ts";
import {
  buildBannerUi,
  buildOnlineOverlay,
  buildRenderSummaryMessage,
  buildStatusBar,
} from "./render-composition.ts";
import { getSceneCanvas, renderMap } from "./render-map.ts";
import { computeLobbyLayout, gameOverButtonHitTest } from "./render-ui.ts";
import { MAX_UINT32 } from "./rng.ts";
import { createCameraSystem } from "./runtime-camera.ts";
import type { LifeLostSystem } from "./runtime-life-lost.ts";
import { createLifeLostSystem } from "./runtime-life-lost.ts";
import type { PhaseTicksSystem } from "./runtime-phase-ticks.ts";
import { createPhaseTicksSystem } from "./runtime-phase-ticks.ts";
import type { SelectionSystem } from "./runtime-selection.ts";
import { createSelectionSystem } from "./runtime-selection.ts";
import { createRuntimeState } from "./runtime-state.ts";
import { towerCenter, unpackTile } from "./spatial.ts";
import { createDpad, createEnemyZoomButton, createFloatingActions, createHomeZoomButton, createQuitButton } from "./touch-ui.ts";
import type { GameState } from "./types.ts";
import {
  BANNER_DURATION,
  isPlacementPhase,
  MAX_FRAME_DT,
  Phase,
  SCORE_DELTA_DISPLAY_TIME,
  SELECT_ANNOUNCEMENT_DURATION,
} from "./types.ts";

export type { GameRuntime } from "./game-runtime-types.ts";

type TouchBtnRule = boolean | "human";

interface TouchButtonState {
  dpad: TouchBtnRule;
  confirm: TouchBtnRule;
  rotate: TouchBtnRule;
  placementValidity: TouchBtnRule;
  zoom: TouchBtnRule;
  quit: boolean;
}

const TOUCH_BUTTON_STATES: Record<Mode, TouchButtonState> = {
  //                       dpad     confirm  rotate   validity zoom     quit
  [Mode.LOBBY]:        { dpad: false,   confirm: true,    rotate: false,   placementValidity: false,   zoom: false,   quit: false },
  [Mode.OPTIONS]:      { dpad: true,    confirm: true,    rotate: true,    placementValidity: false,   zoom: false,   quit: false },
  [Mode.CONTROLS]:     { dpad: false,   confirm: false,   rotate: false,   placementValidity: false,   zoom: false,   quit: false },
  [Mode.SELECTION]:    { dpad: "human", confirm: "human", rotate: false,   placementValidity: false,   zoom: "human", quit: true  },
  [Mode.BANNER]:       { dpad: false,   confirm: false,   rotate: false,   placementValidity: false,   zoom: "human", quit: true  },
  [Mode.BALLOON_ANIM]: { dpad: false,   confirm: false,   rotate: false,   placementValidity: false,   zoom: "human", quit: true  },
  [Mode.CASTLE_BUILD]: { dpad: false,   confirm: false,   rotate: false,   placementValidity: false,   zoom: "human", quit: true  },
  [Mode.LIFE_LOST]:    { dpad: "human", confirm: "human", rotate: false,   placementValidity: false,   zoom: "human", quit: true  },
  [Mode.GAME]:         { dpad: "human", confirm: "human", rotate: "human", placementValidity: "human", zoom: "human", quit: true  },
  [Mode.STOPPED]:      { dpad: "human", confirm: "human", rotate: false,   placementValidity: false,   zoom: false,   quit: false },
};

export function createGameRuntime(config: RuntimeConfig): GameRuntime {
  const { canvas } = config;
  const gameContainer = canvas.parentElement as HTMLElement;

  // -------------------------------------------------------------------------
  // Mutable state (shared bag — see runtime-state.ts)
  // -------------------------------------------------------------------------

  const rs = createRuntimeState();
  setHapticsLevel(rs.settings.haptics);

  // DOM-only locals (not shared with consumers)
  let dpad: ReturnType<typeof createDpad> | null = null;
  let floatingActions: ReturnType<typeof createFloatingActions> | null = null;
  let homeZoomButton: ReturnType<typeof createHomeZoomButton> | null = null;
  let enemyZoomButton: ReturnType<typeof createEnemyZoomButton> | null = null;
  let quitButton: ReturnType<typeof createQuitButton> | null = null;
  let loupeHandle: LoupeHandle | null = null;

  function resetGameStats() {
    rs.gameStats = Array.from({ length: MAX_PLAYERS }, () => ({
      wallsDestroyed: 0, cannonsKilled: 0,
    }));
  }

  // -------------------------------------------------------------------------
  // Frame/timing helpers
  // -------------------------------------------------------------------------

  function resetFrame(): void {
    rs.frame = { crosshairs: [], phantoms: {} };
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
    const w = window as unknown as Record<string, unknown>;
    w.__testMode = Mode[rs.mode];
    w.__testPhase = rs.state ? Phase[rs.state.phase] : "";
    w.__testTimer = rs.state ? rs.state.timer : 0;
    const myPid = config.getMyPlayerId();
    if (rs.state && myPid >= 0) {
      const enemies: { x: number; y: number }[] = [];
      for (const p of rs.state.players) {
        if (p.id === myPid || p.eliminated) continue;
        for (const c of p.cannons) {
          if (c.hp > 0) enemies.push({ x: (c.col + 0.5) * TILE_SIZE, y: (c.row + 0.5) * TILE_SIZE });
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

    if (DEV) exposeTestGlobals();

    tickCamera(dt);

    // Tick score delta display timer (mode-independent so it counts during banner/castle-build)
    if (rs.scoreDeltaTimer > 0) {
      rs.scoreDeltaTimer -= dt;
      if (rs.scoreDeltaTimer <= 0) {
        rs.scoreDeltas = []; rs.scoreDeltaTimer = 0;
        const cb = rs.scoreDeltaOnDone; rs.scoreDeltaOnDone = null; cb?.();
      }
    }

    const shouldContinue = mainLoopTick({
      dt,
      mode: rs.mode,
      paused: rs.paused,
      quitPending: rs.quitPending,
      quitTimer: rs.quitTimer,
      quitMessage: rs.quitMessage,
      frame: rs.frame,
      setQuitPending: (v: boolean) => { rs.quitPending = v; },
      setQuitTimer: (v: number) => { rs.quitTimer = v; },
      render,
      ticks: {
        [Mode.LOBBY]: tickLobby,
        [Mode.OPTIONS]: () => renderOptions(),
        [Mode.CONTROLS]: () => renderControls(),
        [Mode.SELECTION]: (dt: number) => selection.tick(dt),
        [Mode.BANNER]: tickBanner,
        [Mode.BALLOON_ANIM]: (dt: number) => phaseTicks.tickBalloonAnim(dt),
        [Mode.CASTLE_BUILD]: (dt: number) => selection.tickCastleBuild(dt),
        [Mode.LIFE_LOST]: (dt: number) => lifeLost.tick(dt),
        [Mode.GAME]: (dt: number) => phaseTicks.tickGame(dt),
      },
    });

    if (shouldContinue) requestAnimationFrame(mainLoop);
  }

  // -------------------------------------------------------------------------
  // Lobby
  // -------------------------------------------------------------------------

  function refreshLobbySeed(): void {
    rs.lobby.seed = computeGameSeed(rs.settings);
    rs.lobby.map = generateMap(rs.lobby.seed);
  }

  function renderLobby(): void {
    if (!rs.lobby.map) refreshLobbySeed();
    const { map, overlay } = buildLobbyOverlay(uiCtx);
    renderMap(map, canvas, overlay);
  }

  function tickLobby(dt: number): void {
    rs.lobby.timerAccum = (rs.lobby.timerAccum ?? 0) + dt;
    renderLobby();
    tickLobbyShared(uiCtx, () => {
      config.onTickLobbyExpired();
    });
  }

  function onLobbyJoin(pid: number): void {
    config.onLobbySlotJoined(pid);
    renderLobby();
    // On touch devices in local mode, start immediately after joining
    if (IS_TOUCH_DEVICE && !config.isOnline) {
      rs.lobby.active = false;
      config.onTickLobbyExpired();
    }
  }

  function lobbyKeyJoin(key: string): boolean {
    return lobbyKeyJoinShared(uiCtx, key, onLobbyJoin);
  }

  function lobbyClick(canvasX: number, canvasY: number): boolean {
    if (!rs.lobby.active) return false;
    const hit = lobbyClickHitTest({
      canvasX,
      canvasY,
      canvasW: GRID_COLS * TILE_SIZE * SCALE,
      canvasH: GRID_ROWS * TILE_SIZE * SCALE,
      tileSize: TILE_SIZE,
      slotCount: MAX_PLAYERS,
      computeLayout: computeLobbyLayout,
    });
    if (!hit) return false;
    if (hit.type === "gear") {
      showOptions();
      return true;
    }
    // Mouse/trackpad can only join one slot (keyboard can join additional slots)
    if (rs.mouseJoinedSlot >= 0) {
      lobbySkipStep(uiCtx);
      return true;
    }
    if (!rs.lobby.joined[hit.slotId]) {
      rs.mouseJoinedSlot = hit.slotId;
      onLobbyJoin(hit.slotId);
    }
    return true;
  }

  function isSelectionReady(): boolean {
    return rs.accum.selectAnnouncement >= SELECT_ANNOUNCEMENT_DURATION;
  }

  /** Place the human crosshair on the best enemy castle (matches auto-zoom target). */
  function aimAtEnemyCastle(): void {
    if (!rs.state) return;
    const zone = camera.getBestEnemyZone();
    if (zone === null) return;
    const pid = rs.state.playerZones.indexOf(zone);
    const tower = pid >= 0 ? rs.state.players[pid]?.homeTower : null;
    if (!tower) return;
    const c = towerCenter(tower);
    firstHuman()?.setCrosshair(c.col * TILE_SIZE, c.row * TILE_SIZE);
  }

  // -------------------------------------------------------------------------
  // Options screen
  // -------------------------------------------------------------------------

  /** Map cursor row to real option index. */
  function realOptionIdx(): number {
    return visibleOptionsForCtx()[rs.optionsCursor] ?? rs.optionsCursor;
  }

  function visibleOptionsForCtx(): number[] {
    return visibleOptions(uiCtx);
  }

  function changeOption(dir: number): void {
    cycleOption(
      dir,
      realOptionIdx(),
      rs.settings,
      rs.optionsReturnMode,
      rs.state ?? null,
      config.isOnline,
    );
    setHapticsLevel(rs.settings.haptics);
    dpad?.setLeftHanded(rs.settings.leftHanded);
  }

  function renderOptions(): void {
    const { map, overlay } = buildOptionsOverlay(uiCtx);
    renderMap(map, canvas, overlay);
  }

  function showOptions(): void {
    showOptionsShared(uiCtx, { OPTIONS: Mode.OPTIONS });
    dpad?.update(Phase.WALL_BUILD); // enable d-pad for options navigation
  }

  function closeOptions(): void {
    const wasInGame = rs.optionsReturnMode !== null;
    closeOptionsShared(uiCtx, { LOBBY: Mode.LOBBY, GAME: Mode.GAME });
    if (wasInGame) {
      rs.lastTime = performance.now(); // avoid huge dt on first frame back
    } else {
      refreshLobbySeed(); // regenerate map preview with (possibly changed) seed
      dpad?.update(null); // back to lobby — disable d-pad
    }
    config.onCloseOptions?.();
  }

  // -------------------------------------------------------------------------
  // Controls screen
  // -------------------------------------------------------------------------

  function renderControls(): void {
    const { map, overlay } = buildControlsOverlay(uiCtx);
    renderMap(map, canvas, overlay);
  }

  function showControls(): void {
    showControlsShared(uiCtx, { CONTROLS: Mode.CONTROLS });
    dpad?.update(Phase.WALL_BUILD); // enable d-pad for controls navigation
  }

  function closeControls(): void {
    if (rs.optionsReturnMode !== null) {
      for (const ctrl of rs.controllers) {
        const kb = rs.settings.keyBindings[ctrl.playerId];
        if (kb) ctrl.updateBindings(kb);
      }
    }
    closeControlsShared(uiCtx, { OPTIONS: Mode.OPTIONS });
  }

  function togglePause(): boolean {
    // Disable pause when other human players are connected
    if (config.getRemoteHumanSlots().size > 0) return false;
    return togglePauseShared(uiCtx, { GAME: Mode.GAME, SELECTION: Mode.SELECTION });
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
      config.log(`showBanner "${text}" while banner "${rs.banner.text}" is still active`);
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
      setModeBanner: () => { rs.mode = Mode.BANNER; },
    });
    hapticPhaseChange();
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

  function firstHuman(): (PlayerController & InputReceiver) | null {
    // Prefer the player who joined via mouse/trackpad
    if (rs.mouseJoinedSlot >= 0) {
      const ctrl = rs.controllers.find(c => c.playerId === rs.mouseJoinedSlot);
      if (ctrl && isHuman(ctrl) && !rs.state.players[ctrl.playerId]?.eliminated) return ctrl;
    }
    for (const ctrl of rs.controllers) {
      if (isHuman(ctrl) && !rs.state.players[ctrl.playerId]?.eliminated) return ctrl;
    }
    return null;
  }

  function withFirstHuman(action: (human: PlayerController & InputReceiver) => void): void {
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
    setFrameAnnouncement: (text) => { rs.frame.announcement = text; },
  });

  // Re-export camera functions used by other parts of the runtime
  const { tickCamera, updateViewport, screenToWorld, pixelToTile,
    onPinchStart, onPinchUpdate, onPinchEnd,
    myPlayerId, getEnemyZones } = camera;

  // -------------------------------------------------------------------------
  // Selection sub-system (delegated to runtime-selection.ts)
  // -------------------------------------------------------------------------

  const selection: SelectionSystem = createSelectionSystem({
    rs,
    send: config.send,
    log: config.log,
    lightUnzoom: () => camera.lightUnzoom(),
    clearCastleBuildViewport: () => camera.clearCastleBuildViewport(),
    setCastleBuildViewport: (plans) => camera.setCastleBuildViewport(plans),
    setSelectionViewport: (row, col) => camera.setSelectionViewport(row, col),
    computeZoneBounds: camera.computeZoneBounds,
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
      buildRenderSummaryMessage({
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
      phaseTicks.collectCrosshairs(rs.state.battleCountdown <= 0);
    }

    const bannerUi = buildBannerUi(rs.banner.active, rs.banner.text, rs.banner.progress, rs.banner.subtitle);

    rs.overlay = buildOnlineOverlay({
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
      rs.overlay.ui.statusBar = buildStatusBar(rs.state, PLAYER_COLORS);
    }

    // Add score deltas to overlay (shown briefly before Place Cannons banner)
    if (rs.scoreDeltas.length > 0 && rs.overlay.ui) {
      rs.overlay.ui.scoreDeltas = rs.scoreDeltas;
      rs.overlay.ui.scoreDeltaProgress = 1 - rs.scoreDeltaTimer / SCORE_DELTA_DISPLAY_TIME;
    }

    renderMap(rs.state.map, canvas, rs.overlay, updateViewport());

    // Update loupe for precision placement / aiming on touch
    if (loupeHandle) {
      const phase = rs.state.phase;
      const loupeVisible = rs.mode === Mode.GAME &&
        (isPlacementPhase(phase) || phase === Phase.BATTLE);
      const human = firstHuman();
      let wx = 0;
      let wy = 0;
      if (human && phase === Phase.BATTLE) {
        const ch = human.getCrosshair();
        wx = ch.x;
        wy = ch.y;
      } else if (human) {
        const cursor = phase === Phase.WALL_BUILD ? human.buildCursor : human.cannonCursor;
        const piece = phase === Phase.WALL_BUILD ? human.getCurrentPiece() : null;
        const pivotR = piece ? piece.pivot[0] : 0;
        const pivotC = piece ? piece.pivot[1] : 0;
        wx = (cursor.col + pivotC + 0.5) * TILE_SIZE;
        wy = (cursor.row + pivotR + 0.5) * TILE_SIZE;
      }
      loupeHandle.update(loupeVisible && human !== null, wx, wy, getSceneCanvas());
    }

    const hasHuman = firstHuman() !== null;
    const bs = TOUCH_BUTTON_STATES[rs.mode];
    const on = (rule: TouchBtnRule) => rule === true || (rule === "human" && hasHuman);

    // D-pad, rotate, confirm
    dpad?.update(on(bs.dpad) ? (rs.state?.phase ?? Phase.WALL_BUILD) : null, !on(bs.rotate));
    if (dpad) {
      if (!on(bs.confirm)) {
        dpad.setConfirmValid(false);
      } else if (rs.state && isPlacementPhase(rs.state.phase) && on(bs.placementValidity)) {
        const human = firstHuman();
        const barValid = rs.state.phase === Phase.WALL_BUILD
          ? rs.frame.phantoms.humanPhantoms?.[0]?.valid ?? true
          : rs.frame.phantoms.aiCannonPhantoms?.find(p => p.playerId === human?.playerId)?.valid ?? true;
        dpad.setConfirmValid(barValid);
      } else {
        dpad.setConfirmValid(true);
      }
    }

    // Zoom, quit
    homeZoomButton?.update(on(bs.zoom));
    enemyZoomButton?.update(on(bs.zoom));
    quitButton?.update(bs.quit ? rs.state.phase : null);
    updateFloatingActions();
  }

  /** Position and show/hide the floating Rotate+Confirm buttons over the canvas. */
  function updateFloatingActions(): void {
    if (!floatingActions) return;
    const phase = rs.state?.phase;
    const human = firstHuman();
    const hasPhantom = phase === Phase.WALL_BUILD
      ? (rs.frame.phantoms.humanPhantoms?.length ?? 0) > 0
      : (rs.frame.phantoms.aiCannonPhantoms?.some(p => p.playerId === human?.playerId) ?? false);
    const visible = rs.directTouchActive && human !== null &&
      rs.mode === Mode.GAME &&
      isPlacementPhase(phase) &&
      hasPhantom;
    if (!visible) {
      floatingActions.update(false, 0, 0, false, false);
      return;
    }

    // Phantom center in world-pixel (tile-pixel) coordinates
    let wx: number;
    let wy: number;
    if (phase === Phase.WALL_BUILD) {
      const cursor = human.buildCursor;
      const piece = human.getCurrentPiece();
      const pc = piece ? piece.pivot[1] : 0;
      wx = (cursor.col + pc + 0.5) * TILE_SIZE;
      wy = cursor.row * TILE_SIZE;
    } else {
      const cursor = human.cannonCursor;
      wx = (cursor.col + 1) * TILE_SIZE;
      wy = cursor.row * TILE_SIZE;
    }

    // World-pixel → canvas backing-store pixel
    const vp = camera.getViewport();
    const cw = GRID_COLS * TILE_SIZE * SCALE;
    const gameH = GRID_ROWS * TILE_SIZE * SCALE;
    let sx: number;
    let sy: number;
    if (vp) {
      sx = ((wx - vp.x) / vp.w) * cw;
      sy = ((wy - vp.y) / vp.h) * gameH;
    } else {
      sx = wx * SCALE;
      sy = wy * SCALE;
    }

    // Canvas backing-store → CSS pixels relative to game container
    const rect = canvas.getBoundingClientRect();
    const containerRect = gameContainer.getBoundingClientRect();
    const canvasRatio = canvas.width / canvas.height;
    const rectRatio = rect.width / rect.height;
    let contentW: number;
    let contentH: number;
    let offsetX: number;
    let offsetY: number;
    if (rectRatio > canvasRatio) {
      contentH = rect.height;
      contentW = rect.height * canvasRatio;
      offsetX = (rect.width - contentW) / 2;
      offsetY = 0;
    } else {
      contentW = rect.width;
      contentH = rect.width / canvasRatio;
      offsetX = 0;
      offsetY = (rect.height - contentH) / 2;
    }
    const cssX = (sx / canvas.width) * contentW + offsetX + (rect.left - containerRect.left);
    const cssY = (sy / canvas.height) * contentH + offsetY + (rect.top - containerRect.top);
    const nearTop = cssY < contentH * 0.15;
    // Check placement validity from phantom data
    const phantomValid = phase === Phase.WALL_BUILD
      ? rs.frame.phantoms.humanPhantoms?.[0]?.valid ?? false
      : rs.frame.phantoms.aiCannonPhantoms?.find(p => p.playerId === human.playerId)?.valid ?? false;
    floatingActions.update(true, cssX, cssY, nearTop, rs.settings.leftHanded);
    floatingActions.setConfirmValid(phantomValid);
  }

  function rematch() {
    camera.resetCamera();
    startGame();
    rs.mode = Mode.SELECTION;
  }

  function gameOverClick(canvasX: number, canvasY: number): void {
    const gameOver = rs.frame.gameOver;
    if (!gameOver) return;
    const W = GRID_COLS * TILE_SIZE;
    const H = GRID_ROWS * TILE_SIZE;
    const hit = gameOverButtonHitTest(canvasX / SCALE, canvasY / SCALE, W, H, gameOver);
    if (hit === FOCUS_REMATCH) rematch();
    else if (hit === FOCUS_MENU) returnToLobby();
    else {
      // Tap outside buttons — use current focus
      if (gameOver.focused === FOCUS_REMATCH) rematch();
      else returnToLobby();
    }
  }

  function returnToLobby(): void {
    rs.scoreDeltaOnDone = null;
    camera.unzoom();
    rs.mouseJoinedSlot = -1;
    rs.directTouchActive = false;
    floatingActions?.update(false, 0, 0, false, false);
    dpad?.update(null); // disable d-pad + rotate
    quitButton?.update(null); // hide quit
    homeZoomButton?.update(false); // disable zoom buttons
    enemyZoomButton?.update(false);
    loupeHandle?.update(false, 0, 0, getSceneCanvas()); // hide loupe before lobby takes over rendering
    config.showLobby();
  }

  function endGame(winner: { id: number } | null) {
    rs.scoreDeltaOnDone = null;
    camera.unzoom();
    config.onEndGame?.(winner, rs.state);
    const name = winner
      ? (PLAYER_NAMES[winner.id] ?? `Player ${winner.id + 1}`)
      : "Nobody";
    rs.frame.gameOver = {
      winner: name,
      scores: rs.state.players.map((p) => ({
        name: PLAYER_NAMES[p.id] ?? `P${p.id + 1}`,
        score: p.score,
        color: getPlayerColor(p.id).wall,
        eliminated: p.eliminated,
        territory: p.interior.size,
        stats: rs.gameStats[p.id],
      })),
      focused: FOCUS_REMATCH,
    };
    render();
    rs.mode = Mode.STOPPED;
  }

  // -------------------------------------------------------------------------
  // Life-lost sub-system (delegated to runtime-life-lost.ts)
  // -------------------------------------------------------------------------

  const lifeLost: LifeLostSystem = createLifeLostSystem({
    rs,
    send: config.send,
    log: config.log,
    render: () => render(),
    firstHuman,
    endGame,
    startReselection: () => selection.startReselection(),
    advanceToCannonPhase: () => selection.advanceToCannonPhase(),
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
    showLifeLostDialog: lifeLost.show,
    afterLifeLostResolved: () => lifeLost.afterResolved(),
    showScoreDeltas: (onDone) => selection.showBuildScoreDeltas(onDone),
    snapshotTerritory,
    onBeginBattle: IS_TOUCH_DEVICE ? aimAtEnemyCastle : undefined,
  });

  // -------------------------------------------------------------------------
  // resetUIState
  // -------------------------------------------------------------------------

  function resetUIState(): void {
    rs.reselectQueue = [];
    rs.reselectionPids = [];
    rs.battleAnim = createBattleAnimState();
    rs.accum = createTimerAccums();
    rs.banner = createBannerState();
    rs.lifeLostDialog = null;
    rs.paused = false;
    rs.quitPending = false;
    rs.optionsReturnMode = null;
    rs.castleBuilds = [];
    rs.castleBuildOnDone = null;
    rs.selectionStates.clear();
    rs.scoreDeltas = [];
    rs.scoreDeltaTimer = 0;
    rs.scoreDeltaOnDone = null;
    rs.directTouchActive = false;
    rs.preScores = [];
    resetGameStats();
    camera.resetCamera();
  }

  // -------------------------------------------------------------------------
  // startGame
  // -------------------------------------------------------------------------

  function startGame() {
    const seed = rs.lobby.seed;

    const diffParams = DIFFICULTY_PARAMS[rs.settings.difficulty] ?? DIFFICULTY_PARAMS[1]!;
    const { buildTimer, cannonPlaceTimer, firstRoundCannons } = diffParams;
    const roundsParam = typeof location !== "undefined" ? Number(new URL(location.href).searchParams.get("rounds")) : 0;
    const roundsVal = roundsParam > 0 ? roundsParam : (ROUNDS_OPTIONS[rs.settings.rounds] ?? ROUNDS_OPTIONS[0]!).value;

    bootstrapGame({
      seed,
      maxPlayers: Math.min(MAX_PLAYERS, PLAYER_KEY_BINDINGS.length),
      battleLength: roundsVal,
      cannonMaxHp: (CANNON_HP_OPTIONS[rs.settings.cannonHp] ?? CANNON_HP_OPTIONS[0]!).value,
      buildTimer,
      cannonPlaceTimer,
      log: config.log,
      resetFrame,
      setState: (s: GameState) => {
        s.firstRoundCannons = firstRoundCannons;
        rs.state = s;
      },
      setControllers: (c: PlayerController[]) => { rs.controllers = c; },
      resetUIState,
      createControllerForSlot: (i: number, gameState: GameState) => {
        const isAi = !rs.lobby.joined[i];
        const strategySeed = isAi ? gameState.rng.int(0, MAX_UINT32) : undefined;
        return createController(i, isAi, rs.settings.keyBindings[i]!, strategySeed, rs.settings.difficulty);
      },
      enterSelection: () => selection.enter(),
    });
  }

  // -------------------------------------------------------------------------
  // UIContext — bridges internal state to game-ui-screens.ts functions
  // -------------------------------------------------------------------------

  const uiCtx: UIContext = {
    canvas,
    getState: () => rs.state,
    getOverlay: () => rs.overlay,
    settings: rs.settings,
    getMode: () => rs.mode,
    setMode: (m) => { rs.mode = m; },
    getPaused: () => rs.paused,
    setPaused: (v) => { rs.paused = v; },
    optionsCursor: {
      get value() { return rs.optionsCursor; },
      set value(v) { rs.optionsCursor = v; },
    },
    controlsState: rs.controlsState,
    getOptionsReturnMode: () => rs.optionsReturnMode,
    setOptionsReturnMode: (m) => { rs.optionsReturnMode = m; },
    lobby: rs.lobby,
    getFrame: () => rs.frame,
    getLobbyRemaining: () => config.getLobbyRemaining(),
    isOnline: !!config.isOnline,
  };

  // -------------------------------------------------------------------------
  // Input handlers registration
  // -------------------------------------------------------------------------

  function registerInputHandlers(): void {
    const inputDeps: RegisterOnlineInputDeps = {
      canvas,
      getState: () => rs.state,
      getMode: () => rs.mode,
      setMode: (m) => { rs.mode = m as Mode; },
      modeValues: {
        LOBBY: Mode.LOBBY, OPTIONS: Mode.OPTIONS, CONTROLS: Mode.CONTROLS,
        SELECTION: Mode.SELECTION, BANNER: Mode.BANNER, BALLOON_ANIM: Mode.BALLOON_ANIM,
        CASTLE_BUILD: Mode.CASTLE_BUILD, LIFE_LOST: Mode.LIFE_LOST,
        GAME: Mode.GAME, STOPPED: Mode.STOPPED,
      },
      isLobbyActive: () => rs.lobby.active,
      lobbyKeyJoin,
      lobbyClick,
      showLobby: returnToLobby,
      rematch,
      getGameOverFocused: () => rs.frame.gameOver?.focused ?? FOCUS_REMATCH,
      setGameOverFocused: (f) => { if (rs.frame.gameOver) { rs.frame.gameOver.focused = f; render(); } },
      gameOverClick,
      showOptions,
      closeOptions,
      showControls,
      closeControls,
      getOptionsCursor: () => rs.optionsCursor,
      setOptionsCursor: (c) => { rs.optionsCursor = c; },
      getOptionsCount: () => visibleOptionsForCtx().length,
      getRealOptionIdx: realOptionIdx,
      getOptionsReturnMode: () => rs.optionsReturnMode,
      setOptionsReturnMode: (m) => { rs.optionsReturnMode = m as Mode | null; },
      changeOption,
      getControlsState: () => rs.controlsState,
      getLifeLostDialog: () => rs.lifeLostDialog,
      lifeLostDialogClick: lifeLost.click,
      getControllers: () => rs.controllers,
      isHuman,
      withFirstHuman,
      pixelToTile,
      screenToWorld,
      onPinchStart,
      onPinchUpdate,
      onPinchEnd,
      maybeSendAimUpdate: config.maybeSendAimUpdate ?? (() => {}),
      tryPlaceCannonAndSend: config.tryPlaceCannonAndSend ?? ((ctrl, gs, max) => ctrl.tryPlaceCannon(gs, max)),
      tryPlacePieceAndSend: config.tryPlacePieceAndSend ?? ((ctrl, gs) => ctrl.tryPlacePiece(gs)),
      fireAndSend: config.fireAndSend ?? ((ctrl, gameState) => ctrl.fire(gameState)),
      getSelectionStates: () => rs.selectionStates,
      highlightTowerForPlayer: selection.highlight,
      confirmSelectionForPlayer: selection.confirm,
      isSelectionReady,
      togglePause,
      getQuitPending: () => rs.quitPending,
      setQuitPending: (v) => { rs.quitPending = v; },
      setQuitTimer: (s) => { rs.quitTimer = s; },
      setQuitMessage: (msg) => { rs.quitMessage = msg; },
      sendLifeLostChoice: lifeLost.sendLifeLostChoice,
      setDirectTouchActive: (v) => { rs.directTouchActive = v; },
      isDirectTouchActive: () => rs.directTouchActive,
      settings: rs.settings,
      isOnline: config.isOnline,
    };
    registerOnlineInputHandlers(inputDeps);
    registerTouchHandlers({ ...inputDeps, lobbyKeyJoin: undefined });

    // Touch controls: wire static DOM elements from index.html
    if (IS_TOUCH_DEVICE) {
      gameContainer.classList.add("has-touch-panels");
      const placePiece = inputDeps.tryPlacePieceAndSend;
      const placeCannon = inputDeps.tryPlaceCannonAndSend;
      dpad = createDpad({
        getState: () => rs.state,
        getMode: () => rs.mode,
        modeValues: { GAME: Mode.GAME, SELECTION: Mode.SELECTION, LOBBY: Mode.LOBBY },
        withFirstHuman,
        tryPlacePieceAndSend: placePiece,
        tryPlaceCannonAndSend: placeCannon,
        fireAndSend: inputDeps.fireAndSend,
        getSelectionStates: () => rs.selectionStates,
        highlightTowerForPlayer: selection.highlight,
        confirmSelectionForPlayer: selection.confirm,
        isHost: config.getIsHost,
        lobbyAction: () => lobbyKeyJoin(rs.settings.keyBindings[0]!.confirm),
        getLeftHanded: () => rs.settings.leftHanded,
        clearDirectTouch: () => { rs.directTouchActive = false; },
        isSelectionReady,
        options: {
          isActive: () => rs.mode === Mode.OPTIONS,
          navigate: (dir) => {
            const count = visibleOptionsForCtx().length;
            rs.optionsCursor = (rs.optionsCursor + dir + count) % count;
          },
          changeValue: (dir) => changeOption(dir),
          confirm: () => {
            if (realOptionIdx() === 5) showControls();
            else closeOptions();
          },
        },
        lifeLost: {
          isActive: () => rs.mode === Mode.LIFE_LOST && rs.lifeLostDialog !== null,
          toggleFocus: () => {
            const human = firstHuman();
            if (!human || !rs.lifeLostDialog) return;
            const entry = rs.lifeLostDialog.entries.find(
              (e) => e.playerId === human.playerId && e.choice === CHOICE_PENDING,
            );
            if (entry) entry.focused = entry.focused === 0 ? 1 : 0;
          },
          confirm: () => {
            const human = firstHuman();
            if (!human || !rs.lifeLostDialog) return;
            const entry = rs.lifeLostDialog.entries.find(
              (e) => e.playerId === human.playerId && e.choice === CHOICE_PENDING,
            );
            if (!entry) return;
            entry.choice = entry.focused === 0 ? CHOICE_CONTINUE : CHOICE_ABANDON;
            lifeLost.sendLifeLostChoice(entry.choice, entry.playerId);
          },
        },
        gameOver: {
          isActive: () => rs.mode === Mode.STOPPED && rs.frame.gameOver !== undefined,
          toggleFocus: () => {
            if (!rs.frame.gameOver) return;
            rs.frame.gameOver.focused = rs.frame.gameOver.focused === FOCUS_REMATCH ? FOCUS_MENU : FOCUS_REMATCH;
            render();
          },
          confirm: () => {
            if (!rs.frame.gameOver) return;
            if (rs.frame.gameOver.focused === FOCUS_REMATCH) rematch();
            else returnToLobby();
          },
        },
      }, gameContainer);
      dpad.update(null); // initial state: d-pad + rotate disabled
      const zoomDeps = {
        getState: () => rs.state,
        getCameraZone: camera.getCameraZone,
        setCameraZone: camera.setCameraZone,
        myPlayerId,
        getEnemyZones,
      };
      loupeHandle = createLoupe(gameContainer);
      quitButton = createQuitButton({
        getQuitPending: () => rs.quitPending,
        setQuitPending: (v: boolean) => { rs.quitPending = v; },
        setQuitTimer: (v: number) => { rs.quitTimer = v; },
        setQuitMessage: (msg: string) => { rs.quitMessage = msg; },
        showLobby: returnToLobby,
        getControllers: () => rs.controllers,
        isHuman,
      }, gameContainer);
      quitButton.update(null); // initial state: hidden
      homeZoomButton = createHomeZoomButton(zoomDeps, gameContainer);
      enemyZoomButton = createEnemyZoomButton(zoomDeps, gameContainer);
      homeZoomButton.update(false); // initial state: disabled
      enemyZoomButton.update(false);
      camera.enableMobileZoom();

      // Floating contextual buttons for direct-touch placement
      const floatingEl = gameContainer.querySelector<HTMLElement>("#floating-actions");
      if (floatingEl) {
        floatingActions = createFloatingActions({
          getState: () => rs.state,
          withFirstHuman,
          tryPlacePieceAndSend: inputDeps.tryPlacePieceAndSend,
          tryPlaceCannonAndSend: inputDeps.tryPlaceCannonAndSend,
          onDrag: (clientX, clientY) => {
            const state = rs.state;
            if (!state) return;
            const { x, y } = clientToCanvas(clientX, clientY, canvas);
            dispatchPointerMove(x, y, state, inputDeps);
          },
        }, floatingEl);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Return the runtime object
  // -------------------------------------------------------------------------

  return {
    rs,

    // Functions
    mainLoop,
    resetFrame,
    clampedFrameDt,

    renderLobby,
    tickLobby,
    lobbyKeyJoin,
    lobbyClick,

    changeOption,
    renderOptions,
    showOptions,
    closeOptions,

    renderControls,
    showControls,
    closeControls,
    togglePause,

    showBanner,
    tickBanner,

    collectCrosshairs: phaseTicks.collectCrosshairs,
    snapshotTerritory,
    firstHuman,
    withFirstHuman,

    render,
    endGame,
    aimAtEnemyCastle,

    startCannonPhase: phaseTicks.startCannonPhase,
    startBattle: phaseTicks.startBattle,
    tickBalloonAnim: phaseTicks.tickBalloonAnim,
    beginBattle: phaseTicks.beginBattle,
    startBuildPhase: phaseTicks.startBuildPhase,

    tickCannonPhase: phaseTicks.tickCannonPhase,
    tickBattleCountdown: phaseTicks.tickBattleCountdown,
    tickBattlePhase: phaseTicks.tickBattlePhase,
    tickBuildPhase: phaseTicks.tickBuildPhase,

    tickGame: phaseTicks.tickGame,
    resetUIState,
    startGame,

    uiCtx,
    registerInputHandlers,

    // Sub-systems
    selection,
    lifeLost,
  };
}
