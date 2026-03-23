/**
 * Shared game runtime factory — consolidates all orchestration code
 * from main.ts (local) and online-client.ts (online).
 *
 * createGameRuntime(config) returns a closure that owns all shared
 * mutable state and exposes getters/setters + functions for callers.
 */

import { GRID_COLS, GRID_ROWS } from "./grid.ts";
import { renderMap, TILE, SCALE } from "./map-renderer.ts";
import type { RenderOverlay, Viewport } from "./map-renderer.ts";
import {
  nextPhase,
  clearPlayerState,
  finalizeBuildPhase,
  markPlayerReselected,
  prepareCastleWalls,
  enterCannonPlacePhase,
  enterCastleReselectPhase,
  finalizeCastleRebuild,
  finalizeCastleConstruction,
  advanceToCannonPlacePhase,
  initBuildPhase,
  prepareReselectionPlans,
} from "./game-engine.ts";
import {
  Phase,
  BATTLE_TIMER,
  SELECT_TIMER,
  BATTLE_COUNTDOWN,
  BALLOON_FLIGHT_DURATION,
  IMPACT_FLASH_DURATION,
  BANNER_DURATION,
  MAX_FRAME_DT,
  WALL_BUILD_INTERVAL,
  LIFE_LOST_AI_DELAY,
  LIFE_LOST_MAX_TIMER,
} from "./types.ts";
import type { GameState } from "./types.ts";
import { updateCannonballs, resolveBalloons } from "./battle-system.ts";
import { tickGrunts, gruntAttackTowers } from "./grunt-system.ts";
import { createController, isHuman } from "./player-controller.ts";
import type { PlayerController, Crosshair } from "./player-controller.ts";
import { computeLobbyLayout } from "./render-ui.ts";
import {
  PLAYER_COLORS,
  PLAYER_KEY_BINDINGS,
  PLAYER_NAMES,
  MAX_PLAYERS,
} from "./player-config.ts";
import {
  Mode,
  loadSettings,
  createTimerAccums,
  createControlsState,
  createBattleAnimState,
  ROUNDS_OPTIONS,
  CANNON_HP_OPTIONS,
  cycleOption,
} from "./game-ui-types.ts";
import type {
  TimerAccums,
  GameSettings,
  ControlsState,
  FrameData,
  BattleAnimState,
  LobbyState,
} from "./game-ui-types.ts";
import {
  createBannerState,
  showBannerTransition,
  tickBannerTransition,
} from "./phase-banner.ts";
import { bootstrapGame, setupTowerSelection } from "./game-bootstrap.ts";
import type { BannerState } from "./phase-banner.ts";
import {
  buildOnlineOverlay,
  buildBannerUi,
  buildRenderSummaryMessage,
} from "./render-composition.ts";
import type { LifeLostDialogState } from "./life-lost.ts";
import {
  tickLifeLostDialogRuntime,
  resolveLifeLostDialogRuntime,
  handleLifeLostDialogClick as handleLifeLostDialogClickShared,
  lifeLostPanelPos as lifeLostPanelPosShared,
  buildLifeLostDialogState,
  resolveAfterLifeLost,
} from "./life-lost.ts";
import {
  allSelectionsConfirmed as allSelectionsConfirmedImpl,
  initTowerSelection as initTowerSelectionImpl,
  syncSelectionOverlay as syncSelectionOverlayImpl,
  highlightTowerSelection,
  confirmTowerSelection,
  tickSelectionPhase,
  finishSelectionPhase,
} from "./selection.ts";
import type { SelectionState } from "./selection.ts";
import {
  tickHostCannonPhase,
  tickHostBuildPhase,
} from "./phase-ticks.ts";
import { IS_TOUCH_DEVICE } from "./platform.ts";
import type { WorldPos } from "./geometry-types.ts";
import type { SerializedPlayer } from "./online-serialize.ts";
import type { CannonPhantom, PiecePhantom } from "./online-types.ts";
import {
  startHostBattleLifecycle,
  tickHostBalloonAnim,
  tickHostBattleCountdown,
  tickHostBattlePhase,
  beginHostBattle,
} from "./battle-ticks.ts";
import { registerOnlineInputHandlers, type RegisterOnlineInputDeps } from "./input.ts";
import { registerTouchHandlers } from "./touch-input.ts";
import { createRotateButton, createHomeZoomButton, createEnemyZoomButton, createQuitButton } from "./touch-ui.ts";
import { hapticBattleEvents, hapticPhaseChange, setHapticsLevel } from "./haptics.ts";
import {
  snapshotTerritory as snapshotTerritoryImpl,
  lobbyClickHitTest,
  initCannonPhase,
  collectLocalCrosshairs,
  tickGameCore,
  processReselectionQueue,
  completeReselection,
  mainLoopTick,
  GEAR_X,
  GEAR_Y,
  GEAR_SIZE,
} from "./game-ui-runtime.ts";
import {
  renderOptions as renderOptionsShared,
  showOptions as showOptionsShared,
  closeOptions as closeOptionsShared,
  renderControls as renderControlsShared,
  showControls as showControlsShared,
  closeControls as closeControlsShared,
  togglePause as togglePauseShared,
  renderLobby as renderLobbyShared,
  tickLobby as tickLobbyShared,
  lobbyKeyJoin as lobbyKeyJoinShared,
  visibleOptions,
} from "./game-ui-screens.ts";
import type { UIContext } from "./game-ui-screens.ts";
import {
  createCastleBuildState,
  tickCastleBuildAnimation,
} from "./castle-build.ts";
import type { CastleBuildState } from "./castle-build.ts";
import type { WatcherTimingState } from "./online-watcher-battle.ts";
import type { BalloonFlight } from "./battle-system.ts";

// ---------------------------------------------------------------------------
// RuntimeConfig
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  canvas: HTMLCanvasElement;
  /** true for online mode. */
  isOnline?: boolean;
  /** noop for local, ws.send for online. */
  send: (msg: any) => void;
  /** () => true for local. */
  getIsHost: () => boolean;
  /** () => -1 for local. */
  getMyPlayerId: () => number;
  /** () => emptySet for local. */
  getRemoteHumanSlots: () => Set<number>;
  /** noop for local. */
  log: (msg: string) => void;
  /** noop for local. */
  logThrottled: (key: string, msg: string) => void;
  /** Different formula per mode. */
  getLobbyRemaining: () => number;
  /** Each mode provides its own. */
  showLobby: () => void;
  /** local: set joined; online: send select_slot. */
  onLobbySlotJoined: (pid: number) => void;
  /** Optional extra action on close (e.g., reset timer). */
  onCloseOptions?: () => void;
  /** local: startGame; online: host sends init. */
  onTickLobbyExpired: () => void;

  // -----------------------------------------------------------------------
  // Optional networking deps for tick functions (online-host-phases, etc.)
  // -----------------------------------------------------------------------

  /** Called after local crosshairs are collected; returns extended list (e.g., adds remote human crosshairs). */
  extendCrosshairs?: (crosshairs: Crosshair[], dt: number) => Crosshair[];
  /** Called per controller during crosshair collection (e.g., sends aim_update to watchers). */
  onLocalCrosshairCollected?: (ctrl: PlayerController, ch: { x: number; y: number }, readyCannon: boolean) => void;
  /** Optional non-host tick handler (watcher logic). */
  tickNonHost?: (dt: number) => void;
  /** Host-only networking state for tick functions (phantom merging, checkpoints, auto-placement). */
  hostNetworking?: {
    autoPlaceCannons: (player: GameState["players"][number], max: number, state: GameState) => void;
    serializePlayers: (state: GameState) => SerializedPlayer[];
    buildCannonStartMessage: (state: GameState) => any;
    buildBattleStartMessage: (state: GameState, flights: BalloonFlight[]) => any;
    buildBuildStartMessage: (state: GameState) => any;
    remoteCannonPhantoms: () => CannonPhantom[];
    remotePiecePhantoms: () => PiecePhantom[];
    lastSentCannonPhantom: () => Map<number, string>;
    lastSentPiecePhantom: () => Map<number, string>;
  };
  /** Watcher timing state (for non-host battle). */
  watcherTiming?: WatcherTimingState;
  /** Send aim_update for mouse movement. */
  maybeSendAimUpdate?: (x: number, y: number) => void;
  /** Try to place cannon and send to server. */
  tryPlaceCannonAndSend?: (ctrl: PlayerController, gameState: GameState, max: number) => boolean;
  /** Try to place piece and send to server. */
  tryPlacePieceAndSend?: (ctrl: PlayerController, gameState: GameState) => boolean;
  /** Fire and send to server. */
  fireAndSend?: (ctrl: PlayerController, gameState: GameState) => void;
  /** Room code for lobby overlay. */
  roomCode?: string;
  /** Optional hook called when a game ends (before frame payload is set). */
  onEndGame?: (winner: { id: number } | null, state: GameState) => void;
}

// ---------------------------------------------------------------------------
// GameRuntime return type
// ---------------------------------------------------------------------------

export interface GameRuntime {
  // --- State getters ---
  getState: () => GameState;
  setState: (s: GameState) => void;
  getOverlay: () => RenderOverlay;
  getControllers: () => PlayerController[];
  setControllers: (c: PlayerController[]) => void;
  getAccum: () => TimerAccums;
  setAccum: (a: TimerAccums) => void;
  getSelectionStates: () => Map<number, SelectionState>;
  getBattleAnim: () => BattleAnimState;
  setBattleAnim: (b: BattleAnimState) => void;
  getFrame: () => FrameData;
  getLifeLostDialog: () => LifeLostDialogState | null;
  setLifeLostDialog: (d: LifeLostDialogState | null) => void;
  getCastleBuild: () => CastleBuildState | null;
  setCastleBuild: (c: CastleBuildState | null) => void;
  getReselectQueue: () => number[];
  setReselectQueue: (q: number[]) => void;
  getReselectionPids: () => number[];
  setReselectionPids: (p: number[]) => void;
  getMode: () => Mode;
  setMode: (m: Mode) => void;
  getSettings: () => GameSettings;
  getPaused: () => boolean;
  setPaused: (v: boolean) => void;
  getQuitPending: () => boolean;
  setQuitPending: (v: boolean) => void;
  getQuitTimer: () => number;
  setQuitTimer: (v: number) => void;
  getOptionsReturnMode: () => Mode | null;
  setOptionsReturnMode: (m: Mode | null) => void;
  getOptionsCursor: () => number;
  setOptionsCursor: (v: number) => void;
  getControlsState: () => ControlsState;
  getLobby: () => LobbyState;
  getBanner: () => BannerState;
  setBanner: (b: BannerState) => void;
  getLastTime: () => number;
  setLastTime: (t: number) => void;

  // --- Functions ---
  mainLoop: (now: number) => void;
  resetFrame: () => void;
  clampedFrameDt: (now: number) => number;

  renderLobby: () => void;
  tickLobby: (dt: number) => void;
  lobbyKeyJoin: (key: string) => boolean;
  lobbyClick: (canvasX: number, canvasY: number) => boolean;

  changeOption: (dir: number) => void;
  renderOptions: () => void;
  showOptions: () => void;
  closeOptions: () => void;

  renderControls: () => void;
  showControls: () => void;
  closeControls: () => void;
  togglePause: () => boolean;

  showBanner: (text: string, onDone: () => void, reveal?: boolean, newBattle?: { territory: Set<number>[]; walls: Set<number>[] }) => void;
  tickBanner: (dt: number) => void;

  initTowerSelection: (pid: number, zone: number) => void;
  enterTowerSelection: () => void;
  syncSelectionOverlay: () => void;
  highlightTowerForPlayer: (idx: number, zone: number, pid: number) => void;
  confirmSelectionForPlayer: (pid: number, isReselect?: boolean) => boolean;
  allSelectionsConfirmed: () => boolean;

  collectCrosshairs: (canFireNow: boolean, dt?: number) => void;
  snapshotTerritory: () => Set<number>[];
  firstHuman: () => PlayerController | null;
  withFirstHuman: (action: (human: PlayerController) => void) => void;

  render: () => void;
  endGame: (winner: { id: number } | null) => void;

  tickSelection: (dt: number) => void;
  finishSelection: () => void;
  animateCastleConstruction: (onDone: () => void) => void;
  advanceToCannonPhase: () => void;
  tickCastleBuild: (dt: number) => void;

  startReselection: () => void;
  finishReselection: () => void;
  animateReselectionCastles: (onDone: () => void) => void;

  startCannonPhase: () => void;
  startBattle: () => void;
  tickBalloonAnim: (dt: number) => void;
  beginBattle: () => void;
  startBuildPhase: () => void;

  tickCannonPhase: (dt: number) => boolean;
  tickBattleCountdown: (dt: number) => void;
  tickBattlePhase: (dt: number) => boolean;
  tickBuildPhase: (dt: number) => boolean;

  showLifeLostDialog: (needsReselect: number[], eliminated: number[]) => void;
  tickLifeLostDialog: (dt: number) => void;
  afterLifeLostResolved: (continuing?: number[]) => boolean;
  lifeLostPanelPos: (playerId: number) => { px: number; py: number };
  lifeLostDialogClick: (canvasX: number, canvasY: number) => void;

  tickGame: (dt: number) => void;
  resetUIState: () => void;
  startGame: () => void;

  uiCtx: UIContext;
  registerInputHandlers: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGameRuntime(config: RuntimeConfig): GameRuntime {
  const { canvas } = config;

  // -------------------------------------------------------------------------
  // Mutable state
  // -------------------------------------------------------------------------

  let state: GameState;
  let overlay: RenderOverlay = {
    selection: { highlighted: null, selected: null },
  };
  let controllers: PlayerController[] = [];
  let reselectQueue: number[] = [];
  let reselectionPids: number[] = [];
  let accum: TimerAccums = createTimerAccums();
  let lastTime = 0;
  let paused = false;
  let quitPending = false;
  let quitTimer = 0;
  let quitMessage = "";
  let optionsReturnMode: Mode | null = null;
  let mode: Mode = Mode.STOPPED;
  const settings: GameSettings = loadSettings();
  setHapticsLevel(settings.haptics);
  let optionsCursor = 0;
  const controlsState: ControlsState = createControlsState();
  let castleBuild: CastleBuildState | null = null;
  let rotateButton: ReturnType<typeof createRotateButton> | null = null;
  let homeZoomButton: ReturnType<typeof createHomeZoomButton> | null = null;
  let enemyZoomButton: ReturnType<typeof createEnemyZoomButton> | null = null;
  let quitButton: ReturnType<typeof createQuitButton> | null = null;
  /** null = full map, number = zone index to zoom into */
  let cameraZone: number | null = null;
  /** Remembered battle zoom — persists across build/battle transitions */
  let battleZoom: number | null = null;
  /** Track last phase for auto-zoom on phase change */
  let lastAutoZoomPhase: Phase | null = null;
  /** Auto-zoom only activates after player presses a zoom button */
  let zoomActivated = false;
  let lifeLostDialog: LifeLostDialogState | null = null;
  let frame: FrameData = { crosshairs: [], phantoms: {} };
  let battleAnim: BattleAnimState = createBattleAnimState();
  let banner: BannerState = createBannerState();
  /** Score deltas to show after build phase. Fades out after a few seconds. */
  let scoreDeltas: { playerId: number; delta: number; total: number }[] = [];
  let scoreDeltaTimer = 0;
  const SCORE_DELTA_DISPLAY_TIME = 4; // seconds after banner ends
  let preScores: number[] = [];
  /** Per-player battle stats accumulated during the game. */
  interface PlayerStats { wallsDestroyed: number; cannonsKilled: number; }
  let gameStats: PlayerStats[] = [];

  function resetGameStats() {
    gameStats = Array.from({ length: MAX_PLAYERS }, () => ({
      wallsDestroyed: 0, cannonsKilled: 0,
    }));
  }

  const selectionStates: Map<number, SelectionState> = new Map();

  const lobby: LobbyState = {
    joined: new Array(MAX_PLAYERS).fill(false),
    active: false,
    timerAccum: 0,
    map: null,
  };

  // -------------------------------------------------------------------------
  // Frame/timing helpers
  // -------------------------------------------------------------------------

  function resetFrame(): void {
    frame = { crosshairs: [], phantoms: {} };
  }

  function clampedFrameDt(now: number): number {
    const dt = Math.min((now - lastTime) / 1000, MAX_FRAME_DT);
    lastTime = now;
    return dt;
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  // @ts-ignore — import.meta.env is Vite-specific
  const DEV = import.meta.env?.DEV ?? (typeof location !== "undefined" && location?.hostname === "localhost");

  let frameDt = 1 / 60;

  function mainLoop(now: number): void {
    const dt = clampedFrameDt(now);
    frameDt = dt;
    resetFrame();

    // Expose mode + phase for E2E test automation (dev only)
    if (DEV && typeof window !== "undefined") {
      const w = window as unknown as Record<string, unknown>;
      w.__testMode = Mode[mode];
      w.__testPhase = state ? Phase[state.phase] : "";
      w.__testTimer = state ? state.timer : 0;
      const myPid = config.getMyPlayerId();
      if (state && myPid >= 0) {
        const enemies: { x: number; y: number }[] = [];
        for (const p of state.players) {
          if (p.id === myPid || p.eliminated) continue;
          for (const c of p.cannons) {
            if (c.hp > 0) enemies.push({ x: (c.col + 0.5) * TILE, y: (c.row + 0.5) * TILE });
          }
        }
        w.__testEnemyCannons = enemies;
        const targets: { x: number; y: number }[] = [...enemies];
        for (const p of state.players) {
          if (p.id === myPid || p.eliminated) continue;
          for (const key of p.walls) {
            const r = Math.floor(key / GRID_COLS), c = key % GRID_COLS;
            targets.push({ x: (c + 0.5) * TILE, y: (r + 0.5) * TILE });
          }
        }
        w.__testEnemyTargets = targets;
        const myCtrl = controllers[myPid];
        if (myCtrl) {
          const ch = myCtrl.getCrosshair();
          if (ch) w.__testCrosshair = { x: ch.x, y: ch.y };
        }
      }
    }

    const shouldContinue = mainLoopTick({
      dt,
      mode,
      paused,
      quitPending,
      quitTimer,
      quitMessage,
      frame,
      setQuitPending: (v: boolean) => { quitPending = v; },
      setQuitTimer: (v: number) => { quitTimer = v; },
      render,
      ticks: {
        [Mode.LOBBY]: tickLobby,
        [Mode.OPTIONS]: () => renderOptions(),
        [Mode.CONTROLS]: () => renderControls(),
        [Mode.SELECTION]: tickSelection,
        [Mode.BANNER]: tickBanner,
        [Mode.BALLOON_ANIM]: tickBalloonAnim,
        [Mode.CASTLE_BUILD]: tickCastleBuild,
        [Mode.LIFE_LOST]: tickLifeLostDialog,
        [Mode.GAME]: tickGame,
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
    lobby.timerAccum = (lobby.timerAccum ?? 0) + dt;
    tickLobbyShared(uiCtx, () => {
      config.onTickLobbyExpired();
    });
  }

  function lobbyKeyJoin(key: string): boolean {
    return lobbyKeyJoinShared(uiCtx, key, (pid) => {
      config.onLobbySlotJoined(pid);
      renderLobby();
    });
  }

  let mouseJoinedSlot = -1; // track which slot mouse/trackpad has joined

  function lobbyClick(canvasX: number, canvasY: number): boolean {
    if (!lobby.active) return false;
    const hit = lobbyClickHitTest({
      canvasX,
      canvasY,
      canvasW: GRID_COLS * TILE * SCALE,
      canvasH: GRID_ROWS * TILE * SCALE,
      tileSize: TILE,
      gearX: GEAR_X,
      gearY: GEAR_Y,
      gearSize: GEAR_SIZE,
      slotCount: MAX_PLAYERS,
      computeLayout: computeLobbyLayout,
      isSlotJoined: (i) => lobby.joined[i]!,
    });
    if (!hit) return false;
    if (hit.type === "gear") {
      showOptions();
      return true;
    }
    // Mouse/trackpad can only join one slot (keyboard can join additional slots)
    if (mouseJoinedSlot >= 0) return true;
    if (!lobby.joined[hit.slotId]) {
      mouseJoinedSlot = hit.slotId;
      config.onLobbySlotJoined(hit.slotId);
      renderLobby();
      // On touch devices in local mode, start immediately after joining
      if (IS_TOUCH_DEVICE && !config.isOnline) {
        lobby.active = false;
        config.onTickLobbyExpired();
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Options screen
  // -------------------------------------------------------------------------

  /** Map cursor row to real option index. */
  function realOptionIdx(): number {
    return visibleOptionsForCtx()[optionsCursor] ?? optionsCursor;
  }

  function visibleOptionsForCtx(): number[] {
    return visibleOptions(uiCtx);
  }

  function changeOption(dir: number): void {
    cycleOption(
      dir,
      realOptionIdx(),
      settings,
      optionsReturnMode,
      state ?? null,
    );
    setHapticsLevel(settings.haptics);
  }

  function renderOptions(): void {
    renderOptionsShared(uiCtx);
  }

  function showOptions(): void {
    showOptionsShared(uiCtx, { OPTIONS: Mode.OPTIONS });
  }

  function closeOptions(): void {
    const wasInGame = optionsReturnMode !== null;
    closeOptionsShared(uiCtx, { LOBBY: Mode.LOBBY, GAME: Mode.GAME });
    if (wasInGame) {
      lastTime = performance.now(); // avoid huge dt on first frame back
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
    if (optionsReturnMode !== null) {
      for (const ctrl of controllers) {
        const kb = settings.keyBindings[ctrl.playerId];
        if (kb) ctrl.updateBindings(kb);
      }
    }
    closeControlsShared(uiCtx, { OPTIONS: Mode.OPTIONS });
  }

  function togglePause(): boolean {
    return togglePauseShared(uiCtx, { GAME: Mode.GAME });
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
    cameraZone = null;
    if (banner.active) {
      config.log(`showBanner "${text}" while banner "${banner.text}" is still active`);
    }
    showBannerTransition({
      banner,
      state,
      battleAnim,
      text,
      subtitle,
      onDone,
      reveal,
      newBattle,
      setModeBanner: () => { mode = Mode.BANNER; },
    });
    hapticPhaseChange();
  }

  function tickBanner(dt: number) {
    tickBannerTransition(banner, dt, BANNER_DURATION, render);
  }

  // -------------------------------------------------------------------------
  // Tower selection helpers
  // -------------------------------------------------------------------------

  function initTowerSelection(pid: number, zone: number): void {
    initTowerSelectionImpl(state, selectionStates, pid, zone);
  }

  function enterTowerSelection(): void {
    setupTowerSelection({
      state,
      isHost: config.getIsHost(),
      myPlayerId: config.getMyPlayerId(),
      remoteHumanSlots: config.getRemoteHumanSlots(),
      controllers,
      selectionStates,
      initTowerSelection,
      syncSelectionOverlay,
      setOverlaySelection: () => { overlay = { selection: { highlighted: null, selected: null } }; },
      selectTimer: SELECT_TIMER,
      accum,
      enterCastleReselectPhase,
      now: () => performance.now(),
      setModeSelection: () => { mode = Mode.SELECTION; },
      setLastTime: (t) => { lastTime = t; },
      requestFrame: () => {
        // Only schedule if the loop isn't already running (e.g., online mode starting from DOM lobby)
        if (mode === Mode.STOPPED) requestAnimationFrame(mainLoop);
      },
      log: config.log,
    });
  }

  function syncSelectionOverlay(): void {
    syncSelectionOverlayImpl(overlay, selectionStates);
  }

  function highlightTowerForPlayer(idx: number, zone: number, pid: number): void {
    highlightTowerSelection(
      state,
      selectionStates,
      idx,
      zone,
      pid,
      config.send,
      () => syncSelectionOverlay(),
      () => render(),
    );
  }

  function confirmSelectionForPlayer(pid: number, isReselect = false): boolean {
    return confirmTowerSelection(
      state,
      selectionStates,
      controllers,
      pid,
      isReselect,
      config.send,
      (reselectPid) => {
        markPlayerReselected(state, reselectPid);
        reselectionPids.push(reselectPid);
      },
      () => syncSelectionOverlay(),
      () => render(),
    );
  }

  function allSelectionsConfirmed(): boolean {
    return allSelectionsConfirmedImpl(selectionStates);
  }

  // -------------------------------------------------------------------------
  // Crosshairs / territory / human helpers
  // -------------------------------------------------------------------------

  function collectCrosshairs(canFireNow: boolean, dt = 0): void {
    const remoteHumanSlots = config.getRemoteHumanSlots();
    frame.crosshairs = collectLocalCrosshairs({
      state,
      controllers,
      canFireNow,
      skipController: (pid) => remoteHumanSlots.has(pid),
      onCrosshairCollected: config.onLocalCrosshairCollected,
    });
    // Let caller extend crosshairs (e.g., add remote human crosshairs)
    if (config.extendCrosshairs) {
      frame.crosshairs = config.extendCrosshairs(frame.crosshairs, dt);
    }
  }

  function snapshotTerritory(): Set<number>[] {
    return snapshotTerritoryImpl(state.players);
  }

  function firstHuman(): PlayerController | null {
    // Prefer the player who joined via mouse/trackpad
    if (mouseJoinedSlot >= 0) {
      const ctrl = controllers.find(c => c.playerId === mouseJoinedSlot);
      if (ctrl && isHuman(ctrl) && !state.players[ctrl.playerId]?.eliminated) return ctrl;
    }
    for (const ctrl of controllers) {
      if (isHuman(ctrl) && !state.players[ctrl.playerId]?.eliminated) return ctrl;
    }
    return null;
  }

  function withFirstHuman(action: (human: PlayerController) => void): void {
    const human = firstHuman();
    if (!human) return;
    action(human);
  }

  // -------------------------------------------------------------------------
  // Camera / zoom
  // -------------------------------------------------------------------------

  /** Compute bounding rect for a player's territory in tile-pixel space.
   *  Adapts to actual structures (walls, interior, cannons, towers). */
  let cachedZoneBounds: Map<number, { vp: Viewport; wallCount: number }> = new Map();

  function computeZoneBounds(zoneId: number): Viewport {
    const pid = state.playerZones.indexOf(zoneId);
    const player = pid >= 0 ? state.players[pid] : undefined;

    // Use cache if wall count unchanged (works in all phases including build)
    const cached = cachedZoneBounds.get(zoneId);
    if (cached && cached.wallCount === (player?.walls.size ?? 0)) return cached.vp;

    let minR = GRID_ROWS, maxR = 0, minC = GRID_COLS, maxC = 0;

    function expand(r: number, c: number) {
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }

    if (player && player.walls.size > 0) {
      // Bounding box of all walls (enclosed or not) — adapts in real-time during build
      for (const key of player.walls) expand(Math.floor(key / GRID_COLS), key % GRID_COLS);
      if (player.homeTower) expand(player.homeTower.row, player.homeTower.col);
    } else {
      // Fallback: use zone tiles (e.g. during castle select before walls exist)
      const zones = state.map.zones;
      for (let r = 0; r < GRID_ROWS; r++) {
        for (let c = 0; c < GRID_COLS; c++) {
          if (zones[r]![c] === zoneId) expand(r, c);
        }
      }
    }

    // 4-tile padding so player can place pieces to extend walls
    const pad = player && player.walls.size > 0 ? 4 : 1;
    minR = Math.max(0, minR - pad);
    maxR = Math.min(GRID_ROWS - 1, maxR + pad);
    minC = Math.max(0, minC - pad);
    maxC = Math.min(GRID_COLS - 1, maxC + pad);

    // Pad to match map aspect ratio to prevent stretching, cap to avoid full-map viewport
    const fullW = GRID_COLS * TILE;
    const fullH = GRID_ROWS * TILE;
    const maxW = fullW * MAX_ZOOM_VIEWPORT_RATIO;
    const maxH = fullH * MAX_ZOOM_VIEWPORT_RATIO;
    const targetAspect = GRID_COLS / GRID_ROWS;
    const w = (maxC - minC + 1) * TILE;
    const h = (maxR - minR + 1) * TILE;
    const vpAspect = w / h;
    // Expand the smaller dimension to match map aspect ratio, cap at MAX_ZOOM_VIEWPORT_RATIO
    const newW = vpAspect < targetAspect
      ? Math.min(maxW, h * targetAspect)
      : Math.min(maxW, (Math.min(maxH, w / targetAspect)) * targetAspect);
    const newH = newW / targetAspect;
    const cx = (minC + maxC + 1) * TILE / 2;
    const cy = (minR + maxR + 1) * TILE / 2;
    const x = Math.max(0, Math.min(fullW - newW, cx - newW / 2));
    const y = Math.max(0, Math.min(fullH - newH, cy - newH / 2));
    const result: Viewport = { x, y, w: newW, h: newH };
    cachedZoneBounds.set(zoneId, { vp: result, wallCount: player?.walls.size ?? 0 });
    return result;
  }

  /** Resolve the local player's id (online pid or first human fallback). */
  function myPlayerId(): number {
    const pid = config.getMyPlayerId();
    return pid >= 0 ? pid : (firstHuman()?.playerId ?? -1);
  }

  /** Get the zone of the player's own territory. */
  function getMyZone(): number | null {
    const pid = myPlayerId();
    if (pid < 0) return null;
    return state.playerZones[pid] ?? null;
  }

  /** Get the zone of the leading non-eliminated enemy. */
  function getBestEnemyZone(): number | null {
    const myPid = myPlayerId();
    let bestPid = -1, bestScore = -1;
    for (let i = 0; i < state.players.length; i++) {
      if (i === myPid || state.players[i]!.eliminated) continue;
      if (state.players[i]!.score > bestScore) {
        bestScore = state.players[i]!.score;
        bestPid = i;
      }
    }
    if (bestPid < 0) return null;
    return state.playerZones[bestPid] ?? null;
  }

  /** Auto-zoom on phase change (touch devices only). */
  function autoZoom(phase: Phase): void {
    if (phase === Phase.BATTLE) {
      // Battle: restore remembered zoom, or default to best enemy
      if (battleZoom !== null) {
        // Check the remembered enemy is still alive
        const pid = state.playerZones.indexOf(battleZoom);
        if (pid >= 0 && !state.players[pid]?.eliminated) {
          cameraZone = battleZoom;
        } else {
          battleZoom = getBestEnemyZone();
          cameraZone = battleZoom;
        }
      } else {
        battleZoom = getBestEnemyZone();
        cameraZone = battleZoom;
      }
    } else {
      // Select/Build/Cannon: zoom to home
      cameraZone = getMyZone();
    }
  }

  // Full map viewport (for lerping back to unzoomed)
  const fullMapVp: Viewport = { x: 0, y: 0, w: GRID_COLS * TILE, h: GRID_ROWS * TILE };
  /** Current interpolated viewport for smooth transitions. */
  let currentVp: Viewport = { ...fullMapVp };
  /** Last computed viewport (read-only snapshot for coordinate conversion). */
  let lastVp: Viewport | null = null;
  const ZOOM_LERP_SPEED = 6; // higher = faster transition
  /** Max fraction of map dimensions a zoom viewport can cover (prevents near-full-map zoom). */
  const MAX_ZOOM_VIEWPORT_RATIO = 0.85;

  /** Advance the viewport lerp (call once per frame from render). */
  function updateViewport(): Viewport | null {
    const targetZone = cameraZone;
    let target: Viewport;
    if (targetZone === null) {
      target = fullMapVp;
    } else {
      target = computeZoneBounds(targetZone);
    }

    // Lerp toward target
    const t = Math.min(1, ZOOM_LERP_SPEED * frameDt);
    currentVp.x += (target.x - currentVp.x) * t;
    currentVp.y += (target.y - currentVp.y) * t;
    currentVp.w += (target.w - currentVp.w) * t;
    currentVp.h += (target.h - currentVp.h) * t;

    // Snap if close enough to target (avoid infinite lerp)
    const dx = Math.abs(currentVp.x - target.x) + Math.abs(currentVp.y - target.y) +
               Math.abs(currentVp.w - target.w) + Math.abs(currentVp.h - target.h);
    if (dx < 0.5) {
      currentVp.x = target.x;
      currentVp.y = target.y;
      currentVp.w = target.w;
      currentVp.h = target.h;
    }

    // Return null if at full map (no zoom needed)
    if (currentVp.x === fullMapVp.x && currentVp.y === fullMapVp.y &&
        currentVp.w === fullMapVp.w && currentVp.h === fullMapVp.h) {
      lastVp = null;
    } else {
      lastVp = currentVp;
    }
    return lastVp;
  }

  /** Read-only: get current viewport for coordinate conversion (no side effects). */
  function getViewport(): Viewport | null {
    return lastVp;
  }

  /** Convert screen pixel (canvas coords) to world tile-pixel coords, accounting for zoom. */
  function screenToWorld(x: number, y: number): WorldPos {
    const vp = getViewport();
    const cw = GRID_COLS * TILE * SCALE;
    const ch = GRID_ROWS * TILE * SCALE;
    if (!vp) return { wx: x / SCALE, wy: y / SCALE };
    return {
      wx: vp.x + (x / cw) * vp.w,
      wy: vp.y + (y / ch) * vp.h,
    };
  }

  /** Convert screen pixel to tile, accounting for zoom viewport. */
  function pixelToTile(x: number, y: number): { row: number; col: number } {
    const { wx, wy } = screenToWorld(x, y);
    return {
      col: Math.max(0, Math.min(GRID_COLS - 1, Math.floor(wx / TILE))),
      row: Math.max(0, Math.min(GRID_ROWS - 1, Math.floor(wy / TILE))),
    };
  }



  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function render() {
    // Summary log: crosshairs, phantoms, impacts per frame (throttled 1/s)
    const chList = frame.crosshairs ?? [];
    const selH = overlay.selection?.highlights;
    config.logThrottled(
      "render-summary",
      buildRenderSummaryMessage({
        phaseName: Phase[state.phase],
        timer: state.timer,
        crosshairs: chList,
        aiPhantomsCount: frame.phantoms?.aiPhantoms?.length ?? 0,
        humanPhantomsCount: frame.phantoms?.humanPhantoms?.length ?? 0,
        aiCannonPhantomsCount: frame.phantoms?.aiCannonPhantoms?.length ?? 0,
        impactsCount: battleAnim.impacts.length,
        cannonballsCount: state.cannonballs.length,
        selectionHighlights: selH,
      }),
    );

    // Refresh crosshairs from controller state when paused
    if (state.phase === Phase.BATTLE && paused) {
      collectCrosshairs(state.battleCountdown <= 0);
    }

    const bannerUi = buildBannerUi(banner.active, banner.text, banner.progress, banner.subtitle);

    overlay = buildOnlineOverlay({
      previousSelection: overlay.selection,
      state,
      banner,
      battleAnim,
      frame,
      bannerUi,
      lifeLostDialog,
      playerNames: PLAYER_NAMES,
      playerColors: PLAYER_COLORS,
      lifeLostMaxTimer: LIFE_LOST_MAX_TIMER,
      getLifeLostPanelPos: (playerId) => lifeLostPanelPosShared(state, playerId),
    });

    // Status bar (rendered inside canvas)
    if (overlay.ui) {
      const phaseLabel = state.phase === Phase.CASTLE_SELECT ? "Select"
        : state.phase === Phase.WALL_BUILD ? "Build"
        : state.phase === Phase.CANNON_PLACE ? "Cannons"
        : state.phase === Phase.BATTLE ? "Battle" : "";
      overlay.ui.statusBar = {
        round: state.battleLength === Infinity ? `R${state.round}` : `R${state.round}/${state.battleLength}`,
        phase: phaseLabel,
        timer: state.timer > 0 ? `${Math.ceil(state.timer)}s` : "",
        players: state.players.map((p, i) => ({
          score: p.score,
          cannons: p.cannons.filter(c => c.hp > 0).length,
          lives: p.lives,
          color: PLAYER_COLORS[i % PLAYER_COLORS.length]!.interiorLight,
          eliminated: p.eliminated,
        })),
      };
    }

    // Add score deltas to overlay (shown during "Place Cannons" banner)
    if (scoreDeltas.length > 0 && overlay.ui) {
      overlay.ui.scoreDeltas = scoreDeltas.map(d => {
        const zone = state.playerZones[d.playerId] ?? 0;
        const bounds = computeZoneBounds(zone);
        return { ...d, cx: bounds.x + bounds.w / 2, cy: bounds.y + bounds.h / 2 };
      });
    }

    // Unzoom for UI overlays and near end of phase
    if (cameraZone !== null) {
      const phaseEnding = state.timer > 0 && state.timer <= 1.5 &&
        (state.phase === Phase.WALL_BUILD || state.phase === Phase.CANNON_PLACE || state.phase === Phase.BATTLE);
      if (phaseEnding || quitPending || lifeLostDialog || paused) {
        cameraZone = null;
      }
    }

    // Auto-zoom on phase change (touch devices only, after first button press, not during banners)
    if (homeZoomButton && zoomActivated && state.phase !== lastAutoZoomPhase &&
        mode !== Mode.BANNER && mode !== Mode.BALLOON_ANIM && mode !== Mode.CASTLE_BUILD) {
      lastAutoZoomPhase = state.phase;
      autoZoom(state.phase);
    }

    renderMap(state.map, canvas, overlay, updateViewport());
    const inGame = mode === Mode.GAME || mode === Mode.BANNER || mode === Mode.BALLOON_ANIM;
    const noBanner = mode !== Mode.BANNER && mode !== Mode.BALLOON_ANIM && mode !== Mode.CASTLE_BUILD;
    const showZoom = noBanner && (mode === Mode.GAME || mode === Mode.SELECTION);
    rotateButton?.update(inGame ? state.phase : null);
    homeZoomButton?.update(showZoom ? state.phase : null);
    enemyZoomButton?.update(showZoom ? state.phase : null);
    quitButton?.update(inGame || mode === Mode.SELECTION ? state.phase : null);
  }

  function rematch() {
    // Reset and start a new game with the same player config
    cameraZone = null;
    battleZoom = null;
    lastAutoZoomPhase = null;
    cachedZoneBounds.clear();
    scoreDeltas = [];
    preScores = [];
    frame = { crosshairs: [], phantoms: {} };
    startGame();
    mode = Mode.SELECTION;
  }

  function returnToLobby(): void {
    cameraZone = null;
    mouseJoinedSlot = -1;
    // Hide all DOM buttons
    rotateButton?.update(null);
    homeZoomButton?.update(null);
    enemyZoomButton?.update(null);
    quitButton?.update(null);
    config.showLobby();
  }

  function endGame(winner: { id: number } | null) {
    cameraZone = null;
    config.onEndGame?.(winner, state);
    const name = winner
      ? (PLAYER_NAMES[winner.id] ?? `Player ${winner.id + 1}`)
      : "Nobody";
    frame.gameOver = {
      winner: name,
      scores: state.players.map((p) => ({
        name: PLAYER_NAMES[p.id] ?? `P${p.id + 1}`,
        score: p.score,
        color: PLAYER_COLORS[p.id % PLAYER_COLORS.length]!.wall,
        eliminated: p.eliminated,
        territory: p.interior.size,
        stats: gameStats[p.id],
      })),
      focused: "rematch" as "rematch" | "menu",
    };
    render();
    mode = Mode.STOPPED;
  }

  // -------------------------------------------------------------------------
  // Castle selection tick + finish
  // -------------------------------------------------------------------------

  function tickSelection(dt: number) {
    const remoteHumanSlots = config.getRemoteHumanSlots();
    tickSelectionPhase({
      dt,
      state,
      isHost: config.getIsHost(),
      myPlayerId: config.getMyPlayerId(),
      selectTimer: SELECT_TIMER,
      accum,
      selectionStates,
      remoteHumanSlots,
      controllers,
      render,
      confirmSelectionForPlayer: (pid, isReselect) =>
        confirmSelectionForPlayer(pid, isReselect ?? false),
      allSelectionsConfirmed,
      finishReselection,
      finishSelection,
      syncSelectionOverlay,
      sendOpponentTowerSelected: (playerId, towerIdx, confirmed) => {
        config.send({
          type: "opponent_tower_selected",
          playerId,
          towerIdx,
          confirmed,
        });
      },
    });
  }

  function finishSelection() {
    finishSelectionPhase({
      state,
      selectionStates,
      overlaySelection: overlay.selection,
      animateCastleConstruction,
      advanceToCannonPhase,
    });
  }

  function animateCastleConstruction(onDone: () => void): void {
    const wallPlans = prepareCastleWalls(state);
    if (config.getIsHost()) {
      config.send({
        type: "castle_walls",
        plans: wallPlans.map((p) => ({ playerId: p.playerId, tiles: p.tiles })),
      });
    }
    castleBuild = createCastleBuildState(wallPlans, () => {
      finalizeCastleConstruction(state);
      enterCannonPlacePhase(state);
      onDone();
    });
    render();
    mode = Mode.CASTLE_BUILD;
  }

  function advanceToCannonPhase(): void {
    // Compute score deltas from the build phase
    scoreDeltas = state.players
      .map((p, i) => ({ playerId: i, delta: p.score - (preScores[i] ?? 0), total: p.score }))
      .filter(d => d.delta > 0 && !state.players[d.playerId]!.eliminated);

    advanceToCannonPlacePhase(state);
    startCannonPhase();
    showBanner("Place Cannons", () => { scoreDeltaTimer = SCORE_DELTA_DISPLAY_TIME; mode = Mode.GAME; }, false, undefined, "Position inside fort walls");
  }

  function tickCastleBuild(dt: number): void {
    const result = tickCastleBuildAnimation({
      castleBuild, dt, wallBuildIntervalMs: WALL_BUILD_INTERVAL, state, render,
    });
    castleBuild = result.next;
    if (result.onDone) result.onDone();
  }

  // -------------------------------------------------------------------------
  // Reselection
  // -------------------------------------------------------------------------

  function startReselection() {
    const remoteHumanSlots = config.getRemoteHumanSlots();
    enterCastleReselectPhase(state);
    selectionStates.clear();
    reselectionPids = [];

    const { remaining, needsUI } = processReselectionQueue({
      reselectQueue,
      state,
      controllers,
      initTowerSelection,
      processPlayer: (pid, ctrl, zone) => {
        if (remoteHumanSlots.has(pid)) return "pending" as const;
        const done = ctrl.reselect(state, zone);
        return done ? "done" as const : "pending" as const;
      },
      onDone: (pid, ctrl) => {
        const player = state.players[pid]!;
        if (player.homeTower) ctrl.centerOn(player.homeTower.row, player.homeTower.col);
        markPlayerReselected(state, pid);
        reselectionPids.push(pid);
      },
    });
    reselectQueue = remaining.length > 0 ? remaining : [];

    if (needsUI) {
      syncSelectionOverlay();
      accum.select = 0;
      state.timer = SELECT_TIMER;
      mode = Mode.SELECTION;
      if (config.getIsHost()) {
        config.send({ type: "select_start", timer: SELECT_TIMER });
      }
    } else {
      finishReselection();
    }
  }

  function finishReselection() {
    completeReselection({
      state, selectionStates, overlaySelection: overlay.selection,
      reselectQueue, reselectionPids, clearPlayerState,
      animateReselectionCastles, advanceToCannonPhase,
    });
  }

  function animateReselectionCastles(onDone: () => void): void {
    if (reselectionPids.length === 0) {
      onDone();
      return;
    }

    const plans = prepareReselectionPlans(state, reselectionPids);
    reselectionPids = [];
    if (config.getIsHost()) {
      config.send({
        type: "castle_walls",
        plans: plans.map((p) => ({ playerId: p.playerId, tiles: p.tiles })),
      });
    }

    if (plans.length === 0) {
      onDone();
      return;
    }

    castleBuild = createCastleBuildState(plans, () => {
      finalizeCastleRebuild(state, plans);
      onDone();
    });
    render();
    mode = Mode.CASTLE_BUILD;
  }

  // -------------------------------------------------------------------------
  // Cannon phase
  // -------------------------------------------------------------------------

  function startCannonPhase() {
    const remoteHumanSlots = config.getRemoteHumanSlots();
    config.log(`startCannonPhase (round=${state.round})`);
    initCannonPhase({
      state,
      controllers,
      skipController: (pid) => remoteHumanSlots.has(pid),
    });

    accum.cannon = 0;
    state.timer = state.cannonPlaceTimer;
    if (config.getIsHost() && config.hostNetworking) {
      config.send(config.hostNetworking.buildCannonStartMessage(state));
    }
    render();
  }

  // -------------------------------------------------------------------------
  // Battle
  // -------------------------------------------------------------------------

  function startBattle() {
    config.log(`startBattle (round=${state.round})`);
    startHostBattleLifecycle({
      state,
      battleAnim,
      isHost: config.getIsHost(),
      resolveBalloons,
      snapshotTerritory,
      showBanner,
      nextPhase,
      sendBattleStart: (flights) => {
        if (config.hostNetworking) {
          config.send(config.hostNetworking.buildBattleStartMessage(state, flights));
        }
      },
      setModeBalloonAnim: () => { mode = Mode.BALLOON_ANIM; },
      beginBattle,
    });
  }

  function tickBalloonAnim(dt: number) {
    tickHostBalloonAnim({
      dt,
      balloonFlightDuration: BALLOON_FLIGHT_DURATION,
      battleAnim,
      render,
      beginBattle,
    });
  }

  function beginBattle() {
    const remoteHumanSlots = config.getRemoteHumanSlots();
    beginHostBattle({
      state,
      controllers,
      remoteHumanSlots,
      accum,
      isHost: config.getIsHost(),
      watcherTiming: config.watcherTiming,
      battleCountdown: BATTLE_COUNTDOWN,
      now: () => performance.now(),
      setModeGame: () => { mode = Mode.GAME; },
    });
  }

  // -------------------------------------------------------------------------
  // Build phase
  // -------------------------------------------------------------------------

  function startBuildPhase() {
    const remoteHumanSlots = config.getRemoteHumanSlots();
    config.log(`startBuildPhase (round=${state.round})`);
    // Snapshot scores before build phase for delta display
    preScores = state.players.map(p => p.score);
    scoreDeltas = [];
    initBuildPhase(state, controllers, (pid) => remoteHumanSlots.has(pid) || !!state.players[pid]?.eliminated);
    battleAnim.impacts = [];
    accum.grunt = 0;
    accum.build = 0;
  }

  // -------------------------------------------------------------------------
  // Game loop — tick functions
  // -------------------------------------------------------------------------

  function tickCannonPhase(dt: number): boolean {
    // Fade out score deltas
    if (scoreDeltaTimer > 0) {
      scoreDeltaTimer -= dt;
      if (scoreDeltaTimer <= 0) { scoreDeltas = []; scoreDeltaTimer = 0; }
    }
    const remoteHumanSlots = config.getRemoteHumanSlots();
    return tickHostCannonPhase({
      dt,
      state,
      accum,
      frame,
      controllers,
      remoteHumanSlots,
      remoteCannonPhantoms: config.hostNetworking?.remoteCannonPhantoms() ?? [],
      lastSentCannonPhantom: config.hostNetworking?.lastSentCannonPhantom() ?? new Map(),
      isHost: config.getIsHost(),
      render,
      startBattle,
      autoPlaceCannons: config.hostNetworking?.autoPlaceCannons ?? (() => {}),
      sendOpponentCannonPlaced: (msg) => config.send({ type: "opponent_cannon_placed", ...msg }),
      sendOpponentCannonPhantom: (msg) => config.send({ type: "opponent_cannon_phantom", ...msg }),
    });
  }

  function tickBattleCountdown(dt: number): void {
    const remoteHumanSlots = config.getRemoteHumanSlots();
    tickHostBattleCountdown({
      dt,
      state,
      frame,
      controllers,
      remoteHumanSlots,
      collectCrosshairs,
      render,
    });
  }

  function tickBattlePhase(dt: number): boolean {
    const remoteHumanSlots = config.getRemoteHumanSlots();
    return tickHostBattlePhase({
      dt,
      state,
      battleTimer: BATTLE_TIMER,
      accum,
      controllers,
      remoteHumanSlots,
      isHost: config.getIsHost(),
      battleAnim,
      render,
      collectCrosshairs,
      collectTowerEvents: gruntAttackTowers,
      updateCannonballsWithEvents: updateCannonballs,
      sendMessage: config.send,
      onBattleEvents: (events) => {
        const pid = config.getMyPlayerId();
        const localPid = pid >= 0 ? pid : (firstHuman()?.playerId ?? -1);
        if (localPid >= 0) hapticBattleEvents(events as any, localPid);
        // Accumulate stats
        for (const evt of events as Array<{ type: string; playerId?: number; shooterId?: number; hp?: number; newHp?: number }>) {
          if (evt.type === "wall_destroyed" && evt.shooterId !== undefined) {
            gameStats[evt.shooterId]!.wallsDestroyed++;
          } else if (evt.type === "cannon_damaged" && evt.shooterId !== undefined && evt.newHp === 0) {
            gameStats[evt.shooterId]!.cannonsKilled++;
          }
        }
      },
      onBattlePhaseEnded: () => {
        showBanner(
          "Build & Repair",
          () => {
            startBuildPhase();
            mode = Mode.GAME;
          },
          true,
          undefined,
          "Surround castles, repair walls",
        );
        nextPhase(state); // BATTLE -> WALL_BUILD
        if (config.getIsHost() && config.hostNetworking) {
          config.send(config.hostNetworking.buildBuildStartMessage(state));
        }
      },
    });
  }

  function tickBuildPhase(dt: number): boolean {
    const remoteHumanSlots = config.getRemoteHumanSlots();
    return tickHostBuildPhase({
      dt,
      state,
      accum,
      frame,
      controllers,
      remoteHumanSlots,
      remotePiecePhantoms: config.hostNetworking?.remotePiecePhantoms() ?? [],
      lastSentPiecePhantom: config.hostNetworking?.lastSentPiecePhantom() ?? new Map(),
      isHost: config.getIsHost(),
      render,
      tickGrunts,
      isHuman,
      finalizeBuildPhase,
      serializePlayers: config.hostNetworking?.serializePlayers ?? (() => []),
      showLifeLostDialog,
      afterLifeLostResolved: () => afterLifeLostResolved(),
      sendOpponentPiecePlaced: (msg) => config.send({ type: "opponent_piece_placed", ...msg }),
      sendOpponentPhantom: (msg) => config.send({ type: "opponent_phantom", ...msg }),
      sendBuildEnd: (msg) => config.send({ type: "build_end", ...msg }),
    });
  }

  // -------------------------------------------------------------------------
  // Life-lost dialog
  // -------------------------------------------------------------------------

  function showLifeLostDialog(needsReselect: number[], eliminated: number[]) {
    const remoteHumanSlots = config.getRemoteHumanSlots();
    config.log(
      `showLifeLostDialog: needsReselect=[${needsReselect}] eliminated=[${eliminated}]`,
    );
    lifeLostDialog = buildLifeLostDialogState({
      needsReselect,
      eliminated,
      state,
      isHost: config.getIsHost(),
      myPlayerId: config.getMyPlayerId(),
      remoteHumanSlots,
      isHumanController: (playerId) => isHuman(controllers[playerId]!),
    });
    mode = Mode.LIFE_LOST;
  }

  function tickLifeLostDialog(dt: number) {
    lifeLostDialog = tickLifeLostDialogRuntime({
      dt,
      lifeLostDialog,
      lifeLostAiDelay: LIFE_LOST_AI_DELAY,
      lifeLostMaxTimer: LIFE_LOST_MAX_TIMER,
      state,
      isHost: config.getIsHost(),
      render,
      logResolved: (dialog) => {
        config.log(
          `lifeLostDialog resolved: ${dialog.entries.map((e) => `P${e.playerId}=${e.choice}(ai=${e.isAi})`).join(", ")} timer=${dialog.timer.toFixed(1)}s`,
        );
      },
      resolveHostDialog: (dialog) =>
        resolveLifeLostDialogRuntime({
          lifeLostDialog: dialog,
          state,
          afterLifeLostResolved,
        }),
      onNonHostResolved: () => {
        mode = Mode.GAME;
      },
    });
  }

  function afterLifeLostResolved(continuing: number[] = []): boolean {
    return resolveAfterLifeLost({
      state,
      continuing,
      onEndGame: endGame,
      onStartReselection: (players) => {
        reselectQueue = players;
        startReselection();
        mode = Mode.SELECTION;
      },
      onAdvanceToCannonPhase: advanceToCannonPhase,
    });
  }

  function lifeLostPanelPos(playerId: number): { px: number; py: number } {
    return lifeLostPanelPosShared(state, playerId);
  }

  function lifeLostDialogClick(canvasX: number, canvasY: number) {
    if (!lifeLostDialog) return;
    const mousePlayer = firstHuman();
    if (!mousePlayer) return;

    const choice = handleLifeLostDialogClickShared({
      state,
      lifeLostDialog,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      canvasX,
      canvasY,
      firstHumanPlayerId: mousePlayer.playerId,
    });
    if (!choice) return;

    // Online: send choice to server
    config.send({ type: "life_lost_choice", choice: choice.choice, playerId: choice.playerId });
  }

  // -------------------------------------------------------------------------
  // tickGame
  // -------------------------------------------------------------------------

  function tickGame(dt: number) {
    if (config.getIsHost()) {
      tickGameCore({
        dt,
        state,
        battleAnim,
        impactFlashDuration: IMPACT_FLASH_DURATION,
        tickCannonPhase,
        tickBattleCountdown,
        tickBattlePhase,
        tickBuildPhase,
      });
    } else {
      // Non-host: still age impacts, then delegate to config callback
      for (const imp of battleAnim.impacts) imp.age += dt;
      battleAnim.impacts = battleAnim.impacts.filter(
        (imp) => imp.age < IMPACT_FLASH_DURATION,
      );
      config.tickNonHost?.(dt);
    }
  }

  // -------------------------------------------------------------------------
  // resetUIState
  // -------------------------------------------------------------------------

  function resetUIState(): void {
    reselectQueue = [];
    reselectionPids = [];
    battleAnim = createBattleAnimState();
    accum = createTimerAccums();
    banner = createBannerState();
    lifeLostDialog = null;
    paused = false;
    quitPending = false;
    optionsReturnMode = null;
  }

  // -------------------------------------------------------------------------
  // startGame
  // -------------------------------------------------------------------------

  function startGame() {
    const parsedSeed =
      settings.seedMode === "custom" && settings.seed
        ? parseInt(settings.seed, 10)
        : NaN;
    const seed = isNaN(parsedSeed)
      ? Math.floor(Math.random() * 1000000)
      : parsedSeed;

    const diff = settings.difficulty;
    const buildTimer = diff === 0 ? 30 : diff === 2 ? 20 : diff === 3 ? 15 : 25;
    const cannonPlaceTimer = diff === 0 ? 20 : diff === 2 ? 12 : diff === 3 ? 10 : 15;
    const firstRoundCannons = diff === 0 ? 4 : diff === 2 ? 2 : diff === 3 ? 1 : 3;
    const roundsVal = ROUNDS_OPTIONS[settings.rounds]!.value;

    resetGameStats();

    bootstrapGame({
      seed,
      maxPlayers: Math.min(MAX_PLAYERS, PLAYER_KEY_BINDINGS.length),
      battleLength: roundsVal,
      cannonMaxHp: CANNON_HP_OPTIONS[settings.cannonHp]!.value,
      buildTimer,
      cannonPlaceTimer,
      log: config.log,
      resetFrame,
      setState: (s: GameState) => {
        s.firstRoundCannons = firstRoundCannons;
        state = s;
      },
      setControllers: (c: PlayerController[]) => { controllers = c; },
      resetUIState,
      createControllerForSlot: (i: number, gameState: GameState) => {
        const isAi = !lobby.joined[i];
        const strategySeed = isAi ? gameState.rng.int(0, 0xffffffff) : undefined;
        return createController(i, isAi, settings.keyBindings[i]!, strategySeed);
      },
      enterSelection: enterTowerSelection,
    });
  }

  // -------------------------------------------------------------------------
  // UIContext — bridges internal state to game-ui-screens.ts functions
  // -------------------------------------------------------------------------

  const uiCtx: UIContext = {
    canvas,
    getState: () => state,
    getOverlay: () => overlay,
    settings,
    getMode: () => mode,
    setMode: (m) => { mode = m; },
    getPaused: () => paused,
    setPaused: (v) => { paused = v; },
    optionsCursor: {
      get value() { return optionsCursor; },
      set value(v) { optionsCursor = v; },
    },
    controlsState,
    getOptionsReturnMode: () => optionsReturnMode,
    setOptionsReturnMode: (m) => { optionsReturnMode = m; },
    lobby,
    getFrame: () => frame,
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
      getState: () => state,
      getMode: () => mode,
      setMode: (m) => { mode = m as Mode; },
      modeValues: {
        LOBBY: Mode.LOBBY, OPTIONS: Mode.OPTIONS, CONTROLS: Mode.CONTROLS,
        SELECTION: Mode.SELECTION, BANNER: Mode.BANNER, BALLOON_ANIM: Mode.BALLOON_ANIM,
        CASTLE_BUILD: Mode.CASTLE_BUILD, LIFE_LOST: Mode.LIFE_LOST,
        GAME: Mode.GAME, STOPPED: Mode.STOPPED,
      },
      isLobbyActive: () => lobby.active,
      lobbyKeyJoin,
      lobbyClick,
      showLobby: returnToLobby,
      rematch,
      getGameOverFocused: () => frame.gameOver?.focused ?? "rematch",
      setGameOverFocused: (f) => { if (frame.gameOver) { frame.gameOver.focused = f; render(); } },
      showOptions,
      closeOptions,
      showControls,
      closeControls,
      getOptionsCursor: () => optionsCursor,
      setOptionsCursor: (c) => { optionsCursor = c; },
      getOptionsCount: () => visibleOptionsForCtx().length,
      getRealOptionIdx: realOptionIdx,
      getOptionsReturnMode: () => optionsReturnMode,
      setOptionsReturnMode: (m) => { optionsReturnMode = m as Mode | null; },
      changeOption,
      getControlsState: () => controlsState,
      getLifeLostDialog: () => lifeLostDialog,
      lifeLostDialogClick,
      getControllers: () => controllers,
      isHuman,
      withFirstHuman,
      pixelToTile,
      screenToWorld,
      maybeSendAimUpdate: config.maybeSendAimUpdate ?? (() => {}),
      tryPlaceCannonAndSend: config.tryPlaceCannonAndSend ?? ((ctrl, gs, max) => ctrl.tryPlaceCannon(gs, max)),
      tryPlacePieceAndSend: config.tryPlacePieceAndSend ?? ((ctrl, gs) => ctrl.tryPlacePiece(gs)),
      fireAndSend: config.fireAndSend ?? ((ctrl, gameState) => ctrl.fire(gameState)),
      getSelectionStates: () => selectionStates,
      highlightTowerForPlayer,
      confirmSelectionForPlayer,
      finishReselection,
      finishSelection,
      isHost: config.getIsHost,
      togglePause,
      getQuitPending: () => quitPending,
      setQuitPending: (v) => { quitPending = v; },
      setQuitTimer: (s) => { quitTimer = s; },
      setQuitMessage: (msg) => { quitMessage = msg; },
      render,
      sendLifeLostChoice: (choice, playerId) => {
        config.send({ type: "life_lost_choice", choice, playerId });
      },
      settings,
    };
    registerOnlineInputHandlers(inputDeps);
    registerTouchHandlers({ ...inputDeps, lobbyKeyJoin: undefined });

    // Rotate button (mobile only)
    if (IS_TOUCH_DEVICE) {
      rotateButton = createRotateButton({
        getState: () => state,
        withFirstHuman,
        render,
      });
      const zoomDeps = {
        getState: () => state,
        getCameraZone: () => cameraZone,
        setCameraZone: (z: number | null) => {
          cameraZone = z;
          zoomActivated = true;
          // Remember enemy zoom choice for battle persistence
          if (state.phase === Phase.BATTLE && z !== null) battleZoom = z;
        },
        myPlayerId,
        render,
      };
      homeZoomButton = createHomeZoomButton(zoomDeps);
      enemyZoomButton = createEnemyZoomButton(zoomDeps);
    }
  }

  // Quit button (always, not just touch)
  quitButton = createQuitButton({
    getQuitPending: () => quitPending,
    setQuitPending: (v) => { quitPending = v; },
    setQuitTimer: (v) => { quitTimer = v; },
    setQuitMessage: (msg) => { quitMessage = msg; },
    showLobby: returnToLobby,
    getControllers: () => controllers,
    isHuman,
    render,
  });

  // -------------------------------------------------------------------------
  // Return the runtime object
  // -------------------------------------------------------------------------

  return {
    // State getters/setters
    getState: () => state,
    setState: (s) => { state = s; },
    getOverlay: () => overlay,
    getControllers: () => controllers,
    setControllers: (c) => { controllers = c; },
    getAccum: () => accum,
    setAccum: (a) => { accum = a; },
    getSelectionStates: () => selectionStates,
    getBattleAnim: () => battleAnim,
    setBattleAnim: (b) => { battleAnim = b; },
    getFrame: () => frame,
    getLifeLostDialog: () => lifeLostDialog,
    setLifeLostDialog: (d) => { lifeLostDialog = d; },
    getCastleBuild: () => castleBuild,
    setCastleBuild: (c) => { castleBuild = c; },
    getReselectQueue: () => reselectQueue,
    setReselectQueue: (q) => { reselectQueue = q; },
    getReselectionPids: () => reselectionPids,
    setReselectionPids: (p) => { reselectionPids = p; },
    getMode: () => mode,
    setMode: (m) => { mode = m; },
    getSettings: () => settings,
    getPaused: () => paused,
    setPaused: (v) => { paused = v; },
    getQuitPending: () => quitPending,
    setQuitPending: (v) => { quitPending = v; },
    getQuitTimer: () => quitTimer,
    setQuitTimer: (v) => { quitTimer = v; },
    getOptionsReturnMode: () => optionsReturnMode,
    setOptionsReturnMode: (m) => { optionsReturnMode = m; },
    getOptionsCursor: () => optionsCursor,
    setOptionsCursor: (v) => { optionsCursor = v; },
    getControlsState: () => controlsState,
    getLobby: () => lobby,
    getBanner: () => banner,
    setBanner: (b) => { banner = b; },
    getLastTime: () => lastTime,
    setLastTime: (t) => { lastTime = t; },

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

    initTowerSelection,
    enterTowerSelection,
    syncSelectionOverlay,
    highlightTowerForPlayer,
    confirmSelectionForPlayer,
    allSelectionsConfirmed,

    collectCrosshairs,
    snapshotTerritory,
    firstHuman,
    withFirstHuman,

    render,
    endGame,

    tickSelection,
    finishSelection,
    animateCastleConstruction,
    advanceToCannonPhase,
    tickCastleBuild,

    startReselection,
    finishReselection,
    animateReselectionCastles,

    startCannonPhase,
    startBattle,
    tickBalloonAnim,
    beginBattle,
    startBuildPhase,

    tickCannonPhase,
    tickBattleCountdown,
    tickBattlePhase,
    tickBuildPhase,

    showLifeLostDialog,
    tickLifeLostDialog,
    afterLifeLostResolved,
    lifeLostPanelPos,
    lifeLostDialogClick,

    tickGame,
    resetUIState,
    startGame,

    uiCtx,
    registerInputHandlers,
  };
}
