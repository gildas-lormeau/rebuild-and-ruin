/**
 * Render sub-system — builds the per-frame overlay, draws the frame,
 * and updates touch UI controls.
 *
 * Extracted from runtime.ts to reduce composition-root fan-out.
 */

import type {
  InputReceiver,
  PlayerController,
} from "./controller-interfaces.ts";
import { SCORE_DELTA_DISPLAY_TIME } from "./game-constants.ts";
import { PLAYER_COLORS, PLAYER_NAMES } from "./player-config.ts";
import {
  createBannerUi,
  createOnlineOverlay,
  createRenderSummaryMessage,
  createStatusBar,
} from "./render-composition.ts";
import type { LoupeHandle } from "./render-loupe.ts";
import type { MapData, RenderOverlay, Viewport } from "./render-types.ts";
import type { RuntimeState } from "./runtime-state.ts";
import {
  type Dpad,
  type FloatingActions,
  type QuitButton,
  updateTouchControls,
  type ZoomButton,
} from "./runtime-touch-ui.ts";
import { Phase } from "./types.ts";

interface RenderSystemDeps {
  readonly runtimeState: RuntimeState;
  readonly drawFrame: (
    map: MapData,
    overlay: RenderOverlay | undefined,
    viewport?: Viewport | null,
  ) => void;
  readonly logThrottled: (key: string, msg: string) => void;
  readonly syncCrosshairs: (battleCountdownExpired: boolean) => void;
  readonly getLifeLostPanelPos: (playerId: number) => {
    px: number;
    py: number;
  };
  readonly updateViewport: () => Viewport | null;
  readonly firstHuman: () => (PlayerController & InputReceiver) | null;
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
}

export function createRenderSystem(deps: RenderSystemDeps): () => void {
  const { runtimeState } = deps;

  return function render() {
    // Summary log: crosshairs, phantoms, impacts per frame (throttled 1/s)
    const chList = runtimeState.frame.crosshairs ?? [];
    const selH = runtimeState.overlay.selection?.highlights;
    deps.logThrottled(
      "render-summary",
      createRenderSummaryMessage({
        phaseName: Phase[runtimeState.state.phase],
        timer: runtimeState.state.timer,
        crosshairs: chList,
        aiPhantomsCount: runtimeState.frame.phantoms?.aiPhantoms?.length ?? 0,
        humanPhantomsCount:
          runtimeState.frame.phantoms?.humanPhantoms?.length ?? 0,
        aiCannonPhantomsCount:
          runtimeState.frame.phantoms?.aiCannonPhantoms?.length ?? 0,
        impactsCount: runtimeState.battleAnim.impacts.length,
        cannonballsCount: runtimeState.state.cannonballs.length,
        selectionHighlights: selH,
      }),
    );

    // Refresh crosshairs from controller state when paused
    if (runtimeState.state.phase === Phase.BATTLE && runtimeState.paused) {
      deps.syncCrosshairs(runtimeState.state.battleCountdown <= 0);
    }

    const bannerUi = createBannerUi(
      runtimeState.banner.active,
      runtimeState.banner.text,
      runtimeState.banner.progress,
      runtimeState.banner.subtitle,
    );

    runtimeState.overlay = createOnlineOverlay({
      previousSelection: runtimeState.overlay.selection,
      state: runtimeState.state,
      banner: runtimeState.banner,
      battleAnim: runtimeState.battleAnim,
      frame: runtimeState.frame,
      bannerUi,
      lifeLostDialog: runtimeState.lifeLostDialog,
      upgradePickDialog: runtimeState.upgradePickDialog,
      myPlayerId: runtimeState.frameCtx.myPlayerId,
      playerNames: PLAYER_NAMES,
      playerColors: PLAYER_COLORS,
      getLifeLostPanelPos: (playerId) => deps.getLifeLostPanelPos(playerId),
    });

    // Status bar (rendered inside canvas)
    if (runtimeState.overlay.ui) {
      runtimeState.overlay.ui.statusBar = createStatusBar(
        runtimeState.state,
        PLAYER_COLORS,
      );
    }

    // Add score deltas to overlay (shown briefly before Place Cannons banner)
    if (runtimeState.scoreDeltas.length > 0 && runtimeState.overlay.ui) {
      runtimeState.overlay.ui.scoreDeltas = runtimeState.scoreDeltas;
      runtimeState.overlay.ui.scoreDeltaProgress =
        1 - runtimeState.scoreDeltaTimer / SCORE_DELTA_DISPLAY_TIME;
    }

    deps.drawFrame(
      runtimeState.state.map,
      runtimeState.overlay,
      deps.updateViewport(),
    );

    // Update touch controls (loupe, d-pad, zoom, quit, floating actions)
    const touch = deps.getTouch();
    updateTouchControls({
      mode: runtimeState.mode,
      state: runtimeState.state,
      phantoms: runtimeState.frame.phantoms,
      directTouchActive: runtimeState.directTouchActive,
      clearDirectTouch: () => {
        runtimeState.directTouchActive = false;
      },
      leftHanded: runtimeState.settings.leftHanded,
      firstHuman: deps.firstHuman,
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
