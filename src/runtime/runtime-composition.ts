/**
 * Composition root for the game runtime.
 *
 * This is the ONE file in `src/runtime/` allowed to cross the runtime
 * purity contract. Every other runtime/ file imports only from shared/,
 * game/, and player/ (for controller factories), so the runtime domain
 * stays headless-testable. This file is the wiring seam where input,
 * render, ai, player, and game subsystems assemble into a GameRuntime
 * handle — its "roots" tier classification in .import-layers.json
 * exempts it from typeOnlyFrom restrictions (see lint-domain-boundaries.ts).
 *
 * When adding new runtime code: if it needs input/render/ai/online
 * imports, it almost certainly belongs here (or in a subsystem factory
 * whose deps are injected through this file). If it only needs shared/
 * and game/, put it in a new runtime-*.ts sibling.
 *
 * createGameRuntime(config) creates all subsystems (camera, score-delta,
 * banner, selection, render, lifecycle, life-lost, upgrade-pick, phase-ticks,
 * lobby, options, input, human-lookup), wires their deps, and returns a
 * narrow GameRuntime handle.
 *
 * Callers: src/main.ts (local), src/online/online-runtime-game.ts (online
 * host + watcher), test/runtime-headless.ts (tests).
 */

import {
  executeCannonFire,
  executePlacePiece,
  generateMap,
  snapshotTerritory,
} from "../game/index.ts";
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
import {
  type GameMessage,
  MESSAGE,
  type ServerMessage,
} from "../protocol/protocol.ts";
import { createRender3d } from "../render/3d/renderer.ts";
import {
  buildGameOverOverlay,
  computeLobbyLayout,
  createBannerUi,
  createOnlineOverlay,
  createRenderSummaryMessage,
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
import { SELECT_ANNOUNCEMENT_DURATION } from "../shared/core/game-constants.ts";
import { GAME_EVENT } from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { GameMap, Viewport } from "../shared/core/geometry-types.ts";
import { MAP_PX_H, MAP_PX_W, SCALE } from "../shared/core/grid.ts";
import {
  SPECTATOR_SLOT,
  type ValidPlayerSlot,
} from "../shared/core/player-slot.ts";
import { selectRenderView } from "../shared/core/render-view.ts";
import { IS_DEV, IS_TOUCH_DEVICE } from "../shared/platform/platform.ts";
import { assertNever } from "../shared/platform/utils.ts";
import type {
  RendererInterface,
  RenderOverlay,
} from "../shared/ui/overlay-types.ts";
import {
  computeGameSeed,
  MAX_SEED_LENGTH,
  SEED_CUSTOM,
} from "../shared/ui/player-config.ts";
import { cycleOption } from "../shared/ui/settings-ui.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import { createRuntimeInputAdapters, createRuntimeLoop } from "./assembly.ts";
import { exposeDevConsole } from "./dev-console.ts";
import { loadStoredAssets, type MusicAssets } from "./music-assets.ts";
import { createMusicSubsystem } from "./music-player.ts";
import { createBannerSystem } from "./runtime-banner.ts";
import { bootstrapNewGameFromSettings } from "./runtime-bootstrap.ts";
import { createBrowserTimingApi } from "./runtime-browser-timing.ts";
import { createCameraSystem } from "./runtime-camera.ts";
import type { TimingApi, UIContext } from "./runtime-contracts.ts";
import { exposeE2EBridge } from "./runtime-e2e-bridge.ts";
import {
  buildLifecycleDeps,
  createGameLifecycle,
} from "./runtime-game-lifecycle.ts";
import { createHapticsSubsystem } from "./runtime-haptics.ts";
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
import {
  createRuntimeState,
  isPaused,
  isStateReady,
  safeState,
  setMode,
} from "./runtime-state.ts";
import type {
  GameRuntime,
  NetworkApi,
  RuntimeConfig,
} from "./runtime-types.ts";
import {
  createUpgradePickSystem,
  type UpgradePickSystem,
} from "./runtime-upgrade-pick.ts";
import { createSfxSubsystem } from "./sfx-player.ts";
import { createSoundModal } from "./sound-modal.ts";

/** Singleton empty set so repeated calls with no remotes return the same
 *  instance — runtime sub-systems read this through the `NetworkApi.remotePlayerSlots`
 *  seam, which is `ReadonlySet<ValidPlayerSlot>`, so the shared instance is
 *  immutable from every caller's perspective. */
const EMPTY_REMOTE_SLOTS: ReadonlySet<ValidPlayerSlot> = new Set();
/** Explicit no-op sender for pure-local play (no peers to notify).
 *  Named so call sites communicate intent rather than silently swallow
 *  messages via a default. */
export const noopNetworkSend: (msg: GameMessage) => void = () => {};

/**
 * Browser-side bindings for `RuntimeConfig`.
 *
 * Both production entry points (local: src/main.ts; online:
 * src/online/online-runtime-game.ts) need to wire the same three
 * browser primitives into `createGameRuntime`: a canvas renderer,
 * a `TimingApi` backed by `performance.now`/`requestAnimationFrame`,
 * and the document as the keyboard event source. This factory is
 * the single seam that names them. Tests construct stubs directly
 * via `test/runtime-headless.ts` and never call this.
 *
 * Lives in the composition root because it value-imports
 * `createRender3d` from `render/`, which is type-only for other
 * runtime files.
 */
export function createBrowserRuntimeBindings(
  uiCanvas: HTMLCanvasElement,
  worldCanvas: HTMLCanvasElement,
): {
  renderer: RendererInterface;
  timing: TimingApi;
  keyboardEventSource: Document;
} {
  return {
    renderer: createRender3d(worldCanvas, uiCanvas),
    timing: createBrowserTimingApi(),
    keyboardEventSource: document,
  };
}

/**
 * `NetworkApi` factory for the "no peers" wiring shape shared by local
 * play (src/main.ts) and the headless test runtime (test/runtime-headless.ts).
 *
 * The base shape is: `amHost=true`, `myPlayerId=SPECTATOR_SLOT`, empty
 * remotes, no-op `onMessage`. `send` is REQUIRED — callers must pass an
 * explicit sender (or the named `noopNetworkSend` for pure-local play)
 * so a test that forgets to wire the network seam fails loudly instead
 * of silently dropping every message. Callers can override `onMessage`
 * (e.g. headless in-memory loopback) and `remotePlayerSlots` (e.g.
 * headless simulating a peer machine). Online play
 * (src/online/online-runtime-game.ts) does NOT use this factory — it
 * builds its own `NetworkApi` backed by the WebSocket client session.
 */
export function createLocalNetworkApi(opts: {
  send: (msg: GameMessage) => void;
  onMessage?: (
    handler: (msg: ServerMessage) => void | Promise<void>,
  ) => () => void;
  remotePlayerSlots?: ReadonlySet<ValidPlayerSlot>;
}): NetworkApi {
  const remotes = opts.remotePlayerSlots ?? EMPTY_REMOTE_SLOTS;
  return {
    send: opts.send,
    onMessage: opts.onMessage ?? (() => () => {}),
    amHost: () => true,
    myPlayerId: () => SPECTATOR_SLOT,
    remotePlayerSlots: () => remotes,
  };
}

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
  const haptics = createHapticsSubsystem({
    getLevel: () => runtimeState.settings.haptics,
    getPovPlayerId: () => runtimeState.frameMeta.povPlayerId,
    observer: config.observers?.haptics,
  });
  // Music assets are loaded asynchronously from IndexedDB (null until ready / if
  // the player hasn't dropped Rampart files into the settings dialog). The
  // subsystem reads the slot live on every `activate()` / `subscribeBus()`, so
  // files loaded later automatically take effect on the next game.
  let musicAssets: MusicAssets | undefined;
  const musicAssetsReady = loadStoredAssets()
    .then((assets) => {
      musicAssets = assets;
    })
    .catch((error) => {
      console.error("[music] loadStoredAssets failed:", error);
    });
  const music = createMusicSubsystem({
    getAssets: () => musicAssets,
    assetsReady: musicAssetsReady,
    observer: config.observers?.music,
  });
  // SFX lives in a separate AudioContext from the music synth — Web Audio
  // natively polyphonic via BufferSource-per-trigger, so fast-firing events
  // (wallPlaced on each brick) overlap cleanly. Silent until SOUND.RSC is
  // loaded into IDB; bus subscription is re-established on every new game.
  const sfx = createSfxSubsystem({
    getAssets: () => musicAssets,
    assetsReady: musicAssetsReady,
    observer: config.observers?.sfx,
    getState: () => safeState(runtimeState),
    // First tower enclosure of a phase → player-specific fanfare sub-song.
    // SFX has already played elechit1 and delayed the callback by the
    // stinger's duration, so the fanfare lands cleanly after it.
    onFirstEnclosure: (playerId) => void music.playFanfare(playerId),
  });
  // The Sound modal (URL field + file pickers) lives in index.html. Headless
  // tests run without DOM — skip construction and pass a no-op opener so the
  // options screen still renders the row (it just won't open anything there).
  const soundModal =
    typeof document !== "undefined" && document.getElementById("sound-modal")
      ? createSoundModal()
      : undefined;
  soundModal?.setOnClose((assets) => {
    musicAssets = assets;
    // SOUND.RSC bytes may have changed — drop the cached sample map so the
    // next SFX event reparses. Music doesn't need an equivalent because
    // music-player loads XMI data on synth init and a rematch rebuilds it.
    sfx.refreshSamples();
    // If assets were just loaded and the lobby is showing the title screen,
    // kick off playback. Safe to call repeatedly — the subsystem is idempotent
    // and no-ops when already playing or when assets are still missing.
    if (assets && runtimeState.mode === Mode.LOBBY) {
      void music.startTitle();
    }
  });
  // Pause music (and the game loop) when the tab is backgrounded, resume on
  // return. rAF throttling already freezes the game on hidden tabs, but music
  // keeps looping on Web Audio — not acceptable for a single ~30s title track
  // playing for hours on a stale tab. The `pausedBy` discriminant on
  // runtimeState ensures reopening a manually-paused game stays paused:
  // we only claim the pause when nothing else holds it, and on return we
  // only release it if the current reason is still "visibility" (never
  // overriding a user pause). Initial call also covers the dev hot-reload
  // case of starting in a hidden tab.
  function applyVisibility(): void {
    const hidden = typeof document !== "undefined" && document.hidden;
    if (hidden && runtimeState.pausedBy === "none") {
      runtimeState.pausedBy = "visibility";
    } else if (!hidden && runtimeState.pausedBy === "visibility") {
      runtimeState.pausedBy = "none";
    }
    void music.setPaused(hidden);
    void sfx.setPaused(hidden);
  }
  applyVisibility();
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", applyVisibility);
  }

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

  /** Refresh lobby seed + map preview when the seed changed *or* no map
   *  preview exists yet. The second condition covers first-entry bootstrap
   *  when `computeGameSeed()` happens to match the initial `lobby.seed = 0`
   *  (user picked seed "0" via localStorage) — without the null check, the
   *  seed-equality branch skips map generation and `lobby.map` stays null
   *  through the first lobby render, crashing `drawMap`. */
  function refreshLobbySeed(): void {
    const newSeed = computeGameSeed(runtimeState.settings);
    if (
      newSeed !== runtimeState.lobby.seed ||
      runtimeState.lobby.map === null
    ) {
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

  // Single-switch dispatch for the per-frame mode tick. Centralizes the
  // mapping from Mode → tick handler with an exhaustive `default` branch
  // so an unhandled Mode is a loud failure rather than a silent no-op.
  // Adding a new Mode is a compile error here (assertNever) AND at the
  // call site (TickableMode-typed parameter in tickMainLoop).
  function tickMode(mode: Exclude<Mode, Mode.STOPPED>, dt: number): void {
    switch (mode) {
      case Mode.LOBBY:
        lobby.tickLobby(dt);
        lobby.renderLobby();
        return;
      case Mode.OPTIONS:
        options.renderOptions();
        return;
      case Mode.CONTROLS:
        options.renderControls();
        return;
      case Mode.SELECTION:
        selection.tick(dt);
        return;
      case Mode.TRANSITION:
        tickBanner(dt);
        return;
      case Mode.BALLOON_ANIM:
        phaseTicks.tickBalloonAnim(dt);
        return;
      case Mode.CASTLE_BUILD:
        selection.tickCastleBuild(dt);
        return;
      case Mode.LIFE_LOST:
        lifeLost.tick(dt);
        return;
      case Mode.UPGRADE_PICK:
        upgradePick.tick(dt);
        return;
      case Mode.GAME:
        phaseTicks.tickGame(dt);
        return;
      default:
        assertNever(mode);
    }
  }
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
    tickMode,
    onAfterFrame: () => {
      // Per-frame tick event — emitted in BOTH headless and E2E so tests
      // can subscribe consistently across runtimes. Gated on state-ready
      // so it does not fire during the lobby.
      if (isStateReady(runtimeState)) {
        runtimeState.state.bus.emit(GAME_EVENT.TICK, {
          type: GAME_EVENT.TICK,
          dt: runtimeState.frameDt,
        });
        // Presentational derivations run after all state mutation — SFX
        // and music both diff GameState-derived signals (countdown-active,
        // build-bg decrescendo threshold) against last frame to issue
        // start/stop/ramp cues.
        sfx.tickPresentation(runtimeState.state);
        music.tickPresentation(runtimeState.state);
      }
      if (IS_DEV) {
        exposeE2EBridge({
          runtimeState,
          config,
          camera,
          renderer,
          // `eventTarget` is the UI canvas (see render-canvas.ts /
          // render/3d/renderer.ts); narrowed here because the bridge's
          // `captureOn` PNG capture needs the HTMLCanvasElement surface.
          canvas: renderer.eventTarget as HTMLCanvasElement,
        });
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
    renderer.drawFrame(map, overlay, viewport, timing.now(), camera.getPitch());
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
    cameraTiltEnabled: config.cameraTiltEnabled ?? true,
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
  });

  // -------------------------------------------------------------------------
  // Banner sub-system (delegated to runtime-banner.ts)
  // -------------------------------------------------------------------------

  const { showBanner, hideBanner, resetBannerState, tickBanner } =
    createBannerSystem({
      runtimeState,
      log: config.log,
      render: () => render(),
      timing,
      rendererCaptureScene: () => renderer.captureScene(),
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
    syncSelectionOverlay: updateSelectionOverlay,
    render: () => render(),
    pointerPlayer,
    startCannonPhase: () => phaseTicks.startCannonPhase(),
    enterCannonAfterCastleSelect: () =>
      phaseTicks.enterCannonAfterCastleSelect(),
    enterCannonAfterCastleReselect: (pids) =>
      phaseTicks.enterCannonAfterCastleReselect(pids),
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
    drawFrame: (map, overlay, viewport, now) =>
      renderer.drawFrame(map, overlay, viewport, now, camera.getPitch()),
    onRenderedFrame: camera.onRenderedFrame,
    logThrottled: config.logThrottled,
    scoreDeltaProgress: () => scoreDelta.progress(),
    upgradePickInteractiveSlots: () => upgradePick.interactiveSlots(),
    syncCrosshairs: (expired, dt) => phaseTicks.syncCrosshairs(expired, dt),
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
            onStateReady: () => {
              phaseTicks.subscribeBusObservers();
              haptics.subscribeBus(runtimeState.state.bus);
              music.subscribeBus(runtimeState.state.bus);
              sfx.subscribeBus(runtimeState.state.bus);
            },
          },
          config.getUrlModeOverride,
        ),
      selection,
      banner: { reset: resetBannerState },
      camera,
      getLifeLost: () => lifeLost,
      getUpgradePick: () => upgradePick,
      scoreDelta,
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
    panelPos: (pid) =>
      lifeLostPanelPos(selectRenderView(runtimeState.state), pid),
    disableAutoZoom: camera.disableAutoZoom,
  });

  // -------------------------------------------------------------------------
  // Upgrade pick sub-system (delegated to runtime-upgrade-pick.ts)
  // -------------------------------------------------------------------------

  const upgradePick: UpgradePickSystem = createUpgradePickSystem({
    runtimeState,
    log: config.log,
    render,
    sendUpgradePick: (playerId, choice) =>
      config.network.send({ type: MESSAGE.UPGRADE_PICK, playerId, choice }),
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
    requestUnzoom: camera.requestUnzoom,
    showBanner,
    hideBanner,
    lifeLost,
    // Host-side routing for the life-lost resolution, threaded through
    // to the phase machine via `PhaseTransitionCtx.lifeLostRoute`. The
    // subsystem no longer owns the dispatchers — it just drives the
    // dialog and reports the `continuing` list back.
    lifeLostRoute: {
      onGameOver: (winner, reason) =>
        phaseTicks.dispatchGameOver(winner, reason),
      onReselect: (continuing) => {
        runtimeState.selection.reselectQueue = [...continuing];
        selection.startReselection();
      },
      onContinue: selection.advanceToCannonPhase,
    },
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
    tryShowUpgradePick: (onDone) => upgradePick.tryShow(onDone),
    prepareUpgradePick: () => upgradePick.prepare(),
    getUpgradePickDialog: () => upgradePick.get(),
    clearUpgradePickDialog: () => upgradePick.set(null),
    endGame: lifecycle.endGame,
    beginUntilt: camera.beginUntilt,
    getPitchState: camera.getPitchState,
    isCannonRotationEasing: () => renderer.isCannonRotationEasing(),
    beginBattleTilt: camera.beginBattleTilt,
    engageAutoZoom: camera.engageAutoZoom,
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
    getPaused: () => isPaused(runtimeState),
    setPaused: (paused) => {
      // `setPaused` is called from the user-facing pause toggle
      // (options menu / pause key). Clearing the pause leaves any
      // visibility-driven pause in place — but in practice the
      // tab has to be visible for a user to hit the toggle at all.
      runtimeState.pausedBy = paused ? "user" : "none";
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
    getSoundReady: () => musicAssets !== undefined,
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
    isOnline,
    remotePlayerSlots: config.network.remotePlayerSlots,
    onCloseOptions: config.onCloseOptions,
    showSoundModal: () => soundModal?.show(),
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
          view: selectRenderView(runtimeState.state),
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
    emitUiTap: () => {
      const state = safeState(runtimeState);
      if (state) state.bus.emit(GAME_EVENT.UI_TAP, { type: GAME_EVENT.UI_TAP });
    },
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
    camera,

    // Sub-system handles
    selection,
    lifeLost,
    lobby: { renderLobby: lobby.renderLobby },
    lifecycle: {
      startGame: lifecycle.startGame,
      rematch: lifecycle.rematch,
      resetUIState: lifecycle.resetUIState,
    },
    phaseTicks: {
      startCannonPhase: phaseTicks.startCannonPhase,
      beginBattle: phaseTicks.beginBattle,
      subscribeBusObservers: phaseTicks.subscribeBusObservers,
    },
    music: { activate: music.activate, startTitle: music.startTitle },
    sfx: { activate: sfx.activate },

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
    hideBanner,
    requestUnzoom: camera.requestUnzoom,
    snapshotTerritory: () => snapshotTerritory(runtimeState.state.players),
    aimAtEnemyCastle: applyBattleTarget,
    warmMapCache: (map) => renderer.warmMapCache(map),
    networkSend: config.network.send,
    getPitchState: camera.getPitchState,
    beginBattleTilt: camera.beginBattleTilt,
    engageAutoZoom: camera.engageAutoZoom,
  };
}
