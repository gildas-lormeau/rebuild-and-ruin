/**
 * Shared game runtime factory — consolidates all orchestration code
 * from main.ts (local) and online-client.ts (online).
 *
 * createGameRuntime(config) returns a RuntimeState bag (rs) plus
 * methods that operate on it. See runtime-state.ts for the state type.
 */

import { createController, isHuman } from "./controller-factory.ts";
import { bootstrapGame } from "./game-bootstrap.ts";
import type { GameRuntime, RuntimeConfig } from "./game-runtime-types.ts";
import {
  lobbyClickHitTest,
  mainLoopTick,
  snapshotTerritory as snapshotTerritoryImpl,
} from "./game-ui-runtime.ts";
import type { UIContext } from "./game-ui-screens.ts";
import {
  closeControls as closeControlsShared,
  closeOptions as closeOptionsShared,
  lobbyKeyJoin as lobbyKeyJoinShared,
  lobbySkipStep,
  renderControls as renderControlsShared,
  renderLobby as renderLobbyShared,
  renderOptions as renderOptionsShared,
  showControls as showControlsShared,
  showOptions as showOptionsShared,
  tickLobby as tickLobbyShared,
  togglePause as togglePauseShared,
  visibleOptions,
} from "./game-ui-screens.ts";
import {
  CANNON_HP_OPTIONS,
  createBattleAnimState,
  createTimerAccums,
  cycleOption,
  DIFFICULTY_PARAMS,
  FOCUS_REMATCH,
  Mode,
  ROUNDS_OPTIONS,
  SEED_CUSTOM,
} from "./game-ui-types.ts";
import { GRID_COLS, GRID_ROWS, SCALE, TILE_SIZE } from "./grid.ts";
import { hapticPhaseChange, setHapticsLevel } from "./haptics.ts";
import { type RegisterOnlineInputDeps, registerOnlineInputHandlers } from "./input.ts";
import { createLoupe, type LoupeHandle } from "./loupe.ts";
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
import { computeLobbyLayout } from "./render-ui.ts";
import { MAX_UINT32 } from "./rng.ts";
import { createCameraSystem } from "./runtime-camera.ts";
import type { LifeLostSystem } from "./runtime-life-lost.ts";
import { createLifeLostSystem } from "./runtime-life-lost.ts";
import type { PhaseTicksSystem } from "./runtime-phase-ticks.ts";
import { createPhaseTicksSystem } from "./runtime-phase-ticks.ts";
import type { SelectionSystem } from "./runtime-selection.ts";
import { createSelectionSystem } from "./runtime-selection.ts";
import { createRuntimeState } from "./runtime-state.ts";
import { unpackTile } from "./spatial.ts";
import { registerTouchHandlers } from "./touch-input.ts";
import { createDpad, createEnemyZoomButton, createHomeZoomButton, createQuitButton, createTouchPanels } from "./touch-ui.ts";
import type { GameState } from "./types.ts";
import {
  BANNER_DURATION,
  MAX_FRAME_DT,
  Phase,
  SCORE_DELTA_DISPLAY_TIME,
} from "./types.ts";

export type { GameRuntime } from "./game-runtime-types.ts";

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

  function renderLobby(): void {
    renderLobbyShared(uiCtx);
  }

  function tickLobby(dt: number): void {
    rs.lobby.timerAccum = (rs.lobby.timerAccum ?? 0) + dt;
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
      isSlotJoined: (i) => rs.lobby.joined[i]!,
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
    );
    setHapticsLevel(rs.settings.haptics);
    dpad?.setLeftHanded(rs.settings.leftHanded);
  }

  function renderOptions(): void {
    renderOptionsShared(uiCtx);
  }

  function showOptions(): void {
    showOptionsShared(uiCtx, { OPTIONS: Mode.OPTIONS });
  }

  function closeOptions(): void {
    const wasInGame = rs.optionsReturnMode !== null;
    closeOptionsShared(uiCtx, { LOBBY: Mode.LOBBY, GAME: Mode.GAME });
    if (wasInGame) {
      rs.lastTime = performance.now(); // avoid huge dt on first frame back
    }
    config.onCloseOptions?.();
  }

  // -------------------------------------------------------------------------
  // Controls screen
  // -------------------------------------------------------------------------

  function renderControls(): void {
    renderControlsShared(uiCtx);
  }

  function showControls(): void {
    showControlsShared(uiCtx, { CONTROLS: Mode.CONTROLS });
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
    getMode: () => rs.mode,
    getQuitPending: () => rs.quitPending,
    hasLifeLostDialog: () => rs.lifeLostDialog !== null,
    getPaused: () => rs.paused,
    getFrameDt: () => rs.frameDt,
    setFrameAnnouncement: (text) => { rs.frame.announcement = text; },
    getMyPlayerId: () => config.getMyPlayerId(),
    getFirstHumanPlayerId: () => firstHuman()?.playerId ?? -1,
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
    getIsHost: config.getIsHost,
    getMyPlayerId: config.getMyPlayerId,
    getRemoteHumanSlots: config.getRemoteHumanSlots,
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
        (phase === Phase.WALL_BUILD || phase === Phase.CANNON_PLACE || phase === Phase.BATTLE);
      const human = firstHuman();
      let wx = 0;
      let wy = 0;
      if (human && phase === Phase.BATTLE) {
        const ch = human.getCrosshair();
        wx = ch.x;
        wy = ch.y;
      } else if (human) {
        const cursor = phase === Phase.WALL_BUILD ? human.buildCursor : human.cannonCursor;
        wx = (cursor.col + 0.5) * TILE_SIZE;
        wy = (cursor.row + 0.5) * TILE_SIZE;
      }
      loupeHandle.update(loupeVisible && human !== null, wx, wy, getSceneCanvas());
    }

    const hasHuman = firstHuman() !== null;
    const inGame = rs.mode === Mode.GAME || rs.mode === Mode.SELECTION;
    dpad?.update(hasHuman && inGame ? rs.state.phase : null);
    homeZoomButton?.update();
    enemyZoomButton?.update();
    const inLobby = rs.mode === Mode.LOBBY || rs.mode === Mode.OPTIONS || rs.mode === Mode.CONTROLS;
    quitButton?.update(!inLobby ? rs.state.phase : null);
  }

  function rematch() {
    camera.resetCamera();
    startGame();
    rs.mode = Mode.SELECTION;
  }

  function returnToLobby(): void {
    rs.scoreDeltaOnDone = null;
    camera.unzoom();
    rs.mouseJoinedSlot = -1;
    dpad?.update(null); // hide d-pad buttons, panels stay visible
    quitButton?.update(null);
    loupeHandle?.update(false, 0, 0, getSceneCanvas());
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
    getIsHost: config.getIsHost,
    getMyPlayerId: config.getMyPlayerId,
    getRemoteHumanSlots: config.getRemoteHumanSlots,
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
    getIsHost: config.getIsHost,
    getMyPlayerId: config.getMyPlayerId,
    getRemoteHumanSlots: config.getRemoteHumanSlots,
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
    rs.preScores = [];
  }

  // -------------------------------------------------------------------------
  // startGame
  // -------------------------------------------------------------------------

  function startGame() {
    const parsedSeed =
      rs.settings.seedMode === SEED_CUSTOM && rs.settings.seed
        ? parseInt(rs.settings.seed, 10)
        : undefined;
    const seed = parsedSeed !== undefined && !isNaN(parsedSeed)
      ? parsedSeed
      : Math.floor(Math.random() * 1000000);

    const diffParams = DIFFICULTY_PARAMS[rs.settings.difficulty] ?? DIFFICULTY_PARAMS[1]!;
    const { buildTimer, cannonPlaceTimer, firstRoundCannons } = diffParams;
    const roundsParam = typeof location !== "undefined" ? Number(new URL(location.href).searchParams.get("rounds")) : 0;
    const roundsVal = roundsParam > 0 ? roundsParam : (ROUNDS_OPTIONS[rs.settings.rounds] ?? ROUNDS_OPTIONS[0]!).value;

    resetGameStats();

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
    ctx2d: canvas.getContext("2d")!,
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
    render,
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
      togglePause,
      getQuitPending: () => rs.quitPending,
      setQuitPending: (v) => { rs.quitPending = v; },
      setQuitTimer: (s) => { rs.quitTimer = s; },
      setQuitMessage: (msg) => { rs.quitMessage = msg; },
      render,
      sendLifeLostChoice: lifeLost.sendLifeLostChoice,
      settings: rs.settings,
    };
    registerOnlineInputHandlers(inputDeps);
    registerTouchHandlers({ ...inputDeps, lobbyKeyJoin: undefined });

    // D-pad + action buttons (mobile only)
    if (IS_TOUCH_DEVICE) {
      const panels = createTouchPanels(gameContainer);
      const placePiece = inputDeps.tryPlacePieceAndSend;
      const placeCannon = inputDeps.tryPlaceCannonAndSend;
      dpad = createDpad({
        getState: () => rs.state,
        withFirstHuman,
        tryPlacePieceAndSend: placePiece,
        tryPlaceCannonAndSend: placeCannon,
        getSelectionStates: () => rs.selectionStates,
        highlightTowerForPlayer: selection.highlight,
        confirmSelectionForPlayer: selection.confirm,
        isHost: config.getIsHost,
        lobbyAction: () => lobbyKeyJoin(rs.settings.keyBindings[0]!.confirm),
        render,
        getLeftHanded: () => rs.settings.leftHanded,
      }, panels);
      dpad.update(null); // initial state: d-pad + rotate disabled
      const zoomDeps = {
        getState: () => rs.state,
        getCameraZone: camera.getCameraZone,
        setCameraZone: camera.setCameraZone,
        myPlayerId,
        getEnemyZones,
        render,
      };
      // Loupe at top-left, zoom buttons at top-right (above quit)
      loupeHandle = createLoupe(panels.leftTop);
      homeZoomButton = createHomeZoomButton(zoomDeps, panels.rightTop);
      enemyZoomButton = createEnemyZoomButton(zoomDeps, panels.rightTop);
      const quitDeps = {
        getQuitPending: () => rs.quitPending,
        setQuitPending: (v: boolean) => { rs.quitPending = v; },
        setQuitTimer: (v: number) => { rs.quitTimer = v; },
        setQuitMessage: (msg: string) => { rs.quitMessage = msg; },
        showLobby: returnToLobby,
        getControllers: () => rs.controllers,
        isHuman,
        render,
      };
      quitButton = createQuitButton(quitDeps, panels.rightTop);
      camera.enableMobileZoom();
    }
  }

  // Desktop fallback: standalone quit button (touch devices already have it in-panel)
  if (!quitButton) {
    quitButton = createQuitButton({
      getQuitPending: () => rs.quitPending,
      setQuitPending: (v) => { rs.quitPending = v; },
      setQuitTimer: (v) => { rs.quitTimer = v; },
      setQuitMessage: (msg) => { rs.quitMessage = msg; },
      showLobby: returnToLobby,
      getControllers: () => rs.controllers,
      isHuman,
      render,
    });
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
