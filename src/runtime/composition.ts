/**
 * Composition root for the game runtime. The ONE file in `src/runtime/`
 * allowed to import input/render/ai/online — every other runtime/ file
 * imports only from shared/, game/, and controllers/, keeping runtime
 * headless-testable. `lint-architecture-non-runtime.ts` hardcodes this
 * file as the single allowed importer for those rules. New runtime code
 * that needs input/render/ai/online belongs here.
 */

import { exposeDevConsole } from "../../dev/dev-console.ts";
import { exposeE2EBridge } from "../../dev/e2e-bridge.ts";
import { dispatchPointerMove } from "../input/input-dispatch.ts";
import { registerKeyboardHandlers } from "../input/input-keyboard.ts";
import { registerMouseHandlers } from "../input/input-mouse.ts";
import { createSeedField } from "../input/input-seed-field.ts";
import { registerTouchHandlers } from "../input/input-touch-canvas.ts";
import {
  createDpad,
  createFloatingActions,
  createQuitButton,
  createZoneCycleButton,
} from "../input/input-touch-ui.ts";
import { updateTouchControls } from "../input/input-touch-update.ts";
import type { GameMessage, ServerMessage } from "../protocol/protocol.ts";
import { pickHitWorld as pickElevatedHit } from "../render/3d/elevation.ts";
import { createRender3d } from "../render/3d/renderer.ts";
import {
  buildGameOverOverlay,
  computeLobbyLayout,
  createBannerUi,
  createOnlineOverlay,
  gameOverButtonHitTest,
  handleLifeLostDialogClick,
  handleUpgradePickClick,
  lifeLostPanelPos,
  lobbyClickHitTest,
  updateSelectionOverlay,
} from "../render/render-ui-overlays.ts";
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
import { GAME_EVENT } from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import {
  SPECTATOR_SLOT,
  type ValidPlayerId,
} from "../shared/core/player-slot.ts";
import { selectRenderView, sunTFromState } from "../shared/core/render-view.ts";
import { IS_DEV, IS_TOUCH_DEVICE } from "../shared/platform/platform.ts";
import { assertNever } from "../shared/platform/utils.ts";
import type { RendererInterface } from "../shared/ui/overlay-types.ts";
import { MAX_SEED_LENGTH, SEED_CUSTOM } from "../shared/ui/player-config.ts";
import { cycleOption } from "../shared/ui/settings-ui.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import { bootstrapNewGameFromSettings } from "./bootstrap.ts";
import {
  createCachedContainerHeight,
  createVisibilityListener,
} from "./browser/dom.ts";
import { createBrowserTimingApi } from "./browser/timing.ts";
import type { GameRuntime } from "./handle.ts";
import { createLocalInputActions } from "./input-actions.ts";
import { createRuntimeLoop } from "./main-loop.ts";
import {
  createRuntimeState,
  isPaused,
  isSessionLive,
  safeState,
  setMode,
  setVisibilityHidden,
} from "./state.ts";
import { createAudioOrchestrator } from "./subsystems/audio.ts";
import { createBannerSystem } from "./subsystems/banner.ts";
import { createCameraSystem } from "./subsystems/camera.ts";
import { createCannonAnimator } from "./subsystems/cannon-animator.ts";
import {
  buildLifecycleDeps,
  createGameLifecycle,
} from "./subsystems/game-lifecycle.ts";
import { createHapticsSubsystem } from "./subsystems/haptics.ts";
import { createInputSystem, type TouchHandles } from "./subsystems/input.ts";
import {
  createLifeLostSystem,
  type LifeLostSystem,
} from "./subsystems/life-lost.ts";
import { createLobbySystem } from "./subsystems/lobby.ts";
import { createOptionsSystem } from "./subsystems/options.ts";
import {
  createPhaseTicksSystem,
  type PhaseTicksSystem,
} from "./subsystems/phase-ticks.ts";
import { createPointerPlayerLookup } from "./subsystems/pointer-player.ts";
import { createRenderSystem } from "./subsystems/render.ts";
import { createScoreDeltaSystem } from "./subsystems/score-deltas.ts";
import { createSelectionSystem } from "./subsystems/selection.ts";
import {
  createUpgradePickSystem,
  type UpgradePickSystem,
} from "./subsystems/upgrade-pick.ts";
import type { TimingApi } from "./timing-api.ts";
import type { NetworkApi, RuntimeConfig } from "./types.ts";
import type { UIContext } from "./ui-contracts.ts";

/** Singleton empty set so repeated calls with no remotes return the same
 *  instance — runtime sub-systems read this through the `NetworkApi.remotePlayerSlots`
 *  seam, which is `ReadonlySet<ValidPlayerId>`, so the shared instance is
 *  immutable from every caller's perspective. */
const EMPTY_REMOTE_SLOTS: ReadonlySet<ValidPlayerId> = new Set();
/** Explicit no-op sender for pure-local play (no peers to notify).
 *  Named so call sites communicate intent rather than silently swallow
 *  messages via a default. */
export const noopNetworkSend: (msg: GameMessage) => void = () => {};

/**
 * Browser-side bindings for `RuntimeConfig`.
 *
 * Both production entry points (local: src/main.ts; online:
 * src/online/runtime/game.ts) need to wire the same three
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
  rendererOverride?: RendererInterface,
): {
  renderer: RendererInterface;
  timing: TimingApi;
  keyboardEventSource: Document;
} {
  // When an override is passed (dev-only alternate renderers, e.g.
  // ASCII), skip the 3D renderer entirely — instantiating Three.js +
  // WebGL just to discard it is wasteful when a debug renderer takes
  // its place.
  return {
    renderer: rendererOverride ?? createRender3d(worldCanvas, uiCanvas),
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
 * (src/online/runtime/game.ts) does NOT use this factory — it
 * builds its own `NetworkApi` backed by the WebSocket client session.
 */
export function createLocalNetworkApi(opts: {
  send: (msg: GameMessage) => void;
  onMessage?: (
    handler: (msg: ServerMessage) => void | Promise<void>,
  ) => () => void;
  remotePlayerSlots?: ReadonlySet<ValidPlayerId>;
  /** Optional override — defaults to `true` to match local/test "no peers"
   *  play where the runtime is the only authority. Network tests that
   *  build a host + watcher pair set `false` on the watcher side; this
   *  flips the broadcast gate in `buildHostPhaseCtx` (no `ctx.broadcast`
   *  on watchers) so transitions don't emit wire messages even though
   *  every peer runs the same `tickGame`. */
  amHost?: () => boolean;
}): NetworkApi {
  const remotes = opts.remotePlayerSlots ?? EMPTY_REMOTE_SLOTS;
  return {
    send: opts.send,
    onMessage: opts.onMessage ?? (() => () => {}),
    amHost: opts.amHost ?? (() => true),
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
  // Mutable state (shared bag — see state.ts)
  // -------------------------------------------------------------------------

  const runtimeState = createRuntimeState();
  /** Mark the next browser frame as needing a render. Tick handlers call
   *  this instead of the real `render()`; `mainLoop` drains the flag once
   *  per frame after the substep loop. Spiral-of-death prevention. */
  const requestRender = (): void => {
    runtimeState.renderDirty = true;
  };
  const haptics = createHapticsSubsystem({
    getLevel: () => runtimeState.settings.haptics,
    getPovPlayerId: () => runtimeState.frameMeta.povPlayerId,
    observer: config.observers?.haptics,
  });
  const audio = createAudioOrchestrator({ runtimeState });
  // Pause music (and the game loop) when the tab is backgrounded, resume on
  // return. rAF throttling already freezes the game on hidden tabs, but music
  // keeps looping on Web Audio — not acceptable for a single ~30s title track
  // playing for hours on a stale tab. Visibility-pause (`pausedBy` invariant)
  // and audio mute are independent reactions to the same input.
  createVisibilityListener({
    onChange: (hidden) => {
      setVisibilityHidden(runtimeState, hidden);
      audio.applyMute();
    },
  });

  // Touch handles created early — render, options, and lifecycle read them
  // via closure. Populated once by createInputSystem(), then frozen (see below).
  const touchHandles: TouchHandles = {
    dpad: null,
    floatingActions: null,
    zoneCycleButton: null,
    quitButton: null,
    loupeHandle: null,
  };

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
        requestRender();
        return;
      case Mode.OPTIONS:
        requestRender();
        return;
      case Mode.CONTROLS:
        requestRender();
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
    isSelectionReady: () => selection.isReady(),
    isMobileAutoZoom: () => camera.isMobileAutoZoom(),
    tickCamera: () => tickCamera(),
    tickScoreDelta: (dt: number) => scoreDelta.tick(dt),
    tickCannonAnimator: (dt: number) => cannonAnimator.tick(dt),
    render: () => render(),
    requestRender,
    tickMode,
    onAfterFrame: () => {
      // Per-frame tick event + presentational derivations. Gated on
      // `isSessionLive` (state installed AND in a gameplay mode), NOT on
      // `isStateInstalled` alone — after `returnToLobby`, the prior
      // GameState lingers as a frozen object. Reading it as if it were
      // live restarts the snare-roll loop (countdown trigger sees a
      // fresh rising edge against frozen `phase=WALL_BUILD, timer=3`)
      // and burns CPU on cannon/score animations during the lobby.
      if (isSessionLive(runtimeState)) {
        runtimeState.state.bus.emit(GAME_EVENT.TICK, {
          type: GAME_EVENT.TICK,
          dt: runtimeState.frameDt,
        });
        // Presentational derivations run after all state mutation — SFX
        // and music both diff GameState-derived signals (countdown-active,
        // build-bg decrescendo threshold) against last frame to issue
        // start/stop/ramp cues.
        audio.sfx.tickPresentation(runtimeState.state);
        audio.music.tickPresentation(runtimeState.state);
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
        exposeDevConsole(runtimeState, audio.music);
      }
    },
  });

  // -------------------------------------------------------------------------
  // Human-player lookup (delegated to subsystems/pointer-player.ts)
  // -------------------------------------------------------------------------

  const {
    pointerPlayer,
    hasPointerPlayer,
    withPointerPlayer,
    clearCache: clearHumanCache,
  } = createPointerPlayerLookup(runtimeState);

  // -------------------------------------------------------------------------
  // Camera / zoom (delegated to subsystems/camera.ts)
  // -------------------------------------------------------------------------

  const camera = createCameraSystem({
    getState: () => safeState(runtimeState),
    getCtx: () => runtimeState.frameMeta,
    hasPointerPlayer,
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
    getPointerPlayerPhantoms: () => {
      const ctrl = pointerPlayer();
      if (!ctrl) return null;
      return {
        buildPhantoms: ctrl.currentBuildPhantoms,
        cannonPhantom: ctrl.currentCannonPhantom,
      };
    },
    getOverlay: () => runtimeState.overlay,
    pickElevatedHit,
  });

  const { tickCamera, updateViewport } = camera;

  // -------------------------------------------------------------------------
  // Score delta sub-system (delegated to subsystems/score-deltas.ts)
  // -------------------------------------------------------------------------

  const scoreDelta = createScoreDeltaSystem({
    runtimeState,
  });

  // -------------------------------------------------------------------------
  // Cannon-facing animator — eased displayed rotations live in the runtime,
  // not the renderer. Battle-end gate polls `allSettled()` to wait for the
  // post-battle reset to ease before transitioning. The renderer reads
  // displayed values through the setter installed below.
  // -------------------------------------------------------------------------

  const cannonAnimator = createCannonAnimator({ runtimeState });
  renderer.setCannonFacingProvider?.(cannonAnimator.getDisplayed);

  // -------------------------------------------------------------------------
  // Banner sub-system (delegated to subsystems/banner.ts)
  // -------------------------------------------------------------------------

  const {
    showBanner,
    hideBanner,
    reset: resetBanner,
    tickBanner,
  } = createBannerSystem({
    runtimeState,
    log: config.log,
    requestRender,
    rendererCaptureScene: () => renderer.captureScene(),
    captureSceneOffscreen: () => captureSceneOffscreen(),
  });

  // -------------------------------------------------------------------------
  // Selection sub-system (delegated to subsystems/selection.ts)
  // -------------------------------------------------------------------------

  const selection = createSelectionSystem({
    runtimeState,
    hostAtFrameStart: config.network.amHost,
    sendTowerSelected: (pid, idx, confirmed, applyAt) =>
      config.network.send({
        type: "opponentTowerSelected",
        playerId: pid,
        towerIdx: idx,
        confirmed,
        applyAt,
      }),
    sendSelectStart: (timer) =>
      config.network.send({ type: "selectStart", timer }),
    log: config.log,
    camera,
    syncSelectionOverlay: updateSelectionOverlay,
    requestRender,
    // Forward-reference `render` (destructured below from
    // `createRenderSystem`) — the closure isn't called until a tick fires
    // `finishSelection`, by which point composition has finished and
    // `render` is bound. Same pattern as `captureSceneOffscreen` for the
    // banner system.
    flushPendingRender: () => {
      if (!runtimeState.renderDirty) return;
      runtimeState.renderDirty = false;
      render();
    },
    pointerPlayer,
    dispatchAdvanceToCannon: () => phaseTicks.dispatchAdvanceToCannon(),
    dispatchCastleDone: () => phaseTicks.dispatchCastleDone(),
  });

  // -------------------------------------------------------------------------
  // Render sub-system (delegated to subsystems/render.ts)
  // -------------------------------------------------------------------------

  const { render, captureSceneOffscreen } = createRenderSystem({
    runtimeState,
    timing,
    createBannerUi,
    createOnlineOverlay,
    // Forward-references — `lobby` / `options` are constructed below.
    // Safe because these thunks aren't invoked until a tick fires.
    buildLobbyOverlay: () => lobby.buildOverlay(),
    buildOptionsOverlay: () => options.buildOptionsOverlay(),
    buildControlsOverlay: () => options.buildControlsOverlay(),
    drawFrame: (map, overlay, viewport, now, skip3DScene) =>
      renderer.drawFrame(
        map,
        overlay,
        viewport,
        now,
        camera.getPitch(),
        skip3DScene,
        sunTFromState(runtimeState.state),
        camera.getPitchMax(),
      ),
    captureSceneOffscreen: (map, overlay, viewport, now) =>
      renderer.captureSceneOffscreen(
        map,
        overlay,
        viewport,
        now,
        camera.getPitch(),
        sunTFromState(runtimeState.state),
        camera.getPitchMax(),
      ),
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
    // `clientHeight` is a layout-triggering DOM read; the per-frame render
    // path calls `getContainerHeight` from inside multiple `render()` sites
    // per sub-step, so a naive read crossed the JS↔DOM bridge dozens of
    // times per browser frame. Cache the value and refresh via
    // ResizeObserver — the container only resizes on window resize /
    // orientation change, so steady-state reads become a closure variable
    // lookup. ResizeObserver is unavailable in the deno test stub
    // (test/stub-dom.ts pins clientHeight to a fixed value), so the
    // observer is gated on its global presence; the headless path
    // captures the initial value and never refreshes — fine because the
    // stub's clientHeight is constant by design.
    getContainerHeight: createCachedContainerHeight(gameContainer),
    updateTouchControls,
  });

  // -------------------------------------------------------------------------
  // Game lifecycle (delegated to subsystems/game-lifecycle.ts)
  // -------------------------------------------------------------------------

  const lifecycle = createGameLifecycle(
    buildLifecycleDeps({
      runtimeState,
      config,
      timing,
      render,
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
              haptics.subscribeBus(runtimeState.state.bus);
              audio.music.subscribeBus(runtimeState.state.bus);
              audio.sfx.subscribeBus(runtimeState.state.bus);
            },
            controllerFactory: config.controllerFactory,
          },
          config.getUrlModeOverride,
        ),
      selection,
      banner: { reset: resetBanner },
      cannonAnimator,
      camera,
      getLifeLost: () => lifeLost,
      getUpgradePick: () => upgradePick,
      scoreDelta,
      input: {
        resetForLobby: (runtimeState) => input.resetForLobby(runtimeState),
      },
      stopAudio: audio.stopAll,
      hitTestGameOver: (canvasX, canvasY) => {
        const gameOver = runtimeState.frame.gameOver;
        if (!gameOver) return null;
        return gameOverButtonHitTest(canvasX, canvasY, gameOver);
      },
      isTouchDevice: IS_TOUCH_DEVICE,
      buildGameOverOverlay,
    }),
  );

  // -------------------------------------------------------------------------
  // Life-lost sub-system (delegated to subsystems/life-lost.ts)
  // -------------------------------------------------------------------------

  const lifeLost: LifeLostSystem = createLifeLostSystem({
    runtimeState,
    sendLifeLostChoice: (choice, playerId, applyAt) =>
      config.network.send({
        type: "lifeLostChoice",
        choice,
        playerId,
        applyAt,
      }),
    log: config.log,
    requestRender,
    panelPos: (pid) =>
      lifeLostPanelPos(selectRenderView(runtimeState.state), pid),
    applyEarlyChoices: config.onlineDialogDrains?.drainLifeLost,
  });

  // -------------------------------------------------------------------------
  // Upgrade pick sub-system (delegated to subsystems/upgrade-pick.ts)
  // -------------------------------------------------------------------------

  const upgradePick: UpgradePickSystem = createUpgradePickSystem({
    runtimeState,
    log: config.log,
    requestRender,
    sendUpgradePick: (playerId, choice) =>
      config.network.send({ type: "upgradePick", playerId, choice }),
    applyEarlyChoices: config.onlineDialogDrains?.drainUpgradePick,
  });

  // -------------------------------------------------------------------------
  // Touch battle targeting — seeds the pointer-player's crosshair from the
  // saved camera target when BATTLE phase begins. Consumed by phase-ticks
  // `onBeginBattle` (touch only).
  // -------------------------------------------------------------------------

  function applyBattleTarget(): void {
    const target = camera.computeBattleTarget();
    if (!target) return;
    const h = pointerPlayer();
    if (h) h.setCrosshair(target.x, target.y);
  }

  // -------------------------------------------------------------------------
  // Phase ticks sub-system (delegated to subsystems/phase-ticks.ts)
  // -------------------------------------------------------------------------

  const phaseTicks: PhaseTicksSystem = createPhaseTicksSystem({
    runtimeState,
    timing,
    send: config.network.send,
    log: config.log,
    sendOpponentCannonPlaced: (msg) =>
      config.network.send({ type: "opponentCannonPlaced", ...msg }),
    sendOpponentCannonPhantom: (msg) =>
      config.network.send({ type: "opponentCannonPhantom", ...msg }),
    sendOpponentPiecePlaced: (msg) =>
      config.network.send({ type: "opponentPiecePlaced", ...msg }),
    sendOpponentPhantom: (msg) =>
      config.network.send({ type: "opponentPhantom", ...msg }),
    sendOpponentCannonPhaseDone: (playerId, applyAt) =>
      config.network.send({
        type: "opponentCannonPhaseDone",
        playerId,
        applyAt,
      }),
    online: config.onlinePhaseTicks,
    requestRender,
    awaitCameraFlat: camera.awaitCameraFlat,
    awaitPitchSettled: camera.awaitPitchSettled,
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
      onReselect: (continuing) => selection.enter(continuing),
      onAdvance: selection.advanceToCannonPhase,
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
    upgradePick: {
      tryShow: upgradePick.tryShow,
      prepare: upgradePick.prepare,
    },
    endGame: lifecycle.endGame,
    beginUntilt: camera.beginUntilt,
    getPitchState: camera.getPitchState,
    cannonRotationSettled: () => cannonAnimator.allSettled(),
    snapCannonBarrelsToRest: renderer.snapCannonBarrelsToRest
      ? () => renderer.snapCannonBarrelsToRest!()
      : undefined,
    beginTilt: camera.beginTilt,
    warmShadowPermutations: renderer.warmShadowPermutations
      ? () => renderer.warmShadowPermutations!()
      : undefined,
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
    getOptionsContext: () => runtimeState.optionsUI.context,
    setOptionsContext: (context) => {
      runtimeState.optionsUI.context = context;
    },
    lobby: runtimeState.lobby,
    getFrame: () => runtimeState.frame,
    getLobbyRemaining: config.getLobbyRemaining,
    isOnline,
    getSoundReady: audio.getSoundReady,
  };
  // Action surface: online wrappers when present (broadcast inside each
  // adapter), local executors otherwise. Both sides match `OnlineActions`,
  // so the input dispatcher consumes one shape regardless of mode.
  const inputActions =
    config.onlineActions ?? createLocalInputActions(runtimeState);
  const optionsDeps = {
    runtimeState,
    uiCtx,
    updateDpad: (enabled: boolean) =>
      touchHandles.dpad?.update(enabled ? Phase.WALL_BUILD : null),
    setDpadLeftHanded: (left: boolean) =>
      touchHandles.dpad?.setLeftHanded(left),
    refreshLobbySeed: () => lobby.refreshSeed(),
    isOnline,
    remotePlayerSlots: config.network.remotePlayerSlots,
    onCloseOptions: config.onCloseOptions,
    showSoundModal: audio.showSoundModal,
    getSoundReady: audio.getSoundReady,
    applyMute: audio.applyMute,
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
    requestRender,
    warmMapCache: renderer.warmMapCache,
    log: config.log,
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
        // Route through the camera so the inverse viewport transform applies
        // when zoomed in (lifeLostKeepZoom = true). Without this the hit-test
        // assumes a fullMap viewport and misses on every tap/click.
        const { wx, wy } = camera.screenToWorld(screenX, screenY);
        return handleLifeLostDialogClick({
          view: selectRenderView(runtimeState.state),
          lifeLostDialog: runtimeState.dialogs.lifeLost,
          gameX: wx,
          gameY: wy,
        });
      },
      upgradePickClick: (screenX, screenY) => {
        if (!runtimeState.dialogs.upgradePick) return null;
        return handleUpgradePickClick({
          dialog: runtimeState.dialogs.upgradePick,
          screenX,
          screenY,
        });
      },
      visibleOptionCount: () => visibleOptions(uiCtx).length,
    },
    isOnline,
    network: { amHost: config.network.amHost },
    actions: inputActions,
    lobby,
    options,
    lifeLost,
    upgradePick,
    selection,
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
      createZoneCycleButton,
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
  // Kick the frame loop. This is the single rAF site for the runtime —
  // `mainLoop` self-schedules unconditionally from here on, so no other
  // path needs to "restart" it (returnToLobby, rematch, route re-entry,
  // online room re-entry all keep using the same running loop). Headless
  // tests inject `requestFrame: () => {}` and drive `mainLoop` manually
  // via `tick()` (see test/runtime-headless.ts), so this call is a safe
  // no-op there.
  timing.requestFrame(mainLoop);

  return {
    runtimeState,
    camera,

    // Sub-system handles
    selection,
    lifeLost,
    scoreDelta,
    lobby: {
      show: lobby.show,
      markJoined: lobby.markJoined,
    },
    lifecycle: {
      startGame: lifecycle.startGame,
      rematch: lifecycle.rematch,
      resetUIState: lifecycle.resetUIState,
      teardownSession: lifecycle.teardownSession,
      finalizeGameOver: lifecycle.finalizeGameOver,
    },
    phaseTicks: {
      dispatchAdvanceToCannon: phaseTicks.dispatchAdvanceToCannon,
      beginBattle: phaseTicks.beginBattle,
    },
    music: {
      activate: audio.music.activate,
      startTitle: audio.music.startTitle,
    },
    sfx: { activate: audio.sfx.activate },

    // Shared quit-to-menu cleanup. Called from both local (main.ts) and
    // online (online/runtime/game.ts GAME_EXIT_EVENT, plus the imperative
    // online "leave" path in online/runtime/session.showLobby) — they
    // each layer their own session/navigation resets on top.
    shutdown: (): void => {
      setMode(runtimeState, Mode.STOPPED);
      // Close the lobby input gate. Game-start paths flip this themselves
      // (subsystems/lobby tickLobby, online initFromServer); this covers the
      // quit-back-to-menu paths so callers don't repeat the assignment.
      runtimeState.lobby.active = false;
      audio.stopAll();
    },

    upgradePick,

    // Cross-cutting orchestration
    mainLoop,
    clearFrameData,
    render,
    hideBanner,
    warmMapCache: (map) => renderer.warmMapCache(map),
  };
}
