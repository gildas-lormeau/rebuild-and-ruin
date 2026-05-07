/**
 * Render sub-system — builds the per-frame overlay, draws the frame,
 * and updates touch UI controls.
 *
 * Extracted from runtime-composition.ts to reduce composition-root fan-out.
 */

import { Phase } from "../shared/core/game-phase.ts";
import type { GameMap, Viewport } from "../shared/core/geometry-types.ts";
import type {
  CannonPhantom,
  PiecePhantom,
} from "../shared/core/phantom-types.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { cannonTier, isPlayerEliminated } from "../shared/core/player-types.ts";
import { selectRenderView } from "../shared/core/render-view.ts";
import type {
  InputReceiver,
  PlayerController,
} from "../shared/core/system-interfaces.ts";
import type { LoupeHandle, RenderOverlay } from "../shared/ui/overlay-types.ts";
import { PLAYER_COLORS, PLAYER_NAMES } from "../shared/ui/player-config.ts";
import { deriveCrumblingWallsFade } from "./crumbling-walls-overlay.ts";
import { deriveFogRevealOpacity } from "./fog-reveal-overlay.ts";
import { deriveFrostbiteRevealProgress } from "./frostbite-reveal-overlay.ts";
import { deriveGruntSurgeRevealIntensity } from "./grunt-surge-reveal-overlay.ts";
import { deriveRubbleClearingFade } from "./rubble-clearing-overlay.ts";
import type {
  CreateBannerUiFn,
  CreateOnlineOverlayFn,
  Dpad,
  FloatingActions,
  QuitButton,
  TimingApi,
  TouchControlsDeps,
  ZoomButton,
} from "./runtime-contracts.ts";
import {
  isPaused,
  isStateInstalled,
  type RuntimeState,
} from "./runtime-state.ts";
import { deriveSapperRevealIntensity } from "./sapper-reveal-overlay.ts";

interface RenderSystemDeps {
  readonly runtimeState: RuntimeState;
  /** Injected timing primitives — replaces bare `performance.now()` access. */
  readonly timing: TimingApi;

  // Render-domain functions (injected from composition root, not imported directly)
  readonly createBannerUi: CreateBannerUiFn;
  readonly createOnlineOverlay: CreateOnlineOverlayFn;

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
   *  hidden sibling canvas in 2D) and returns a banner-owned bridge
   *  canvas holding the game-area composite. The visible canvas is
   *  NEVER written. Returns undefined when no scene has been rendered
   *  yet (pre-first-frame or headless stub). */
  readonly captureSceneOffscreen: (
    map: GameMap,
    overlay: RenderOverlay | undefined,
    viewport: Viewport | null | undefined,
    now: number,
  ) => HTMLCanvasElement | undefined;
  /** Post-drawFrame hook — invoked once per tick after the scene has
   *  been blitted to the display canvas. Used by the camera to fire
   *  any pending `awaitCameraFlat` callback on the frame where the
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
    zoneCycleButton: ZoomButton | null;
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
   *  targets (the visible canvas is never written). Returns a banner-owned
   *  bridge canvas, or undefined when no scene has been rendered yet. Does
   *  NOT invoke touch-controls updates or the `onRenderedFrame` hook —
   *  those belong to the live frame loop, not to a capture. */
  captureSceneOffscreen: () => HTMLCanvasElement | undefined;
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
            banner.paletteKey,
            banner.prevScene,
            banner.newScene,
          );

    // Project full GameState onto the phase-discriminated render view
    // once per frame; pass to overlay builders instead of GameState so
    // they see only what the render layer needs.
    const view = selectRenderView(runtimeState.state);

    // Assemble the overlay's phantom payload from the controller-owned
    // `currentBuildPhantoms` / `currentCannonPhantom`. Every slot has a
    // controller (local or remote), and remote-controlled slots have
    // their fields written by the inbound network handler — the
    // controller is the sole source for both render and broadcast.
    //
    // `defaultFacings` is derived live from `state.players[i].defaultFacing`
    // (rather than read from a tick-populated cache) for the same reason
    // as `inBattle` below: `refreshOverlay` runs inside the banner
    // B-snapshot capture mid-tick, AFTER the transition has mutated
    // player state. A cached map computed at tick start would be stale
    // — live derivation guarantees the capture sees the post-mutation
    // facings that the renderer is about to draw against.
    const defaultFacings = new Map<number, number>();
    const cannonTiers = new Map<number, 1 | 2 | 3>();
    for (const player of runtimeState.state.players) {
      defaultFacings.set(player.id, player.defaultFacing);
      cannonTiers.set(player.id, cannonTier(player));
    }
    const overlayFrame = {
      crosshairs: runtimeState.frame.crosshairs,
      phantoms: {
        piecePhantoms: buildPiecePhantomsUnion(runtimeState),
        cannonPhantoms: buildCannonPhantomsUnion(runtimeState),
        defaultFacings,
        cannonTiers,
      },
      announcement: runtimeState.frame.announcement,
      gameOver: runtimeState.frame.gameOver,
    };

    // `inBattle` is derived from `state.phase` live here rather than read
    // from `runtimeState.frameMeta.inBattle` because `refreshOverlay` also
    // runs inside the banner B-snapshot capture (`captureSceneOffscreen`),
    // which fires mid-tick AFTER a transition has flipped `state.phase`.
    // `frameMeta` is only recomputed at tick start, so its `inBattle` is
    // stale during the capture — using the live phase prevents the B-
    // snapshot from rendering battle-era territory/walls on top of the
    // post-mutation scene.
    const inBattle = runtimeState.state.phase === Phase.BATTLE;

    const fogRevealOpacity = deriveFogRevealOpacity({
      view,
      banner: runtimeState.banner,
      now: deps.timing.now(),
      state: runtimeState,
    });
    const rubbleClearingFade = deriveRubbleClearingFade({
      view,
      banner: runtimeState.banner,
      now: deps.timing.now(),
      state: runtimeState,
    });
    const frostbiteRevealProgress = deriveFrostbiteRevealProgress({
      view,
      banner: runtimeState.banner,
      now: deps.timing.now(),
      state: runtimeState,
    });
    const crumblingWallsFade = deriveCrumblingWallsFade({
      view,
      banner: runtimeState.banner,
      now: deps.timing.now(),
      state: runtimeState,
    });
    const sapperRevealIntensity = deriveSapperRevealIntensity({
      view,
      banner: runtimeState.banner,
      now: deps.timing.now(),
      state: runtimeState,
    });
    const gruntSurgeRevealIntensity = deriveGruntSurgeRevealIntensity({
      view,
      banner: runtimeState.banner,
      now: deps.timing.now(),
      state: runtimeState,
    });

    runtimeState.overlay = deps.createOnlineOverlay({
      previousSelection: runtimeState.overlay.selection,
      view,
      battleAnim: runtimeState.battleAnim,
      frame: overlayFrame,
      bannerUi,
      inBattle,
      lifeLostDialog: runtimeState.dialogs.lifeLost,
      upgradePickDialog: runtimeState.dialogs.upgradePick,
      povPlayerId: runtimeState.frameMeta.povPlayerId,
      hasPointerPlayer: runtimeState.frameMeta.hasPointerPlayer,
      upgradePickInteractiveSlots: deps.upgradePickInteractiveSlots(),
      playerNames: PLAYER_NAMES,
      playerColors: PLAYER_COLORS,
      getLifeLostPanelPos: (playerId) => deps.getLifeLostPanelPos(playerId),
      fogRevealOpacity,
      rubbleClearingFade,
      frostbiteRevealProgress,
      crumblingWallsFade,
      sapperRevealIntensity,
      gruntSurgeRevealIntensity,
    });

    // Add score deltas to overlay (shown briefly before Place Cannons banner)
    if (
      runtimeState.scoreDisplay.deltas.length > 0 &&
      runtimeState.overlay.ui
    ) {
      runtimeState.overlay.ui.scoreDeltas = runtimeState.scoreDisplay.deltas;
      runtimeState.overlay.ui.scoreDeltaProgress = deps.scoreDeltaProgress();
    }

    // Expose modifier-reveal data when the phase is active. The 3D
    // burst managers in src/render/3d/effects/ read from overlay.ui
    // and never touch game state directly. Tiles + palette are
    // persisted on `state.modern` at modifier-apply time by
    // `applyBattleStartModifiers` (host) / `applyBattleStartCheckpoint`
    // (watcher), so both roles produce identical overlay data.
    const modifier = runtimeState.state.modern?.activeModifier;
    if (
      runtimeState.state.phase === Phase.MODIFIER_REVEAL &&
      modifier &&
      runtimeState.overlay.ui
    ) {
      runtimeState.overlay.ui.modifierReveal = {
        paletteKey: modifier,
        tiles: runtimeState.state.modern!.activeModifierChangedTiles,
      };
    }
  }

  function render(): void {
    if (!isStateInstalled(runtimeState)) return;

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

    // Update touch controls (loupe, d-pad, zoom, quit, floating actions).
    // Touch reads the phantom union from `runtimeState.overlay` (just
    // rebuilt by `refreshOverlay`) so it sees the same controllers +
    // remote-slot combination the renderer consumed.
    const touch = deps.getTouch();
    deps.updateTouchControls({
      mode: runtimeState.mode,
      state: runtimeState.state,
      phantoms: runtimeState.overlay.phantoms ?? {},
      leftHanded: runtimeState.settings.leftHanded,
      pointerPlayer: deps.pointerPlayer,
      dpad: touch.dpad,
      floatingActions: touch.floatingActions,
      zoneCycleButton: touch.zoneCycleButton,
      quitButton: touch.quitButton,
      loupeHandle: touch.loupeHandle,
      worldToScreen: deps.worldToScreen,
      screenToContainerCSS: deps.screenToContainerCSS,
      containerHeight: deps.getContainerHeight(),
    });
  }

  function captureSceneOffscreen(): HTMLCanvasElement | undefined {
    if (!isStateInstalled(runtimeState)) return undefined;
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

/** Assemble the full piece-phantom set for the current frame: each
 *  controller's `currentBuildPhantoms`. Remote-controlled slots have
 *  their field written by the inbound network handler, so a single
 *  loop over controllers covers both local and remote previews.
 *  Eliminated players are skipped here so callers don't have to
 *  filter, and stale phantoms left on a just-eliminated controller
 *  don't render. Returns undefined when no phantoms exist — keeps
 *  `overlay.phantoms.piecePhantoms` undefined in non-build phases. */
function buildPiecePhantomsUnion(runtimeState: {
  controllers: ReadonlyArray<{
    playerId: ValidPlayerSlot;
    currentBuildPhantoms: readonly PiecePhantom[];
  }>;
  state: { players: readonly { eliminated?: boolean }[] };
}): readonly PiecePhantom[] | undefined {
  const out: PiecePhantom[] = [];
  for (const ctrl of runtimeState.controllers) {
    if (isPlayerEliminated(runtimeState.state.players[ctrl.playerId])) continue;
    for (const phantom of ctrl.currentBuildPhantoms) out.push(phantom);
  }
  return out.length > 0 ? out : undefined;
}

/** Assemble the full cannon-phantom set for the current frame: each
 *  controller's `currentCannonPhantom` (at most one each). Remote-
 *  controlled slots have their field written by the inbound network
 *  handler. Eliminated players are skipped (see piece-phantom counterpart
 *  for rationale). Returns undefined when no phantoms exist — keeps
 *  `overlay.phantoms.cannonPhantoms` undefined in non-cannon phases. */
function buildCannonPhantomsUnion(runtimeState: {
  controllers: ReadonlyArray<{
    playerId: ValidPlayerSlot;
    currentCannonPhantom: CannonPhantom | undefined;
  }>;
  state: { players: readonly { eliminated?: boolean }[] };
}): readonly CannonPhantom[] | undefined {
  const out: CannonPhantom[] = [];
  for (const ctrl of runtimeState.controllers) {
    if (isPlayerEliminated(runtimeState.state.players[ctrl.playerId])) continue;
    if (ctrl.currentCannonPhantom) out.push(ctrl.currentCannonPhantom);
  }
  return out.length > 0 ? out : undefined;
}
