/**
 * Render sub-system — builds the per-frame overlay, draws the frame,
 * and updates touch UI controls.
 *
 * Extracted from runtime-composition.ts to reduce composition-root fan-out.
 */

import { Phase } from "../shared/core/game-phase.ts";
import type { GameMap, Viewport } from "../shared/core/geometry-types.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { selectRenderView } from "../shared/core/render-view.ts";
import type {
  InputReceiver,
  PlayerController,
} from "../shared/core/system-interfaces.ts";
import type { LoupeHandle, RenderOverlay } from "../shared/ui/overlay-types.ts";
import { PLAYER_COLORS, PLAYER_NAMES } from "../shared/ui/player-config.ts";
import type {
  CreateBannerUiFn,
  CreateOnlineOverlayFn,
  CreateRenderSummaryMessageFn,
  Dpad,
  FloatingActions,
  QuitButton,
  TimingApi,
  TouchControlsDeps,
  ZoomButton,
} from "./runtime-contracts.ts";
import { isPaused, isStateReady, type RuntimeState } from "./runtime-state.ts";

interface RenderSystemDeps {
  readonly runtimeState: RuntimeState;
  /** Injected timing primitives — replaces bare `performance.now()` access. */
  readonly timing: TimingApi;

  // Render-domain functions (injected from composition root, not imported directly)
  readonly createBannerUi: CreateBannerUiFn;
  readonly createOnlineOverlay: CreateOnlineOverlayFn;
  readonly createRenderSummaryMessage: CreateRenderSummaryMessageFn;

  readonly drawFrame: (
    map: GameMap,
    overlay: RenderOverlay | undefined,
    viewport: Viewport | null | undefined,
    now: number,
    /** When true, the 3D pipeline skips all entity updates + WebGL
     *  scene render. The 2D canvas (which composites the banner
     *  overlay + pre-captured scene snapshot) still runs. Set during
     *  banners so we don't pay for rebuilding+rendering a 3D scene
     *  that will be entirely covered by the snapshot + banner art.
     *  The 2D renderer ignores this flag (it has no 3D to skip). */
    skip3DScene?: boolean,
  ) => void;
  /** Flash-free alternative to `drawFrame` used by the banner system to
   *  capture the post-mutation scene for the B-snapshot. Runs the full
   *  render pipeline against offscreen targets only (FBO readback in 3D,
   *  hidden sibling canvas in 2D) and returns the resulting game-area
   *  ImageData. The visible canvas is NEVER written. Returns undefined
   *  when no scene has been rendered yet (pre-first-frame or headless
   *  stub). */
  readonly captureSceneOffscreen: (
    map: GameMap,
    overlay: RenderOverlay | undefined,
    viewport: Viewport | null | undefined,
    now: number,
  ) => ImageData | undefined;
  /** Post-drawFrame hook — invoked once per tick after the scene has
   *  been blitted to the display canvas. Used by the camera to fire
   *  any pending `requestUnzoom` callback on the frame where the
   *  viewport converged to fullMapVp, guaranteeing that a subsequent
   *  `captureScene` inside that callback sees the full-map pixels. */
  readonly onRenderedFrame: () => void;
  readonly logThrottled: (key: string, msg: string) => void;
  readonly scoreDeltaProgress: () => number;
  readonly upgradePickInteractiveSlots: () => ReadonlySet<ValidPlayerSlot>;
  readonly syncCrosshairs: (weaponsActive: boolean, dt: number) => void;
  readonly getLifeLostPanelPos: (playerId: ValidPlayerSlot) => {
    px: number;
    py: number;
  };
  readonly updateViewport: () => Viewport | undefined;
  readonly pointerPlayer: () => (PlayerController & InputReceiver) | null;
  readonly getTouch: () => {
    dpad: Dpad | null;
    floatingActions: FloatingActions | null;
    homeZoomButton: ZoomButton | null;
    enemyZoomButton: ZoomButton | null;
    quitButton: QuitButton | null;
    loupeHandle: LoupeHandle | null;
  };
  readonly worldToScreen: (
    wx: number,
    wy: number,
  ) => { sx: number; sy: number };
  readonly screenToContainerCSS: (
    sx: number,
    sy: number,
  ) => { x: number; y: number };
  readonly getContainerHeight: () => number;
  readonly updateTouchControls: (deps: TouchControlsDeps) => void;
}

interface RenderSystem {
  /** Standard per-tick render: build overlay, draw to visible canvas, update touch controls. */
  render: () => void;
  /** Flash-free offscreen capture for banner B-snapshot. Rebuilds the overlay
   *  against the current post-mutation state and renders into offscreen-only
   *  targets (the visible canvas is never written). Returns undefined when
   *  no scene has been rendered yet. Does NOT invoke touch-controls updates
   *  or the `onRenderedFrame` hook — those belong to the live frame loop,
   *  not to a capture. */
  captureSceneOffscreen: () => ImageData | undefined;
}

export function createRenderSystem(deps: RenderSystemDeps): RenderSystem {
  const { runtimeState } = deps;

  // Rebuilds `runtimeState.overlay` from current state. Shared by the live
  // `render` path and the banner-capture path so both see the same projection
  // of post-mutation state — the banner system mutates state then calls
  // `captureSceneOffscreen` to freeze the result as a snapshot, so the
  // overlay rebuild MUST run there too (otherwise the capture would render
  // against the previous tick's stale overlay).
  function refreshOverlay(): void {
    const banner = runtimeState.banner;
    const bannerUi =
      banner.status === "hidden"
        ? undefined
        : deps.createBannerUi(
            true,
            banner.kind,
            banner.text,
            banner.progress,
            banner.subtitle,
            banner.modifierDiff,
            banner.prevScene,
            banner.newScene,
          );

    // Project full GameState onto the phase-discriminated render view
    // once per frame; pass to overlay builders instead of GameState so
    // they see only what the render layer needs.
    const view = selectRenderView(runtimeState.state);

    runtimeState.overlay = deps.createOnlineOverlay({
      previousSelection: runtimeState.overlay.selection,
      view,
      battleAnim: runtimeState.battleAnim,
      frame: runtimeState.frame,
      bannerUi,
      inBattle: runtimeState.frameMeta.inBattle,
      lifeLostDialog: runtimeState.dialogs.lifeLost,
      upgradePickDialog: runtimeState.dialogs.upgradePick,
      povPlayerId: runtimeState.frameMeta.povPlayerId,
      hasPointerPlayer: runtimeState.frameMeta.hasPointerPlayer,
      upgradePickInteractiveSlots: deps.upgradePickInteractiveSlots(),
      playerNames: PLAYER_NAMES,
      playerColors: PLAYER_COLORS,
      getLifeLostPanelPos: (playerId) => deps.getLifeLostPanelPos(playerId),
    });

    // Add score deltas to overlay (shown briefly before Place Cannons banner)
    if (
      runtimeState.scoreDisplay.deltas.length > 0 &&
      runtimeState.overlay.ui
    ) {
      runtimeState.overlay.ui.scoreDeltas = runtimeState.scoreDisplay.deltas;
      runtimeState.overlay.ui.scoreDeltaProgress = deps.scoreDeltaProgress();
    }
  }

  function render(): void {
    if (!isStateReady(runtimeState)) return;

    // Summary log: crosshairs, phantoms, impacts per frame (throttled 1/s)
    const chList = runtimeState.frame.crosshairs;
    const selH = runtimeState.overlay.selection?.highlights;
    deps.logThrottled(
      "render-summary",
      deps.createRenderSummaryMessage({
        phaseName: Phase[runtimeState.state.phase],
        timer: runtimeState.state.timer,
        crosshairs: chList,
        piecePhantomsCount:
          runtimeState.frame.phantoms?.piecePhantoms?.length ?? 0,
        cannonPhantomsCount:
          runtimeState.frame.phantoms?.cannonPhantoms?.length ?? 0,
        impactsCount: runtimeState.battleAnim.impacts.length,
        cannonballsCount: runtimeState.state.cannonballs.length,
        selectionHighlights: selH,
      }),
    );

    // Refresh crosshairs from controller state when paused
    if (runtimeState.frameMeta.inBattle && isPaused(runtimeState)) {
      deps.syncCrosshairs(runtimeState.state.battleCountdown <= 0, 0);
    }

    refreshOverlay();

    deps.drawFrame(
      runtimeState.state.map,
      runtimeState.overlay,
      deps.updateViewport(),
      deps.timing.now(),
      runtimeState.banner.status !== "hidden",
    );
    deps.onRenderedFrame();

    // Update touch controls (loupe, d-pad, zoom, quit, floating actions)
    const touch = deps.getTouch();
    deps.updateTouchControls({
      mode: runtimeState.mode,
      state: runtimeState.state,
      phantoms: runtimeState.frame.phantoms,
      directTouchActive: runtimeState.inputTracking.directTouchActive,
      clearDirectTouch: () => {
        runtimeState.inputTracking.directTouchActive = false;
      },
      leftHanded: runtimeState.settings.leftHanded,
      pointerPlayer: deps.pointerPlayer,
      dpad: touch.dpad,
      floatingActions: touch.floatingActions,
      homeZoomButton: touch.homeZoomButton,
      enemyZoomButton: touch.enemyZoomButton,
      quitButton: touch.quitButton,
      loupeHandle: touch.loupeHandle,
      worldToScreen: deps.worldToScreen,
      screenToContainerCSS: deps.screenToContainerCSS,
      containerHeight: deps.getContainerHeight(),
    });
  }

  function captureSceneOffscreen(): ImageData | undefined {
    if (!isStateReady(runtimeState)) return undefined;
    // Rebuild overlay so the capture reflects the post-mutation state —
    // callers (banner system) typically mutate state between the A and B
    // captures without running a live `render()` in between.
    refreshOverlay();
    return deps.captureSceneOffscreen(
      runtimeState.state.map,
      runtimeState.overlay,
      deps.updateViewport(),
      deps.timing.now(),
    );
  }

  return { render, captureSceneOffscreen };
}
