/**
 * Shared game runtime factory — consolidates all orchestration code
 * from main.ts (local) and online-client.ts (online).
 *
 * createGameRuntime(config) returns a RuntimeState bag (rs) plus
 * methods that operate on it. See runtime-state.ts for the state type.
 */



import { MSG } from "../server/protocol.ts";
import { resolveBalloons, updateCannonballs } from "./battle-system.ts";
import {
  beginHostBattle,
  startHostBattleLifecycle,
  tickHostBalloonAnim,
  tickHostBattleCountdown,
  tickHostBattlePhase,
} from "./battle-ticks.ts";
import {
  createCastleBuildState,
  tickCastleBuildAnimation,
} from "./castle-build.ts";
import { createController, isHuman } from "./controller-factory.ts";
import { bootstrapGame, setupTowerSelection } from "./game-bootstrap.ts";
import {
  advanceToCannonPlacePhase,
  BANNER_BUILD,
  BANNER_BUILD_SUB,
  BANNER_PLACE_CANNONS,
  BANNER_PLACE_CANNONS_SUB,
  clearPlayerState,
  enterCannonPlacePhase,
  enterCastleReselectPhase,
  finalizeBuildPhase,
  finalizeCastleConstruction,
  finalizeCastleRebuild,
  initBuildPhase,
  markPlayerReselected,
  nextPhase,
  prepareCastleWalls,
  prepareReselectionPlans,
} from "./game-engine.ts";
import type { GameRuntime, RuntimeConfig } from "./game-runtime-types.ts";
import {
  collectLocalCrosshairs,
  completeReselection,
  initCannonPhase,
  lobbyClickHitTest,
  mainLoopTick,
  processReselectionQueue,
  snapshotTerritory as snapshotTerritoryImpl,
  tickGameCore,
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
  Mode,
  ROUNDS_OPTIONS,
} from "./game-ui-types.ts";
import { GRID_COLS, GRID_ROWS, SCALE, TILE_SIZE } from "./grid.ts";
import { gruntAttackTowers, tickGrunts } from "./grunt-system.ts";
import { hapticBattleEvents, hapticPhaseChange, setHapticsLevel } from "./haptics.ts";
import { type RegisterOnlineInputDeps, registerOnlineInputHandlers } from "./input.ts";
import type { LifeLostDialogState } from "./life-lost.ts";
import {
  buildLifeLostDialogState,
  resolveAfterLifeLost,
  resolveLifeLostDialogRuntime,
  tickLifeLostDialogRuntime,
} from "./life-lost.ts";
import {
  createBannerState,
  showBannerTransition,
  tickBannerTransition,
} from "./phase-banner.ts";
import {
  tickHostBuildPhase,
  tickHostCannonPhase,
} from "./phase-ticks.ts";
import { IS_TOUCH_DEVICE } from "./platform.ts";
import {
  getPlayerColor,
  MAX_PLAYERS,
  PLAYER_COLORS,
  PLAYER_KEY_BINDINGS,
  PLAYER_NAMES,
} from "./player-config.ts";
import type { PlayerController } from "./player-controller.ts";
import {
  buildBannerUi,
  buildOnlineOverlay,
  buildRenderSummaryMessage,
  buildStatusBar,
  handleLifeLostDialogClick as handleLifeLostDialogClickShared,
  lifeLostPanelPos as lifeLostPanelPosShared,
  syncSelectionOverlay as syncSelectionOverlayImpl,
} from "./render-composition.ts";
import { renderMap } from "./render-map.ts";
import { computeLobbyLayout } from "./render-ui.ts";
import { createCameraSystem } from "./runtime-camera.ts";
import { createRuntimeState } from "./runtime-state.ts";
import {
  allSelectionsConfirmed as allSelectionsConfirmedImpl,
  confirmTowerSelection,
  finishSelectionPhase,
  highlightTowerSelection,
  initTowerSelection as initTowerSelectionImpl,
  tickSelectionPhase,
} from "./selection.ts";
import { unpackTile } from "./spatial.ts";
import { registerTouchHandlers } from "./touch-input.ts";
import { createDpad, createEnemyZoomButton, createHomeZoomButton, createQuitButton } from "./touch-ui.ts";
import type { GameState } from "./types.ts";
import {
  BALLOON_FLIGHT_DURATION,
  BANNER_DURATION,
  BATTLE_COUNTDOWN,
  BATTLE_TIMER,
  IMPACT_FLASH_DURATION,
  LIFE_LOST_AI_DELAY,
  LIFE_LOST_MAX_TIMER,
  MAX_FRAME_DT,
  Phase,
  SELECT_TIMER,
  WALL_BUILD_INTERVAL,
} from "./types.ts";

export type { GameRuntime } from "./game-runtime-types.ts";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGameRuntime(config: RuntimeConfig): GameRuntime {
  const { canvas } = config;

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

  const SCORE_DELTA_DISPLAY_TIME = 4; // seconds after banner ends

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

  // @ts-ignore — import.meta.env is Vite-specific
  const DEV = import.meta.env?.DEV ?? (typeof location !== "undefined" && location?.hostname === "localhost");

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
    rs.lobby.timerAccum = (rs.lobby.timerAccum ?? 0) + dt;
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
      config.onLobbySlotJoined(hit.slotId);
      renderLobby();
      // On touch devices in local mode, start immediately after joining
      if (IS_TOUCH_DEVICE && !config.isOnline) {
        rs.lobby.active = false;
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
    camera.unzoomForBanner();
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
  // Tower selection helpers
  // -------------------------------------------------------------------------

  function initTowerSelection(pid: number, zone: number): void {
    initTowerSelectionImpl(rs.state, rs.selectionStates, pid, zone);
  }

  function enterTowerSelection(): void {
    setupTowerSelection({
      state: rs.state,
      isHost: config.getIsHost(),
      myPlayerId: config.getMyPlayerId(),
      remoteHumanSlots: config.getRemoteHumanSlots(),
      controllers: rs.controllers,
      selectionStates: rs.selectionStates,
      initTowerSelection,
      syncSelectionOverlay,
      setOverlaySelection: () => { rs.overlay = { selection: { highlighted: null, selected: null } }; },
      selectTimer: SELECT_TIMER,
      accum: rs.accum,
      enterCastleReselectPhase,
      now: () => performance.now(),
      setModeSelection: () => { rs.mode = Mode.SELECTION; },
      setLastTime: (t) => { rs.lastTime = t; },
      requestFrame: () => {
        // Only schedule if the loop isn't already running (e.g., online mode starting from DOM lobby)
        if (rs.mode === Mode.STOPPED) requestAnimationFrame(mainLoop);
      },
      log: config.log,
    });
  }

  function syncSelectionOverlay(): void {
    syncSelectionOverlayImpl(rs.overlay, rs.selectionStates, (pid) => isHuman(rs.controllers[pid]!));
  }

  function highlightTowerForPlayer(idx: number, zone: number, pid: number): void {
    highlightTowerSelection(
      rs.state,
      rs.selectionStates,
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
      rs.state,
      rs.selectionStates,
      rs.controllers,
      pid,
      isReselect,
      config.send,
      (reselectPid) => {
        markPlayerReselected(rs.state, reselectPid);
        rs.reselectionPids.push(reselectPid);
      },
      () => syncSelectionOverlay(),
      () => render(),
    );
  }

  function allSelectionsConfirmed(): boolean {
    return allSelectionsConfirmedImpl(rs.selectionStates);
  }

  // -------------------------------------------------------------------------
  // Crosshairs / territory / human helpers
  // -------------------------------------------------------------------------

  function collectCrosshairs(canFireNow: boolean, dt = 0): void {
    const remoteHumanSlots = config.getRemoteHumanSlots();
    rs.frame.crosshairs = collectLocalCrosshairs({
      state: rs.state,
      controllers: rs.controllers,
      canFireNow,
      skipController: (pid) => remoteHumanSlots.has(pid),
      onCrosshairCollected: config.onLocalCrosshairCollected,
    });
    // Let caller extend crosshairs (e.g., add remote human crosshairs)
    if (config.extendCrosshairs) {
      rs.frame.crosshairs = config.extendCrosshairs(rs.frame.crosshairs, dt);
    }
  }

  function snapshotTerritory(): Set<number>[] {
    return snapshotTerritoryImpl(rs.state.players);
  }

  function firstHuman(): PlayerController | null {
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

  function withFirstHuman(action: (human: PlayerController) => void): void {
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
    myPlayerId, getEnemyZones, computeZoneBounds } = camera;


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
      collectCrosshairs(rs.state.battleCountdown <= 0);
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
      lifeLostMaxTimer: LIFE_LOST_MAX_TIMER,
      getLifeLostPanelPos: (playerId) => lifeLostPanelPosShared(rs.state, playerId),
    });

    // Status bar (rendered inside canvas)
    if (rs.overlay.ui) {
      rs.overlay.ui.statusBar = buildStatusBar(rs.state, PLAYER_COLORS);
    }

    // Add score deltas to overlay (shown during Place Cannons banner)
    if (rs.scoreDeltas.length > 0 && rs.overlay.ui) {
      rs.overlay.ui.scoreDeltas = rs.scoreDeltas;
    }

    renderMap(rs.state.map, canvas, rs.overlay, updateViewport());
    const inGame = rs.mode === Mode.GAME || rs.mode === Mode.BANNER || rs.mode === Mode.BALLOON_ANIM;
    const noBanner = rs.mode !== Mode.BANNER && rs.mode !== Mode.BALLOON_ANIM && rs.mode !== Mode.CASTLE_BUILD;
    const showZoom = noBanner && (rs.mode === Mode.GAME || rs.mode === Mode.SELECTION);
    const hasHuman = firstHuman() !== null;
    dpad?.update(hasHuman && (rs.mode === Mode.GAME || rs.mode === Mode.SELECTION) ? rs.state.phase : null);
    homeZoomButton?.update(showZoom ? rs.state.phase : null);
    enemyZoomButton?.update(showZoom ? rs.state.phase : null);
    quitButton?.update(inGame || rs.mode === Mode.SELECTION ? rs.state.phase : null);
  }

  function rematch() {
    camera.resetCamera();
    startGame();
    rs.mode = Mode.SELECTION;
  }

  function returnToLobby(): void {
    camera.unzoom();
    rs.mouseJoinedSlot = -1;
    // Hide all DOM buttons
    dpad?.update(null);
    homeZoomButton?.update(null);
    enemyZoomButton?.update(null);
    quitButton?.update(null);
    config.showLobby();
  }

  function endGame(winner: { id: number } | null) {
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
      focused: "rematch" as "rematch" | "menu",
    };
    render();
    rs.mode = Mode.STOPPED;
  }

  // -------------------------------------------------------------------------
  // Castle selection tick + finish
  // -------------------------------------------------------------------------

  function tickSelection(dt: number) {
    const remoteHumanSlots = config.getRemoteHumanSlots();
    tickSelectionPhase({
      dt,
      state: rs.state,
      isHost: config.getIsHost(),
      myPlayerId: config.getMyPlayerId(),
      selectTimer: SELECT_TIMER,
      accum: rs.accum,
      selectionStates: rs.selectionStates,
      remoteHumanSlots,
      controllers: rs.controllers,
      render,
      confirmSelectionForPlayer: (pid, isReselect) =>
        confirmSelectionForPlayer(pid, isReselect ?? false),
      allSelectionsConfirmed,
      finishReselection,
      finishSelection,
      syncSelectionOverlay,
      sendOpponentTowerSelected: (playerId, towerIdx, confirmed) => {
        config.send({
          type: MSG.OPPONENT_TOWER_SELECTED,
          playerId,
          towerIdx,
          confirmed,
        });
      },
    });
  }

  function clearOverlaySelection() {
    if (rs.overlay.selection) {
      rs.overlay.selection.highlights = undefined;
      rs.overlay.selection.highlighted = null;
      rs.overlay.selection.selected = null;
    }
  }

  function finishSelection() {
    finishSelectionPhase({
      state: rs.state,
      selectionStates: rs.selectionStates,
      clearOverlaySelection,
      animateCastleConstruction,
      advanceToCannonPhase,
    });
  }

  function animateCastleConstruction(onDone: () => void): void {
    const wallPlans = prepareCastleWalls(rs.state);
    if (config.getIsHost()) {
      config.send({
        type: MSG.CASTLE_WALLS,
        plans: wallPlans.map((p) => ({ playerId: p.playerId, tiles: p.tiles })),
      });
    }
    rs.castleBuild = createCastleBuildState(wallPlans, () => {
      finalizeCastleConstruction(rs.state);
      enterCannonPlacePhase(rs.state);
      camera.clearCastleBuildViewport();
      onDone();
    });
    // Pre-compute viewport covering all planned walls so camera stays steady
    camera.setCastleBuildViewport(wallPlans);
    render();
    rs.mode = Mode.CASTLE_BUILD;
  }

  function advanceToCannonPhase(): void {
    // Compute score deltas from the build phase (with display coordinates)
    rs.scoreDeltas = rs.state.players
      .map((p, i) => {
        const zone = rs.state.playerZones[i] ?? 0;
        const bounds = computeZoneBounds(zone);
        return {
          playerId: i, delta: p.score - (rs.preScores[i] ?? 0), total: p.score,
          cx: bounds.x + bounds.w / 2, cy: bounds.y + bounds.h / 2,
        };
      })
      .filter(d => d.delta > 0 && !rs.state.players[d.playerId]!.eliminated);

    advanceToCannonPlacePhase(rs.state);
    startCannonPhase();
    showBanner(BANNER_PLACE_CANNONS, () => { rs.scoreDeltaTimer = SCORE_DELTA_DISPLAY_TIME; rs.mode = Mode.GAME; }, false, undefined, BANNER_PLACE_CANNONS_SUB);
  }

  function tickCastleBuild(dt: number): void {
    const result = tickCastleBuildAnimation({
      castleBuild: rs.castleBuild, dt, wallBuildIntervalMs: WALL_BUILD_INTERVAL, state: rs.state, render,
    });
    rs.castleBuild = result.next;
    if (result.onDone) result.onDone();
  }

  // -------------------------------------------------------------------------
  // Reselection
  // -------------------------------------------------------------------------

  function startReselection() {
    const remoteHumanSlots = config.getRemoteHumanSlots();
    enterCastleReselectPhase(rs.state);
    rs.selectionStates.clear();
    rs.reselectionPids = [];

    const { remaining, needsUI } = processReselectionQueue({
      reselectQueue: rs.reselectQueue,
      state: rs.state,
      controllers: rs.controllers,
      initTowerSelection,
      processPlayer: (pid, ctrl, zone) => {
        if (remoteHumanSlots.has(pid)) return "pending" as const;
        const done = ctrl.reselect(rs.state, zone);
        return done ? "done" as const : "pending" as const;
      },
      onDone: (pid, ctrl) => {
        const player = rs.state.players[pid]!;
        if (player.homeTower) ctrl.centerOn(player.homeTower.row, player.homeTower.col);
        markPlayerReselected(rs.state, pid);
        rs.reselectionPids.push(pid);
      },
    });
    rs.reselectQueue = remaining.length > 0 ? remaining : [];

    if (needsUI) {
      syncSelectionOverlay();
      rs.accum.select = 0;
      rs.state.timer = SELECT_TIMER;
      rs.mode = Mode.SELECTION;
      if (config.getIsHost()) {
        config.send({ type: MSG.SELECT_START, timer: SELECT_TIMER });
      }
    } else {
      finishReselection();
    }
  }

  function finishReselection() {
    completeReselection({
      state: rs.state, selectionStates: rs.selectionStates, clearOverlaySelection,
      reselectQueue: rs.reselectQueue, reselectionPids: rs.reselectionPids, clearPlayerState,
      animateReselectionCastles, advanceToCannonPhase,
    });
  }

  function animateReselectionCastles(onDone: () => void): void {
    if (rs.reselectionPids.length === 0) {
      onDone();
      return;
    }

    const plans = prepareReselectionPlans(rs.state, rs.reselectionPids);
    rs.reselectionPids = [];
    if (config.getIsHost()) {
      config.send({
        type: MSG.CASTLE_WALLS,
        plans: plans.map((p) => ({ playerId: p.playerId, tiles: p.tiles })),
      });
    }

    if (plans.length === 0) {
      onDone();
      return;
    }

    rs.castleBuild = createCastleBuildState(plans, () => {
      finalizeCastleRebuild(rs.state, plans);
      camera.clearCastleBuildViewport();
      onDone();
    });
    camera.setCastleBuildViewport(plans);
    render();
    rs.mode = Mode.CASTLE_BUILD;
  }

  // -------------------------------------------------------------------------
  // Cannon phase
  // -------------------------------------------------------------------------

  function startCannonPhase() {
    const remoteHumanSlots = config.getRemoteHumanSlots();
    config.log(`startCannonPhase (round=${rs.state.round})`);
    initCannonPhase({
      state: rs.state,
      controllers: rs.controllers,
      skipController: (pid) => remoteHumanSlots.has(pid),
    });

    rs.accum.cannon = 0;
    rs.state.timer = rs.state.cannonPlaceTimer;
    if (config.getIsHost() && config.hostNetworking) {
      config.send(config.hostNetworking.buildCannonStartMessage(rs.state));
    }
    render();
  }

  // -------------------------------------------------------------------------
  // Battle
  // -------------------------------------------------------------------------

  function startBattle() {
    config.log(`startBattle (round=${rs.state.round})`);
    startHostBattleLifecycle({
      state: rs.state,
      battleAnim: rs.battleAnim,
      resolveBalloons,
      snapshotTerritory,
      showBanner,
      nextPhase,
      setModeBalloonAnim: () => { rs.mode = Mode.BALLOON_ANIM; },
      beginBattle,
      net: config.hostNetworking ? {
        isHost: config.getIsHost(),
        sendBattleStart: (flights) => {
          config.send(config.hostNetworking!.buildBattleStartMessage(rs.state, flights));
        },
      } : undefined,
    });
  }

  function tickBalloonAnim(dt: number) {
    tickHostBalloonAnim({
      dt,
      balloonFlightDuration: BALLOON_FLIGHT_DURATION,
      battleAnim: rs.battleAnim,
      render,
      beginBattle,
    });
  }

  function beginBattle() {
    beginHostBattle({
      state: rs.state,
      controllers: rs.controllers,
      accum: rs.accum,
      battleCountdown: BATTLE_COUNTDOWN,
      setModeGame: () => { rs.mode = Mode.GAME; },
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
    config.log(`startBuildPhase (round=${rs.state.round})`);
    // Snapshot scores before build phase for delta display
    rs.preScores = rs.state.players.map(p => p.score);
    rs.scoreDeltas = [];
    initBuildPhase(rs.state, rs.controllers, (pid) => remoteHumanSlots.has(pid) || !!rs.state.players[pid]?.eliminated);
    rs.battleAnim.impacts = [];
    rs.accum.grunt = 0;
    rs.accum.build = 0;
  }

  // -------------------------------------------------------------------------
  // Game loop — tick functions
  // -------------------------------------------------------------------------

  function tickCannonPhase(dt: number): boolean {
    // Fade out score deltas
    if (rs.scoreDeltaTimer > 0) {
      rs.scoreDeltaTimer -= dt;
      if (rs.scoreDeltaTimer <= 0) { rs.scoreDeltas = []; rs.scoreDeltaTimer = 0; }
    }
    return tickHostCannonPhase({
      dt, state: rs.state, accum: rs.accum, frame: rs.frame, controllers: rs.controllers, render, startBattle,
      net: {
        remoteHumanSlots: config.getRemoteHumanSlots(),
        isHost: config.getIsHost(),
        remoteCannonPhantoms: config.hostNetworking?.remoteCannonPhantoms() ?? [],
        lastSentCannonPhantom: config.hostNetworking?.lastSentCannonPhantom() ?? new Map(),
        autoPlaceCannons: config.hostNetworking?.autoPlaceCannons ?? (() => {}),
        sendOpponentCannonPlaced: (msg) => config.send({ type: MSG.OPPONENT_CANNON_PLACED, ...msg }),
        sendOpponentCannonPhantom: (msg) => config.send({ type: MSG.OPPONENT_CANNON_PHANTOM, ...msg }),
      },
    });
  }

  function tickBattleCountdown(dt: number): void {
    tickHostBattleCountdown({
      dt, state: rs.state, frame: rs.frame, controllers: rs.controllers, collectCrosshairs, render,
      net: { remoteHumanSlots: config.getRemoteHumanSlots() },
    });
  }

  function tickBattlePhase(dt: number): boolean {
    return tickHostBattlePhase({
      dt, state: rs.state, battleTimer: BATTLE_TIMER, accum: rs.accum, controllers: rs.controllers, battleAnim: rs.battleAnim,
      render, collectCrosshairs,
      collectTowerEvents: gruntAttackTowers,
      updateCannonballsWithEvents: updateCannonballs,
      onBattleEvents: (events) => {
        const pid = config.getMyPlayerId();
        const localPid = pid >= 0 ? pid : (firstHuman()?.playerId ?? -1);
        if (localPid >= 0) hapticBattleEvents(events as Array<{ type: string; playerId?: number; hp?: number }>, localPid);
        // Accumulate stats
        for (const evt of events as Array<{ type: string; playerId?: number; shooterId?: number; hp?: number; newHp?: number }>) {
          if (evt.type === MSG.WALL_DESTROYED && evt.shooterId !== undefined) {
            rs.gameStats[evt.shooterId]!.wallsDestroyed++;
          } else if (evt.type === MSG.CANNON_DAMAGED && evt.shooterId !== undefined && evt.newHp === 0) {
            rs.gameStats[evt.shooterId]!.cannonsKilled++;
          }
        }
      },
      onBattlePhaseEnded: () => {
        showBanner(
          BANNER_BUILD,
          () => {
            startBuildPhase();
            rs.mode = Mode.GAME;
          },
          true,
          undefined,
          BANNER_BUILD_SUB,
        );
        nextPhase(rs.state); // BATTLE -> WALL_BUILD
        if (config.getIsHost() && config.hostNetworking) {
          config.send(config.hostNetworking.buildBuildStartMessage(rs.state));
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
      dt, state: rs.state, accum: rs.accum, frame: rs.frame, controllers: rs.controllers, render,
      tickGrunts, isHuman, finalizeBuildPhase, showLifeLostDialog,
      afterLifeLostResolved: () => afterLifeLostResolved(),
      net: {
        remoteHumanSlots: config.getRemoteHumanSlots(),
        isHost: config.getIsHost(),
        remotePiecePhantoms: config.hostNetworking?.remotePiecePhantoms() ?? [],
        lastSentPiecePhantom: config.hostNetworking?.lastSentPiecePhantom() ?? new Map(),
        serializePlayers: config.hostNetworking?.serializePlayers ?? (() => []),
        sendOpponentPiecePlaced: (msg) => config.send({ type: MSG.OPPONENT_PIECE_PLACED, ...msg }),
        sendOpponentPhantom: (msg) => config.send({ type: MSG.OPPONENT_PHANTOM, ...msg }),
        sendBuildEnd: (msg) => config.send({ type: MSG.BUILD_END, ...msg }),
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
    rs.lifeLostDialog = buildLifeLostDialogState({
      needsReselect,
      eliminated,
      state: rs.state,
      isHost: config.getIsHost(),
      myPlayerId: config.getMyPlayerId(),
      remoteHumanSlots,
      isHumanController: (playerId) => isHuman(rs.controllers[playerId]!),
    });
    rs.mode = Mode.LIFE_LOST;
  }

  function tickLifeLostDialog(dt: number) {
    rs.lifeLostDialog = tickLifeLostDialogRuntime({
      dt,
      lifeLostDialog: rs.lifeLostDialog,
      lifeLostAiDelay: LIFE_LOST_AI_DELAY,
      lifeLostMaxTimer: LIFE_LOST_MAX_TIMER,
      state: rs.state,
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
          state: rs.state,
          afterLifeLostResolved,
        }),
      onNonHostResolved: () => {
        rs.mode = Mode.GAME;
      },
    });
  }

  function afterLifeLostResolved(continuing: number[] = []): boolean {
    return resolveAfterLifeLost({
      state: rs.state,
      continuing,
      onEndGame: endGame,
      onStartReselection: (players) => {
        rs.reselectQueue = players;
        startReselection();
        rs.mode = Mode.SELECTION;
      },
      onAdvanceToCannonPhase: advanceToCannonPhase,
    });
  }

  function lifeLostPanelPos(playerId: number): { px: number; py: number } {
    return lifeLostPanelPosShared(rs.state, playerId);
  }

  function sendLifeLostChoice(choice: "continue" | "abandon", playerId: number) {
    config.send({ type: MSG.LIFE_LOST_CHOICE, choice, playerId });
  }

  function lifeLostDialogClick(canvasX: number, canvasY: number) {
    if (!rs.lifeLostDialog) return;
    const mousePlayer = firstHuman();
    if (!mousePlayer) return;

    const choice = handleLifeLostDialogClickShared({
      state: rs.state,
      lifeLostDialog: rs.lifeLostDialog,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      canvasX,
      canvasY,
      firstHumanPlayerId: mousePlayer.playerId,
    });
    if (!choice) return;

    sendLifeLostChoice(choice.choice, choice.playerId);
  }

  // -------------------------------------------------------------------------
  // tickGame
  // -------------------------------------------------------------------------

  function tickGame(dt: number) {
    if (config.getIsHost()) {
      tickGameCore({
        dt,
        state: rs.state,
        battleAnim: rs.battleAnim,
        impactFlashDuration: IMPACT_FLASH_DURATION,
        tickCannonPhase,
        tickBattleCountdown,
        tickBattlePhase,
        tickBuildPhase,
      });
    } else {
      // Non-host: still age impacts, then delegate to config callback
      for (const imp of rs.battleAnim.impacts) imp.age += dt;
      rs.battleAnim.impacts = rs.battleAnim.impacts.filter(
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
    rs.reselectQueue = [];
    rs.reselectionPids = [];
    rs.battleAnim = createBattleAnimState();
    rs.accum = createTimerAccums();
    rs.banner = createBannerState();
    rs.lifeLostDialog = null;
    rs.paused = false;
    rs.quitPending = false;
    rs.optionsReturnMode = null;
    rs.castleBuild = null;
    rs.selectionStates.clear();
    rs.scoreDeltas = [];
    rs.scoreDeltaTimer = 0;
    rs.preScores = [];
  }

  // -------------------------------------------------------------------------
  // startGame
  // -------------------------------------------------------------------------

  function startGame() {
    const parsedSeed =
      rs.settings.seedMode === "custom" && rs.settings.seed
        ? parseInt(rs.settings.seed, 10)
        : NaN;
    const seed = isNaN(parsedSeed)
      ? Math.floor(Math.random() * 1000000)
      : parsedSeed;

    const diffParams = DIFFICULTY_PARAMS[rs.settings.difficulty] ?? DIFFICULTY_PARAMS[1]!;
    const { buildTimer, cannonPlaceTimer, firstRoundCannons } = diffParams;
    const roundsVal = ROUNDS_OPTIONS[rs.settings.rounds]!.value;

    resetGameStats();

    bootstrapGame({
      seed,
      maxPlayers: Math.min(MAX_PLAYERS, PLAYER_KEY_BINDINGS.length),
      battleLength: roundsVal,
      cannonMaxHp: CANNON_HP_OPTIONS[rs.settings.cannonHp]!.value,
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
        const strategySeed = isAi ? gameState.rng.int(0, 0xffffffff) : undefined;
        return createController(i, isAi, rs.settings.keyBindings[i]!, strategySeed);
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
      getGameOverFocused: () => rs.frame.gameOver?.focused ?? "rematch",
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
      lifeLostDialogClick,
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
      highlightTowerForPlayer,
      confirmSelectionForPlayer,
      finishReselection,
      finishSelection,
      isHost: config.getIsHost,
      togglePause,
      getQuitPending: () => rs.quitPending,
      setQuitPending: (v) => { rs.quitPending = v; },
      setQuitTimer: (s) => { rs.quitTimer = s; },
      setQuitMessage: (msg) => { rs.quitMessage = msg; },
      render,
      sendLifeLostChoice,
      settings: rs.settings,
    };
    registerOnlineInputHandlers(inputDeps);
    registerTouchHandlers({ ...inputDeps, lobbyKeyJoin: undefined });

    // D-pad + action buttons (mobile only)
    if (IS_TOUCH_DEVICE) {
      const placePiece = inputDeps.tryPlacePieceAndSend;
      const placeCannon = inputDeps.tryPlaceCannonAndSend;
      dpad = createDpad({
        getState: () => rs.state,
        withFirstHuman,
        tryPlacePieceAndSend: placePiece,
        tryPlaceCannonAndSend: placeCannon,
        getSelectionStates: () => rs.selectionStates,
        highlightTowerForPlayer,
        confirmSelectionForPlayer,
        finishSelection,
        finishReselection,
        isHost: config.getIsHost,
        render,
        getLeftHanded: () => rs.settings.leftHanded,
      });
      const zoomDeps = {
        getState: () => rs.state,
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
    getQuitPending: () => rs.quitPending,
    setQuitPending: (v) => { rs.quitPending = v; },
    setQuitTimer: (v) => { rs.quitTimer = v; },
    setQuitMessage: (msg) => { rs.quitMessage = msg; },
    showLobby: returnToLobby,
    getControllers: () => rs.controllers,
    isHuman,
    render,
  });

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

    collectCrosshairs,
    snapshotTerritory,
    firstHuman,
    withFirstHuman,

    render,
    endGame,

    startCannonPhase,
    startBattle,
    tickBalloonAnim,
    beginBattle,
    startBuildPhase,

    tickCannonPhase,
    tickBattleCountdown,
    tickBattlePhase,
    tickBuildPhase,

    tickGame,
    resetUIState,
    startGame,

    uiCtx,
    registerInputHandlers,

    // Sub-systems
    selection: {
      getStates: () => rs.selectionStates,
      init: initTowerSelection,
      enter: enterTowerSelection,
      syncOverlay: syncSelectionOverlay,
      highlight: highlightTowerForPlayer,
      confirm: confirmSelectionForPlayer,
      allConfirmed: allSelectionsConfirmed,
      tick: tickSelection,
      finish: finishSelection,
      animateCastle: animateCastleConstruction,
      advanceToCannonPhase,
      tickCastleBuild,
      startReselection,
      finishReselection,
      animateReselectionCastles,
    },

    lifeLost: {
      get: () => rs.lifeLostDialog,
      set: (d: LifeLostDialogState | null) => { rs.lifeLostDialog = d; },
      show: showLifeLostDialog,
      tick: tickLifeLostDialog,
      afterResolved: afterLifeLostResolved,
      panelPos: lifeLostPanelPos,
      click: lifeLostDialogClick,
    },
  };
}
