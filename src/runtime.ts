/**
 * Shared game runtime factory — consolidates all orchestration code
 * from main.ts (local) and online-client.ts (online).
 *
 * createGameRuntime(config) returns a RuntimeState bag (rs) plus
 * methods that operate on it. See runtime-state.ts for the state type.
 */

import { createController } from "./controller-factory.ts";
import {
  type InputReceiver,
  isHuman,
  type PlayerController,
} from "./controller-interfaces.ts";
import { computeFrameContext } from "./game-ui-frame.ts";
import {
  snapshotTerritory as snapshotTerritoryImpl,
  tickMainLoop,
} from "./game-ui-helpers.ts";
import { type UIContext, visibleOptions } from "./game-ui-screens.ts";
import {
  CANNON_HP_OPTIONS,
  DIFFICULTY_PARAMS,
  ROUNDS_OPTIONS,
} from "./game-ui-types.ts";
import { GRID_COLS, GRID_ROWS, SCALE, TILE_SIZE } from "./grid.ts";
import { createHapticsSystem } from "./haptics-system.ts";
import {
  type RegisterOnlineInputDeps,
  registerOnlineInputHandlers,
} from "./input.ts";
import { dispatchPointerMove } from "./input-dispatch.ts";
import { registerTouchHandlers } from "./input-touch.ts";
import {
  createDpad,
  createEnemyZoomButton,
  createFloatingActions,
  createHomeZoomButton,
  createQuitButton,
} from "./input-touch-ui.ts";
import { LifeLostChoice } from "./life-lost.ts";
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
import {
  createBannerUi,
  createOnlineOverlay,
  createRenderSummaryMessage,
  createStatusBar,
  gameOverButtonHitTest,
} from "./render-composition.ts";
import type { MapData, RenderOverlay, Viewport } from "./render-types.ts";
import { MAX_UINT32 } from "./rng.ts";
import { bootstrapGame } from "./runtime-bootstrap.ts";
import { createCameraSystem } from "./runtime-camera.ts";
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
  createBattleAnimState,
  createTimerAccums,
  FOCUS_MENU,
  FOCUS_REMATCH,
  type GameState,
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

  // DOM-only locals (not shared with consumers)
  let dpad: ReturnType<typeof createDpad> | null = null;
  let floatingActions: ReturnType<typeof createFloatingActions> | null = null;
  let homeZoomButton: ReturnType<typeof createHomeZoomButton> | null = null;
  let enemyZoomButton: ReturnType<typeof createEnemyZoomButton> | null = null;
  let quitButton: ReturnType<typeof createQuitButton> | null = null;
  let loupeHandle: ReturnType<NonNullable<typeof renderer.createLoupe>> | null =
    null;

  function resetGameStats() {
    rs.gameStats = Array.from({ length: MAX_PLAYERS }, () => ({
      wallsDestroyed: 0,
      cannonsKilled: 0,
    }));
  }

  // -------------------------------------------------------------------------
  // Frame/timing helpers
  // -------------------------------------------------------------------------

  function resetFrame(): void {
    const { gameOver } = rs.frame;
    rs.frame = { crosshairs: [], phantoms: {} };
    if (gameOver) rs.frame.gameOver = gameOver;
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
  // Rendering helpers
  // -------------------------------------------------------------------------

  function renderFrame(
    map: MapData,
    overlay: RenderOverlay | undefined,
    viewport?: Viewport | null,
  ): void {
    renderer.drawFrame(map, overlay, viewport);
  }

  // -------------------------------------------------------------------------
  // Lobby (delegated to runtime-lobby.ts)
  // -------------------------------------------------------------------------

  function isSelectionReady(): boolean {
    return rs.accum.selectAnnouncement >= SELECT_ANNOUNCEMENT_DURATION;
  }

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
  // Options / Controls / Pause (delegated to runtime-options.ts)
  // -------------------------------------------------------------------------

  // Options system is created after uiCtx is defined (forward reference).
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

  function firstHuman(): (PlayerController & InputReceiver) | null {
    // Prefer the player who joined via mouse/trackpad
    if (rs.mouseJoinedSlot >= 0) {
      const ctrl = rs.controllers.find(
        (c) => c.playerId === rs.mouseJoinedSlot,
      );
      if (ctrl && isHuman(ctrl) && !rs.state.players[ctrl.playerId]?.eliminated)
        return ctrl;
    }
    for (const ctrl of rs.controllers) {
      if (isHuman(ctrl) && !rs.state.players[ctrl.playerId]?.eliminated)
        return ctrl;
    }
    return null;
  }

  function withFirstHuman(
    action: (human: PlayerController & InputReceiver) => void,
  ): void {
    const human = firstHuman();
    if (!human) return;
    action(human);
  }

  // -------------------------------------------------------------------------
  // Sound wrappers for placement actions (local + online)
  // -------------------------------------------------------------------------

  type PlacePieceFn = (
    ctrl: PlayerController & InputReceiver,
    gs: GameState,
  ) => boolean;
  type PlaceCannonFn = (
    ctrl: PlayerController & InputReceiver,
    gs: GameState,
    max: number,
  ) => boolean;

  function wrapPiecePlace(inner: PlacePieceFn): PlacePieceFn {
    return (ctrl, gs) => {
      const ok = inner(ctrl, gs);
      if (ok) sound.piecePlaced();
      else sound.pieceFailed();
      return ok;
    };
  }

  function wrapCannonPlace(inner: PlaceCannonFn): PlaceCannonFn {
    return (ctrl, gs, max) => {
      const ok = inner(ctrl, gs, max);
      if (ok) sound.cannonPlaced();
      return ok;
    };
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

  // Re-export camera functions used by other parts of the runtime
  const {
    tickCamera,
    updateViewport,
    screenToWorld,
    pixelToTile,
    onPinchStart,
    onPinchUpdate,
    onPinchEnd,
    myPlayerId,
    getEnemyZones,
  } = camera;

  // -------------------------------------------------------------------------
  // Selection sub-system (delegated to runtime-selection.ts)
  // -------------------------------------------------------------------------

  const selection: SelectionSystem = createSelectionSystem({
    rs,
    send: config.send,
    log: config.log,
    onSelectionStart: sound.drumsStart,
    onCastleBuildDone: (pids) => {
      for (const pid of pids) sound.chargeFanfare(pid);
    },
    lightUnzoom: () => camera.lightUnzoom(),
    clearCastleBuildViewport: () => camera.clearCastleBuildViewport(),
    setCastleBuildViewport: (plans) => camera.setCastleBuildViewport(plans),
    setSelectionViewport: (row, col) => camera.setSelectionViewport(row, col),
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
      dpad,
      floatingActions,
      homeZoomButton,
      enemyZoomButton,
      quitButton,
      loupeHandle,
      worldToScreen: camera.worldToScreen,
      screenToContainerCSS: renderer.screenToContainerCSS,
      containerHeight: gameContainer.clientHeight,
    });
  }

  function rematch() {
    camera.resetCamera();
    rs.frame.gameOver = undefined;
    startGame();
    rs.mode = Mode.SELECTION;
    rs.lastTime = performance.now();
    requestAnimationFrame(mainLoop);
  }

  function gameOverClick(canvasX: number, canvasY: number): void {
    const gameOver = rs.frame.gameOver;
    if (!gameOver) return;
    const W = GRID_COLS * TILE_SIZE;
    const H = GRID_ROWS * TILE_SIZE;
    const hit = gameOverButtonHitTest(
      canvasX / SCALE,
      canvasY / SCALE,
      W,
      H,
      gameOver,
    );
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
    loupeHandle?.update(false, 0, 0); // hide loupe before lobby takes over rendering
    config.showLobby();
  }

  function endGame(winner: { id: number } | null) {
    rs.scoreDeltaOnDone = null;
    camera.unzoom();
    config.onEndGame?.(winner, rs.state);
    sound.reset();
    sound.gameOver();
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
    ...config,
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
    lastBattleCrosshair = null;
    resetGameStats();
    camera.resetCamera();
    sound.reset();
  }

  // -------------------------------------------------------------------------
  // startGame
  // -------------------------------------------------------------------------

  function startGame() {
    const seed = rs.lobby.seed;

    const diffParams =
      DIFFICULTY_PARAMS[rs.settings.difficulty] ?? DIFFICULTY_PARAMS[1]!;
    const { buildTimer, cannonPlaceTimer, firstRoundCannons } = diffParams;
    const roundsParam =
      typeof location !== "undefined"
        ? Number(new URL(location.href).searchParams.get("rounds"))
        : 0;
    const roundsVal =
      roundsParam > 0
        ? roundsParam
        : (ROUNDS_OPTIONS[rs.settings.rounds] ?? ROUNDS_OPTIONS[0]!).value;

    bootstrapGame({
      seed,
      maxPlayers: Math.min(MAX_PLAYERS, PLAYER_KEY_BINDINGS.length),
      battleLength: roundsVal,
      cannonMaxHp: (
        CANNON_HP_OPTIONS[rs.settings.cannonHp] ?? CANNON_HP_OPTIONS[0]!
      ).value,
      buildTimer,
      cannonPlaceTimer,
      log: config.log,
      resetFrame,
      setState: (s: GameState) => {
        s.firstRoundCannons = firstRoundCannons;
        rs.state = s;
      },
      setControllers: (c: readonly PlayerController[]) => {
        rs.controllers = [...c];
      },
      resetUIState,
      createControllerForSlot: (i: number, gameState: GameState) => {
        const isAi = !rs.lobby.joined[i];
        const strategySeed = isAi
          ? gameState.rng.int(0, MAX_UINT32)
          : undefined;
        return createController(
          i,
          isAi,
          rs.settings.keyBindings[i]!,
          strategySeed,
          rs.settings.difficulty,
        );
      },
      enterSelection: () => selection.enter(),
    });
  }

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
    getLobbyRemaining: () => config.getLobbyRemaining(),
    isOnline: !!config.isOnline,
  };

  // Initialize options system first (lobby depends on showOptions)
  options = createOptionsSystem({
    rs,
    uiCtx,
    renderFrame,
    updateDpad: (phase) => dpad?.update(phase),
    setDpadLeftHanded: (left) => dpad?.setLeftHanded(left),
    refreshLobbySeed: () => lobby.refreshLobbySeed(),
    setSoundLevel: sound.setLevel,
    setHapticsLevel: haptics.setLevel,
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
  // Input handlers registration
  // -------------------------------------------------------------------------

  function registerInputHandlers(): void {
    const inputDeps: RegisterOnlineInputDeps = {
      renderer,
      getState: () => rs.state,
      getMode: () => rs.mode,
      setMode: (m) => {
        rs.mode = m as Mode;
      },
      modeValues: {
        LOBBY: Mode.LOBBY,
        OPTIONS: Mode.OPTIONS,
        CONTROLS: Mode.CONTROLS,
        SELECTION: Mode.SELECTION,
        BANNER: Mode.BANNER,
        BALLOON_ANIM: Mode.BALLOON_ANIM,
        CASTLE_BUILD: Mode.CASTLE_BUILD,
        LIFE_LOST: Mode.LIFE_LOST,
        GAME: Mode.GAME,
        STOPPED: Mode.STOPPED,
      },
      isLobbyActive: () => rs.lobby.active,
      lobbyKeyJoin: (key: string) => lobby.lobbyKeyJoin(key),
      lobbyClick: (x: number, y: number) => lobby.lobbyClick(x, y),
      showLobby: returnToLobby,
      rematch,
      getGameOverFocused: () => rs.frame.gameOver?.focused ?? FOCUS_REMATCH,
      setGameOverFocused: (f) => {
        if (rs.frame.gameOver) {
          rs.frame.gameOver.focused = f;
          render();
        }
      },
      gameOverClick,
      showOptions: options.showOptions,
      closeOptions: options.closeOptions,
      showControls: options.showControls,
      closeControls: options.closeControls,
      getOptionsCursor: () => rs.optionsCursor,
      setOptionsCursor: (c) => {
        rs.optionsCursor = c;
      },
      getOptionsCount: () => visibleOptions(uiCtx).length,
      getRealOptionIdx: options.realOptionIdx,
      getOptionsReturnMode: () => rs.optionsReturnMode,
      setOptionsReturnMode: (m) => {
        rs.optionsReturnMode = m as Mode | null;
      },
      changeOption: options.changeOption,
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
      tryPlaceCannonAndSend: wrapCannonPlace(
        config.tryPlaceCannonAndSend ??
          ((ctrl, gs, max) => ctrl.tryPlaceCannon(gs, max)),
      ),
      tryPlacePieceAndSend: wrapPiecePlace(
        config.tryPlacePieceAndSend ?? ((ctrl, gs) => ctrl.tryPlacePiece(gs)),
      ),
      fireAndSend:
        config.fireAndSend ?? ((ctrl, gameState) => ctrl.fire(gameState)),
      onPieceRotated: sound.pieceRotated,
      getSelectionStates: () => rs.selectionStates,
      highlightTowerForPlayer: selection.highlight,
      confirmSelectionForPlayer: selection.confirm,
      isSelectionReady,
      togglePause: options.togglePause,
      getQuitPending: () => rs.quitPending,
      setQuitPending: (v) => {
        rs.quitPending = v;
      },
      setQuitTimer: (s) => {
        rs.quitTimer = s;
      },
      setQuitMessage: (msg) => {
        rs.quitMessage = msg;
      },
      sendLifeLostChoice: lifeLost.sendLifeLostChoice,
      setDirectTouchActive: (v) => {
        rs.directTouchActive = v;
      },
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
      dpad = createDpad(
        {
          getState: () => rs.state,
          getMode: () => rs.mode,
          modeValues: {
            GAME: Mode.GAME,
            SELECTION: Mode.SELECTION,
            LOBBY: Mode.LOBBY,
          },
          withFirstHuman,
          tryPlacePieceAndSend: placePiece,
          tryPlaceCannonAndSend: placeCannon,
          fireAndSend: inputDeps.fireAndSend,
          onPieceRotated: sound.pieceRotated,
          onHapticTap: haptics.tap,
          getSelectionStates: () => rs.selectionStates,
          highlightTowerForPlayer: selection.highlight,
          confirmSelectionForPlayer: selection.confirm,
          isHost: config.getIsHost,
          lobbyAction: () =>
            lobby.lobbyKeyJoin(rs.settings.keyBindings[0]!.confirm),
          getLeftHanded: () => rs.settings.leftHanded,
          clearDirectTouch: () => {
            rs.directTouchActive = false;
          },
          isSelectionReady,
          options: {
            isActive: () => rs.mode === Mode.OPTIONS,
            navigate: (dir) => {
              const count = visibleOptions(uiCtx).length;
              rs.optionsCursor = (rs.optionsCursor + dir + count) % count;
            },
            changeValue: (dir) => options.changeOption(dir),
            confirm: () => {
              if (options.realOptionIdx() === 5) options.showControls();
              else options.closeOptions();
            },
          },
          lifeLost: {
            isActive: () =>
              rs.mode === Mode.LIFE_LOST && rs.lifeLostDialog !== null,
            toggleFocus: () => {
              const human = firstHuman();
              if (!human || !rs.lifeLostDialog) return;
              const entry = rs.lifeLostDialog.entries.find(
                (e) =>
                  e.playerId === human.playerId &&
                  e.choice === LifeLostChoice.PENDING,
              );
              if (entry) entry.focused = entry.focused === 0 ? 1 : 0;
            },
            confirm: () => {
              const human = firstHuman();
              if (!human || !rs.lifeLostDialog) return;
              const entry = rs.lifeLostDialog.entries.find(
                (e) =>
                  e.playerId === human.playerId &&
                  e.choice === LifeLostChoice.PENDING,
              );
              if (!entry) return;
              entry.choice =
                entry.focused === 0
                  ? LifeLostChoice.CONTINUE
                  : LifeLostChoice.ABANDON;
              lifeLost.sendLifeLostChoice(entry.choice, entry.playerId);
            },
          },
          gameOver: {
            isActive: () =>
              rs.mode === Mode.STOPPED && rs.frame.gameOver !== undefined,
            toggleFocus: () => {
              if (!rs.frame.gameOver) return;
              rs.frame.gameOver.focused =
                rs.frame.gameOver.focused === FOCUS_REMATCH
                  ? FOCUS_MENU
                  : FOCUS_REMATCH;
              render();
            },
            confirm: () => {
              if (!rs.frame.gameOver) return;
              if (rs.frame.gameOver.focused === FOCUS_REMATCH) rematch();
              else returnToLobby();
            },
          },
        },
        gameContainer,
      );
      dpad.update(null); // initial state: d-pad + rotate disabled
      const zoomDeps = {
        getState: () => rs.state,
        getCameraZone: camera.getCameraZone,
        setCameraZone: camera.setCameraZone,
        myPlayerId,
        getEnemyZones,
        aimAtZone: (zone: number) => {
          if (!rs.state) return;
          const human = firstHuman();
          if (!human) return;
          const pid = rs.state.playerZones.indexOf(zone);
          const tower = pid >= 0 ? rs.state.players[pid]?.homeTower : null;
          if (!tower) return;
          const px = towerCenterPx(tower);
          human.setCrosshair(px.x, px.y);
        },
      };
      loupeHandle = renderer.createLoupe?.(gameContainer) ?? null;
      quitButton = createQuitButton(
        {
          getQuitPending: () => rs.quitPending,
          setQuitPending: (v: boolean) => {
            rs.quitPending = v;
          },
          setQuitTimer: (v: number) => {
            rs.quitTimer = v;
          },
          setQuitMessage: (msg: string) => {
            rs.quitMessage = msg;
          },
          showLobby: returnToLobby,
          getControllers: () => rs.controllers,
          isHuman,
        },
        gameContainer,
      );
      quitButton.update(null); // initial state: hidden
      homeZoomButton = createHomeZoomButton(zoomDeps, gameContainer);
      enemyZoomButton = createEnemyZoomButton(zoomDeps, gameContainer);
      homeZoomButton.update(false); // initial state: disabled
      enemyZoomButton.update(false);
      camera.enableMobileZoom();

      // Floating contextual buttons for direct-touch placement
      const floatingEl =
        gameContainer.querySelector<HTMLElement>("#floating-actions");
      if (floatingEl) {
        floatingActions = createFloatingActions(
          {
            getState: () => rs.state,
            withFirstHuman,
            tryPlacePieceAndSend: inputDeps.tryPlacePieceAndSend,
            tryPlaceCannonAndSend: inputDeps.tryPlaceCannonAndSend,
            onPieceRotated: sound.pieceRotated,
            onHapticTap: haptics.tap,
            onDrag: (clientX, clientY) => {
              const state = rs.state;
              if (!state) return;
              const { x, y } = renderer.clientToSurface(clientX, clientY);
              dispatchPointerMove(x, y, state, inputDeps);
            },
          },
          floatingEl,
        );
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

    renderLobby: lobby.renderLobby,
    tickLobby: lobby.tickLobby,
    lobbyKeyJoin: lobby.lobbyKeyJoin,
    lobbyClick: lobby.lobbyClick,

    changeOption: options.changeOption,
    renderOptions: options.renderOptions,
    showOptions: options.showOptions,
    closeOptions: options.closeOptions,

    renderControls: options.renderControls,
    showControls: options.showControls,
    closeControls: options.closeControls,
    togglePause: options.togglePause,

    showBanner,
    tickBanner,

    syncCrosshairs: phaseTicks.syncCrosshairs,
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
    sound,
    haptics,
  };
}
