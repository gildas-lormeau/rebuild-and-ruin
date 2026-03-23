/**
 * Shared game runtime factory — consolidates all orchestration code
 * from main.ts (local) and online-client.ts (online).
 *
 * createGameRuntime(config) returns a closure that owns all shared
 * mutable state and exposes getters/setters + functions for callers.
 */

import { GRID_COLS, GRID_ROWS, TILE_SIZE, SCALE } from "./grid.ts";
import { unpackTile } from "./spatial.ts";
import { renderMap } from "./map-renderer.ts";
import { createCameraSystem } from "./runtime-camera.ts";

const TILE = TILE_SIZE;
import type { RenderOverlay } from "./map-renderer.ts";
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
  getPlayerColor,
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
  DIFFICULTY_PARAMS,
  type PlayerStats,
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
  buildStatusBar,
  syncSelectionOverlay as syncSelectionOverlayImpl,
  lifeLostPanelPos as lifeLostPanelPosShared,
  handleLifeLostDialogClick as handleLifeLostDialogClickShared,
} from "./render-composition.ts";
import type { LifeLostDialogState } from "./life-lost.ts";
import {
  tickLifeLostDialogRuntime,
  resolveLifeLostDialogRuntime,
  buildLifeLostDialogState,
  resolveAfterLifeLost,
} from "./life-lost.ts";
import {
  allSelectionsConfirmed as allSelectionsConfirmedImpl,
  initTowerSelection as initTowerSelectionImpl,
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
import type { ServerMessage, GameMessage } from "../server/protocol.ts";
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
import { createDpad, createHomeZoomButton, createEnemyZoomButton, createQuitButton } from "./touch-ui.ts";
import { hapticBattleEvents, hapticPhaseChange, setHapticsLevel } from "./haptics.ts";
import { GEAR_X, GEAR_Y, GEAR_SIZE } from "./render-theme.ts";
import {
  snapshotTerritory as snapshotTerritoryImpl,
  lobbyClickHitTest,
  initCannonPhase,
  collectLocalCrosshairs,
  tickGameCore,
  processReselectionQueue,
  completeReselection,
  mainLoopTick,
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
  lobbySkipStep,
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
  send: (msg: GameMessage) => void;
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
  /** Called every frame regardless of host/non-host (e.g., timed announcements). */
  everyTick?: (dt: number) => void;
  /** Host-only networking state for tick functions (phantom merging, checkpoints, auto-placement). */
  hostNetworking?: {
    autoPlaceCannons: (player: GameState["players"][number], max: number, state: GameState) => void;
    serializePlayers: (state: GameState) => SerializedPlayer[];
    buildCannonStartMessage: (state: GameState) => ServerMessage;
    buildBattleStartMessage: (state: GameState, flights: BalloonFlight[]) => ServerMessage;
    buildBuildStartMessage: (state: GameState) => ServerMessage;
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
  let dpad: ReturnType<typeof createDpad> | null = null;
  let homeZoomButton: ReturnType<typeof createHomeZoomButton> | null = null;
  let enemyZoomButton: ReturnType<typeof createEnemyZoomButton> | null = null;
  let quitButton: ReturnType<typeof createQuitButton> | null = null;
  let lifeLostDialog: LifeLostDialogState | null = null;
  let frame: FrameData = { crosshairs: [], phantoms: {} };
  let battleAnim: BattleAnimState = createBattleAnimState();
  let banner: BannerState = createBannerState();
  /** Score deltas to show after build phase. Fades out after a few seconds. */
  let scoreDeltas: { playerId: number; delta: number; total: number; cx: number; cy: number }[] = [];
  let scoreDeltaTimer = 0;
  const SCORE_DELTA_DISPLAY_TIME = 4; // seconds after banner ends
  let preScores: number[] = [];
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
            const { r, c } = unpackTile(key);
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

    tickCamera(dt);

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
    if (mouseJoinedSlot >= 0) {
      lobbySkipStep(uiCtx);
      return true;
    }
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
    dpad?.setLeftHanded(settings.leftHanded);
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
    camera.unzoomForBanner();
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
    syncSelectionOverlayImpl(overlay, selectionStates, (pid) => isHuman(controllers[pid]!));
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
  // Camera / zoom (delegated to runtime-camera.ts)
  // -------------------------------------------------------------------------

  const camera = createCameraSystem({
    getState: () => state,
    getMode: () => mode,
    getQuitPending: () => quitPending,
    hasLifeLostDialog: () => lifeLostDialog !== null,
    getPaused: () => paused,
    getFrameDt: () => frameDt,
    setFrameAnnouncement: (text) => { frame.announcement = text; },
    getMyPlayerId: () => config.getMyPlayerId(),
    getFirstHumanPlayerId: () => firstHuman()?.playerId ?? -1,
  });

  // Re-export camera functions used by other parts of the runtime
  const { tickCamera, updateViewport, screenToWorld, pixelToTile,
    onPinchStart, onPinchUpdate, onPinchEnd,
    myPlayerId, getEnemyZones, computeZoneBounds } = camera;


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
      overlay.ui.statusBar = buildStatusBar(state, PLAYER_COLORS);
    }

    // Add score deltas to overlay (shown during "Place Cannons" banner)
    if (scoreDeltas.length > 0 && overlay.ui) {
      overlay.ui.scoreDeltas = scoreDeltas;
    }

    renderMap(state.map, canvas, overlay, updateViewport());
    const inGame = mode === Mode.GAME || mode === Mode.BANNER || mode === Mode.BALLOON_ANIM;
    const noBanner = mode !== Mode.BANNER && mode !== Mode.BALLOON_ANIM && mode !== Mode.CASTLE_BUILD;
    const showZoom = noBanner && (mode === Mode.GAME || mode === Mode.SELECTION);
    const hasHuman = firstHuman() !== null;
    dpad?.update(hasHuman && (mode === Mode.GAME || mode === Mode.SELECTION) ? state.phase : null);
    homeZoomButton?.update(showZoom ? state.phase : null);
    enemyZoomButton?.update(showZoom ? state.phase : null);
    quitButton?.update(inGame || mode === Mode.SELECTION ? state.phase : null);
  }

  function rematch() {
    // Reset and start a new game with the same player config
    camera.resetCamera();
    scoreDeltas = [];
    preScores = [];
    frame = { crosshairs: [], phantoms: {} };
    startGame();
    mode = Mode.SELECTION;
  }

  function returnToLobby(): void {
    camera.unzoom();
    mouseJoinedSlot = -1;
    // Hide all DOM buttons
    dpad?.update(null);
    homeZoomButton?.update(null);
    enemyZoomButton?.update(null);
    quitButton?.update(null);
    config.showLobby();
  }

  function endGame(winner: { id: number } | null) {
    camera.unzoom();
    config.onEndGame?.(winner, state);
    const name = winner
      ? (PLAYER_NAMES[winner.id] ?? `Player ${winner.id + 1}`)
      : "Nobody";
    frame.gameOver = {
      winner: name,
      scores: state.players.map((p) => ({
        name: PLAYER_NAMES[p.id] ?? `P${p.id + 1}`,
        score: p.score,
        color: getPlayerColor(p.id).wall,
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

  function clearOverlaySelection() {
    if (overlay.selection) {
      overlay.selection.highlights = undefined;
      overlay.selection.highlighted = null;
      overlay.selection.selected = null;
    }
  }

  function finishSelection() {
    finishSelectionPhase({
      state,
      selectionStates,
      clearOverlaySelection,
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
      camera.clearCastleBuildViewport();
      onDone();
    });
    // Pre-compute viewport covering all planned walls so camera stays steady
    camera.setCastleBuildViewport(wallPlans);
    render();
    mode = Mode.CASTLE_BUILD;
  }

  function advanceToCannonPhase(): void {
    // Compute score deltas from the build phase (with display coordinates)
    scoreDeltas = state.players
      .map((p, i) => {
        const zone = state.playerZones[i] ?? 0;
        const bounds = computeZoneBounds(zone);
        return {
          playerId: i, delta: p.score - (preScores[i] ?? 0), total: p.score,
          cx: bounds.x + bounds.w / 2, cy: bounds.y + bounds.h / 2,
        };
      })
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
      state, selectionStates, clearOverlaySelection,
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
      camera.clearCastleBuildViewport();
      onDone();
    });
    camera.setCastleBuildViewport(plans);
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
      resolveBalloons,
      snapshotTerritory,
      showBanner,
      nextPhase,
      setModeBalloonAnim: () => { mode = Mode.BALLOON_ANIM; },
      beginBattle,
      net: config.hostNetworking ? {
        isHost: config.getIsHost(),
        sendBattleStart: (flights) => {
          config.send(config.hostNetworking!.buildBattleStartMessage(state, flights));
        },
      } : undefined,
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
    beginHostBattle({
      state,
      controllers,
      accum,
      battleCountdown: BATTLE_COUNTDOWN,
      setModeGame: () => { mode = Mode.GAME; },
      net: {
        remoteHumanSlots: config.getRemoteHumanSlots(),
        isHost: config.getIsHost(),
        watcherTiming: config.watcherTiming ?? { phaseStartTime: 0, phaseDuration: 0, countdownStartTime: 0, countdownDuration: 0 },
        now: () => performance.now(),
      },
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
    return tickHostCannonPhase({
      dt, state, accum, frame, controllers, render, startBattle,
      net: {
        remoteHumanSlots: config.getRemoteHumanSlots(),
        isHost: config.getIsHost(),
        remoteCannonPhantoms: config.hostNetworking?.remoteCannonPhantoms() ?? [],
        lastSentCannonPhantom: config.hostNetworking?.lastSentCannonPhantom() ?? new Map(),
        autoPlaceCannons: config.hostNetworking?.autoPlaceCannons ?? (() => {}),
        sendOpponentCannonPlaced: (msg) => config.send({ type: "opponent_cannon_placed", ...msg }),
        sendOpponentCannonPhantom: (msg) => config.send({ type: "opponent_cannon_phantom", ...msg }),
      },
    });
  }

  function tickBattleCountdown(dt: number): void {
    tickHostBattleCountdown({
      dt, state, frame, controllers, collectCrosshairs, render,
      net: { remoteHumanSlots: config.getRemoteHumanSlots() },
    });
  }

  function tickBattlePhase(dt: number): boolean {
    return tickHostBattlePhase({
      dt, state, battleTimer: BATTLE_TIMER, accum, controllers, battleAnim,
      render, collectCrosshairs,
      collectTowerEvents: gruntAttackTowers,
      updateCannonballsWithEvents: updateCannonballs,
      onBattleEvents: (events) => {
        const pid = config.getMyPlayerId();
        const localPid = pid >= 0 ? pid : (firstHuman()?.playerId ?? -1);
        if (localPid >= 0) hapticBattleEvents(events as Array<{ type: string; playerId?: number; hp?: number }>, localPid);
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
      net: {
        remoteHumanSlots: config.getRemoteHumanSlots(),
        isHost: config.getIsHost(),
        sendMessage: config.send,
      },
    });
  }

  function tickBuildPhase(dt: number): boolean {
    return tickHostBuildPhase({
      dt, state, accum, frame, controllers, render,
      tickGrunts, isHuman, finalizeBuildPhase, showLifeLostDialog,
      afterLifeLostResolved: () => afterLifeLostResolved(),
      net: {
        remoteHumanSlots: config.getRemoteHumanSlots(),
        isHost: config.getIsHost(),
        remotePiecePhantoms: config.hostNetworking?.remotePiecePhantoms() ?? [],
        lastSentPiecePhantom: config.hostNetworking?.lastSentPiecePhantom() ?? new Map(),
        serializePlayers: config.hostNetworking?.serializePlayers ?? (() => []),
        sendOpponentPiecePlaced: (msg) => config.send({ type: "opponent_piece_placed", ...msg }),
        sendOpponentPhantom: (msg) => config.send({ type: "opponent_phantom", ...msg }),
        sendBuildEnd: (msg) => config.send({ type: "build_end", ...msg }),
      },
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
    config.everyTick?.(dt);
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

    const diffParams = DIFFICULTY_PARAMS[settings.difficulty] ?? DIFFICULTY_PARAMS[1]!;
    const { buildTimer, cannonPlaceTimer, firstRoundCannons } = diffParams;
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
    ctx2d: canvas.getContext("2d")!,
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
      onPinchStart,
      onPinchUpdate,
      onPinchEnd,
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

    // D-pad + action buttons (mobile only)
    if (IS_TOUCH_DEVICE) {
      const placePiece = inputDeps.tryPlacePieceAndSend;
      const placeCannon = inputDeps.tryPlaceCannonAndSend;
      dpad = createDpad({
        getState: () => state,
        withFirstHuman,
        tryPlacePieceAndSend: placePiece,
        tryPlaceCannonAndSend: placeCannon,
        getSelectionStates: () => selectionStates,
        highlightTowerForPlayer,
        confirmSelectionForPlayer,
        finishSelection,
        finishReselection,
        isHost: config.getIsHost,
        render,
        getLeftHanded: () => settings.leftHanded,
      });
      const zoomDeps = {
        getState: () => state,
        getCameraZone: camera.getCameraZone,
        setCameraZone: camera.setCameraZone,
        myPlayerId,
        getEnemyZones,
        render,
      };
      homeZoomButton = createHomeZoomButton(zoomDeps);
      enemyZoomButton = createEnemyZoomButton(zoomDeps);
      camera.enableMobileZoom();
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
