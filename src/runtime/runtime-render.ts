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
  CreateStatusBarFn,
  Dpad,
  FloatingActions,
  QuitButton,
  TouchControlsDeps,
  ZoomButton,
} from "./runtime-contracts.ts";
import { isStateReady, type RuntimeState } from "./runtime-state.ts";
import type { TimingApi } from "./runtime-types.ts";

interface RenderSystemDeps {
  readonly runtimeState: RuntimeState;
  /** Injected timing primitives — replaces bare `performance.now()` access. */
  readonly timing: TimingApi;

  // Render-domain functions (injected from composition root, not imported directly)
  readonly createBannerUi: CreateBannerUiFn;
  readonly createOnlineOverlay: CreateOnlineOverlayFn;
  readonly createRenderSummaryMessage: CreateRenderSummaryMessageFn;
  readonly createStatusBar: CreateStatusBarFn;

  readonly drawFrame: (
    map: GameMap,
    overlay: RenderOverlay | undefined,
    viewport: Viewport | null | undefined,
    now: number,
  ) => void;
  /** Post-drawFrame hook — invoked once per tick after the scene has
   *  been blitted to the display canvas. Used by the camera to fire
   *  any pending `requestUnzoom` callback on the frame where the
   *  viewport converged to fullMapVp, guaranteeing that a subsequent
   *  `captureScene` inside that callback sees the full-map pixels. */
  readonly onRenderedFrame: () => void;
  readonly logThrottled: (key: string, msg: string) => void;
  readonly scoreDeltaProgress: () => number;
  readonly upgradePickInteractiveSlots: () => ReadonlySet<ValidPlayerSlot>;
  readonly syncCrosshairs: (weaponsActive: boolean) => void;
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

export function createRenderSystem(deps: RenderSystemDeps): () => void {
  const { runtimeState } = deps;

  return function render() {
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
    if (runtimeState.frameMeta.inBattle && runtimeState.paused) {
      deps.syncCrosshairs(runtimeState.state.battleCountdown <= 0);
    }

    const bannerUi = deps.createBannerUi(
      runtimeState.banner.active,
      runtimeState.banner.text,
      runtimeState.banner.progress,
      runtimeState.banner.startTick,
      runtimeState.banner.subtitle,
    );

    // Project full GameState onto the phase-discriminated render view
    // once per frame; pass to overlay builders instead of GameState so
    // they see only what the render layer needs.
    const view = selectRenderView(runtimeState.state);

    runtimeState.overlay = deps.createOnlineOverlay({
      previousSelection: runtimeState.overlay.selection,
      view,
      banner: runtimeState.banner,
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
      masterBuilderLockout:
        runtimeState.state.modern?.masterBuilderLockout ?? 0,
    });

    // Status bar (rendered inside canvas). Hidden in 3D mode today
    // because drawStatusBar paints BELOW the game area — that would
    // asymmetrically grow only the 2D canvas, breaking letterbox
    // alignment with the symmetric WebGL canvas. The 3D equivalent is
    // the top strip reserved at construction time by the 3D renderer
    // (see `createCanvasRenderer({ reserveTopStrip: true })` in
    // `src/render/3d/renderer.ts`) — ABOVE the game area, grows BOTH
    // canvases symmetrically, applies to every overlay (lobby,
    // options, controls, game) without per-frame plumbing.
    if (runtimeState.overlay.ui) {
      const is3d = runtimeState.settings.rendererKind === "3d";
      runtimeState.overlay.ui.statusBar = is3d
        ? undefined
        : deps.createStatusBar(
            view,
            PLAYER_COLORS,
            runtimeState.frameMeta.povPlayerId,
            runtimeState.frameMeta.hasPointerPlayer,
          );
    }

    // Add score deltas to overlay (shown briefly before Place Cannons banner)
    if (
      runtimeState.scoreDisplay.deltas.length > 0 &&
      runtimeState.overlay.ui
    ) {
      runtimeState.overlay.ui.scoreDeltas = runtimeState.scoreDisplay.deltas;
      runtimeState.overlay.ui.scoreDeltaProgress = deps.scoreDeltaProgress();
    }

    deps.drawFrame(
      runtimeState.state.map,
      runtimeState.overlay,
      deps.updateViewport(),
      deps.timing.now(),
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
  };
}
