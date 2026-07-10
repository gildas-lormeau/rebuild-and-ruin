/**
 * Render sub-system — builds the per-frame overlay, draws the frame,
 * and updates touch UI controls.
 *
 * Extracted from runtime/composition.ts to reduce composition-root fan-out.
 */

import { cannonTier } from "../../shared/core/cannon-tier.ts";
import { Phase } from "../../shared/core/game-phase.ts";
import type { GameMap, Viewport } from "../../shared/core/geometry-types.ts";
import type {
  CannonPhantom,
  PiecePhantom,
} from "../../shared/core/phantom-types.ts";
import {
  isPlayerEliminated,
  type ValidPlayerId,
} from "../../shared/core/player-slot.ts";
import { selectRenderView } from "../../shared/core/render-view.ts";
import type {
  InputReceiver,
  PlayerController,
} from "../../shared/core/system-interfaces.ts";
import type {
  Dpad,
  QuitButton,
  TouchControlsDeps,
  ZoomButton,
} from "../../shared/ui/input-deps.ts";
import type {
  LoupeHandle,
  RenderOverlay,
} from "../../shared/ui/overlay-types.ts";
import { PLAYER_COLORS, PLAYER_NAMES } from "../../shared/ui/player-config.ts";
import { Mode } from "../../shared/ui/ui-mode.ts";
import { deriveRevealOverlayFields } from "../modifier-effects/registry.ts";
import {
  revealTimeFor,
  tickModifierRevealClock,
} from "../modifier-effects/reveal-time.ts";
import { isPaused, isStateInstalled, type RuntimeState } from "../state.ts";
import type { TimingApi } from "../timing-api.ts";
import type {
  CreateBannerUiFn,
  CreateOnlineOverlayFn,
} from "../ui-contracts.ts";

interface RenderSystemDeps {
  readonly runtimeState: RuntimeState;
  /** Injected timing primitives — replaces bare `performance.now()` access. */
  readonly timing: TimingApi;

  // Render-domain functions (injected from composition root, not imported directly)
  readonly createBannerUi: CreateBannerUiFn;
  readonly createOnlineOverlay: CreateOnlineOverlayFn;
  /** Pre-game screens own their own `{map, overlay}` builders. The
   *  unified `render()` dispatches by mode and falls back to the
   *  gameplay overlay pipeline below for everything else. */
  readonly buildLobbyOverlay: () => {
    map: GameMap;
    overlay: RenderOverlay | undefined;
  };
  readonly buildOptionsOverlay: () => {
    map: GameMap;
    overlay: RenderOverlay | undefined;
  };
  readonly buildControlsOverlay: () => {
    map: GameMap;
    overlay: RenderOverlay | undefined;
  };

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
  readonly logThrottled: (key: string, msg: string) => void;
  readonly scoreDeltaProgress: () => number;
  readonly upgradePickInteractiveSlots: () => ReadonlySet<ValidPlayerId>;
  readonly syncCrosshairs: (weaponsActive: boolean, dt: number) => void;
  readonly getLifeLostPanelPos: (playerId: ValidPlayerId) => {
    px: number;
    py: number;
  };
  /** Pure read of the displayed viewport — the lerp advances in
   *  `tickCamera` (per sim substep), never in the render path. */
  readonly getViewport: () => Viewport | undefined;
  readonly pointerPlayer: () => (PlayerController & InputReceiver) | null;
  readonly getTouch: () => {
    dpad: Dpad | null;
    zoneCycleButton: ZoomButton | null;
    quitButton: QuitButton | null;
    loupeHandle: LoupeHandle | null;
  };
  readonly updateTouchControls: (deps: TouchControlsDeps) => void;
}

interface RenderSystem {
  /** Standard per-tick render: build overlay, draw to visible canvas, update touch controls. */
  render: () => void;
  /** Flash-free offscreen capture for banner snapshots (B for every
   *  banner; primed pre-mutation A via `BannerSystem.primePrevScene`).
   *  Rebuilds the overlay against the current state and renders into
   *  offscreen-only targets at fullMapVp — NOT the displayed viewport,
   *  which on a touch peer may still be zoomed at transition dispatch
   *  (the visible canvas is never written). Returns a banner-owned
   *  bridge canvas, or undefined when no scene has been rendered yet.
   *  Does NOT invoke touch-controls updates — those belong to the live
   *  frame loop, not to a capture. Returns a fresh, caller-owned snapshot
   *  each call (see `RendererInterface.captureSceneOffscreen`), so the
   *  primed prev-scene and the new-scene can coexist for the whole sweep. */
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
      banner === null
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
    const defaultFacings = new Map<ValidPlayerId, number>();
    const cannonTiers = new Map<ValidPlayerId, 1 | 2 | 3>();
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

    const nowMs = deps.timing.now();
    tickModifierRevealClock(runtimeState, nowMs);
    // `revealTimeFor` is the single banner-read site for modifier-reveal
    // timing (see `reveal-time.ts`). Resolved once here and fed
    // to both downstream consumers: the 2D-overlay registry (path B) and
    // the path-A `overlay.ui.modifierReveal` publication that the 3D
    // burst managers read.
    const activeModifier = runtimeState.state.modern?.activeModifier;
    const revealTimeMs = activeModifier
      ? revealTimeFor(runtimeState, activeModifier, nowMs)
      : undefined;
    const revealOverlayFields = deriveRevealOverlayFields(
      activeModifier,
      revealTimeMs,
    );

    runtimeState.overlay = deps.createOnlineOverlay({
      previousSelection: runtimeState.overlay.selection,
      view,
      battleAnim: runtimeState.battleAnim,
      frame: overlayFrame,
      bannerUi,
      inBattle,
      inBalloonAnim: runtimeState.mode === Mode.BALLOON_ANIM,
      lifeLostDialog: runtimeState.dialogs.lifeLost,
      upgradePickDialog: runtimeState.dialogs.upgradePick,
      povPlayerId: runtimeState.frameMeta.povPlayerId,
      hasPointerPlayer: runtimeState.frameMeta.hasPointerPlayer,
      upgradePickInteractiveSlots: deps.upgradePickInteractiveSlots(),
      playerNames: PLAYER_NAMES,
      playerColors: PLAYER_COLORS,
      getLifeLostPanelPos: (playerId) => deps.getLifeLostPanelPos(playerId),
      revealOverlayFields,
    });

    // Add score deltas to overlay (shown briefly before Place Cannons banner)
    if (
      runtimeState.scoreDisplay.deltas.length > 0 &&
      runtimeState.overlay.ui
    ) {
      runtimeState.overlay.ui.scoreDeltas = runtimeState.scoreDisplay.deltas;
      runtimeState.overlay.ui.scoreDeltaProgress = deps.scoreDeltaProgress();
    }

    if (
      activeModifier &&
      revealTimeMs !== undefined &&
      runtimeState.overlay.ui
    ) {
      runtimeState.overlay.ui.modifierReveal = {
        modifierId: activeModifier,
        revealTimeMs,
        tiles: runtimeState.state.modern!.activeModifierChangedTiles,
      };
    }
  }

  function render(): void {
    // Pre-game screens (lobby/options/controls) have their own
    // `{map, overlay}` builders and skip the full gameplay overlay /
    // touch-controls / camera pipeline. They route through the same
    // `drawFrame` so the renderer-level draw path stays single-source.
    const screen = pickScreenOverlay();
    if (screen) {
      deps.drawFrame(
        screen.map,
        screen.overlay,
        undefined,
        deps.timing.now(),
        false,
      );
      return;
    }

    if (!isStateInstalled(runtimeState)) return;

    // Refresh crosshairs from controller state when paused
    if (runtimeState.frameMeta.inBattle && isPaused(runtimeState)) {
      // Mirror the canonical weaponsActive gate (phase-ticks.ts): once the
      // battle timer expires, weapons are locked for everyone while
      // in-flight balls land — the paused crosshair must show that too.
      deps.syncCrosshairs(
        runtimeState.state.battleCountdown <= 0 && runtimeState.state.timer > 0,
        0,
      );
    }

    refreshOverlay();

    deps.drawFrame(
      runtimeState.state.map,
      runtimeState.overlay,
      deps.getViewport(),
      deps.timing.now(),
      runtimeState.banner !== null,
    );

    // Update touch controls (loupe, d-pad, zoom, quit, floating actions).
    // Touch reads the phantom union from `runtimeState.overlay` (just
    // rebuilt by `refreshOverlay`) so it sees the same controllers +
    // remote-slot combination the renderer consumed.
    const touch = deps.getTouch();
    deps.updateTouchControls({
      mode: runtimeState.mode,
      state: runtimeState.state,
      phantoms: runtimeState.overlay.phantoms ?? {},
      pointerPlayer: deps.pointerPlayer,
      dpad: touch.dpad,
      zoneCycleButton: touch.zoneCycleButton,
      quitButton: touch.quitButton,
      loupeHandle: touch.loupeHandle,
    });
  }

  function pickScreenOverlay(): {
    map: GameMap;
    overlay: RenderOverlay | undefined;
  } | null {
    switch (runtimeState.mode) {
      case Mode.LOBBY:
        return deps.buildLobbyOverlay();
      case Mode.OPTIONS:
        return deps.buildOptionsOverlay();
      case Mode.CONTROLS:
        return deps.buildControlsOverlay();
      default:
        return null;
    }
  }

  function captureSceneOffscreen(): HTMLCanvasElement | undefined {
    if (!isStateInstalled(runtimeState)) return undefined;
    // Rebuild overlay so the capture reflects the current state — the
    // banner system calls this both pre-mutation (primed A) and
    // post-mutation (B) without running a live `render()` in between.
    refreshOverlay();
    // viewport=undefined → fullMapVp. Banner snapshots are always
    // full-map: the displayed viewport may still be zoomed at transition
    // dispatch (per-peer cosmetic state) and must not leak into the
    // captured scene.
    return deps.captureSceneOffscreen(
      runtimeState.state.map,
      runtimeState.overlay,
      undefined,
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
 *  don't render. Returns undefined when no phantoms exist.
 *
 *  Phase gate: piece phantoms are a WALL_BUILD-only placement preview, so
 *  this returns undefined in every other phase. The gate is load-bearing,
 *  not belt-and-suspenders — a REMOTE controller's `currentBuildPhantoms`
 *  is written by the inbound network handler and only cleared for LOCAL
 *  controllers at build-finalize (`finalizeLocalControllersBuildPhase`),
 *  so without it a remote slot's last preview renders into BATTLE. (The
 *  cannon counterpart had this exact bug — a ghost cannon shown in battle.) */
function buildPiecePhantomsUnion(runtimeState: {
  controllers: ReadonlyArray<{
    playerId: ValidPlayerId;
    currentBuildPhantoms: readonly PiecePhantom[];
  }>;
  state: { phase: Phase; players: readonly { eliminated?: boolean }[] };
}): readonly PiecePhantom[] | undefined {
  if (runtimeState.state.phase !== Phase.WALL_BUILD) return undefined;
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
 *  for rationale). Returns undefined when no phantoms exist.
 *
 *  Phase gate: cannon phantoms are a CANNON_PLACE-only placement preview.
 *  The gate is load-bearing — a REMOTE controller's `currentCannonPhantom`
 *  is written by the inbound network handler and only cleared for LOCAL
 *  controllers at `finalizeCannonPhase`; `finalizeRemoteCannonController`
 *  runs `initCannons` alone and leaves the field set. Without the gate
 *  that stale preview renders as a ghost cannon all through BATTLE. */
function buildCannonPhantomsUnion(runtimeState: {
  controllers: ReadonlyArray<{
    playerId: ValidPlayerId;
    currentCannonPhantom: CannonPhantom | undefined;
  }>;
  state: { phase: Phase; players: readonly { eliminated?: boolean }[] };
}): readonly CannonPhantom[] | undefined {
  if (runtimeState.state.phase !== Phase.CANNON_PLACE) return undefined;
  const out: CannonPhantom[] = [];
  for (const ctrl of runtimeState.controllers) {
    if (isPlayerEliminated(runtimeState.state.players[ctrl.playerId])) continue;
    if (ctrl.currentCannonPhantom) out.push(ctrl.currentCannonPhantom);
  }
  return out.length > 0 ? out : undefined;
}
