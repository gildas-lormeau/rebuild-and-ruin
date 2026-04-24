/**
 * Camera / zoom system — extracted from runtime-composition.ts.
 *
 * Owns all viewport state (zone bounds, pinch zoom, auto-zoom, lerp)
 * and exposes a pure API for the runtime to call.
 */

import {
  MIN_ZOOM_RATIO,
  PINCH_FULL_MAP_SNAP,
  VIEWPORT_SNAP_THRESHOLD,
  ZONE_PAD_NO_WALLS,
  ZONE_PAD_SELECTION,
  ZONE_PAD_WITH_WALLS,
  ZOOM_LERP_SPEED,
} from "../shared/core/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import { isReselectPhase, Phase } from "../shared/core/game-phase.ts";
import type {
  GameMap,
  TilePos,
  Viewport,
  WorldPos,
} from "../shared/core/geometry-types.ts";
import {
  CANVAS_H,
  CANVAS_W,
  GRID_COLS,
  GRID_ROWS,
  MAP_PX_H,
  MAP_PX_W,
  SCALE,
} from "../shared/core/grid.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import {
  battleTargetPosition,
  bestEnemyZone,
  enemyZones,
  pxToTile,
  unpackTile,
  zoneTileBounds,
} from "../shared/core/spatial.ts";
import { type GameState } from "../shared/core/types.ts";
import type { RenderOverlay } from "../shared/ui/overlay-types.ts";
import { isInteractiveMode, Mode } from "../shared/ui/ui-mode.ts";
import {
  cameraStateFromViewport,
  fitTileBoundsToViewport,
  screenToWorld as projectScreenToWorld,
  worldToScreen as projectWorldToScreen,
  type TileBounds,
} from "./camera-projection.ts";
import type { CameraSystem, FrameContext } from "./runtime-types.ts";

/** EXCEPTION: CameraDeps uses all-getter pattern (late binding) because camera state
 *  can change during host migration. Other sub-systems destructure runtimeState directly. */
interface CameraDeps {
  getState: () => GameState | undefined;
  getCtx: () => FrameContext;
  getFrameDt: () => number;
  /** Whether camera pitch animations run. `false` in headless (no renderer
   *  to apply tilt, and `PITCH_SETTLED` events would pollute determinism
   *  fixtures); `true` in the browser, where the 3D renderer renders tilt. */
  cameraTiltEnabled: boolean;
  setFrameAnnouncement: (text: string) => void;
  getPointerPlayerCrosshair?: () => { x: number; y: number } | null;
  /** Latest rendered overlay — source of elevated-geometry heights for the
   *  battle ray pick. Optional for headless runs (no tilt → pickHitWorld
   *  short-circuits before reading it). */
  getOverlay?: () => RenderOverlay | undefined;
  /** Renderer-supplied elevation ray-pick: given a ground-plane hit and
   *  the current pitch, returns the world position of the first elevated
   *  tile the camera ray actually meets. Composition root injects this
   *  from `render/3d/elevation.ts` so the camera module doesn't import
   *  render code. Omitted in headless (no tilt → no correction needed). */
  pickElevatedHit?: (
    groundX: number,
    groundY: number,
    pitch: number,
    overlay: RenderOverlay | undefined,
    map: GameMap | undefined,
  ) => { wx: number; wy: number };
}

/** Camera pitch state machine.
 *  - `flat`: settled at pitch 0 (build / select / lobby / upgrade-pick).
 *  - `tilting`: easing from flat → battle (or from interrupted untilt back up).
 *  - `tilted`: settled at the battle 3/4 view pitch.
 *  - `untilting`: easing battle → flat (or from an interrupted tilt back down).
 *
 *  Call sites that need the settle edge subscribe to
 *  `GAME_EVENT.PITCH_SETTLED`. Call sites that already poll per tick
 *  (phase-ticks' untilt wait) read `getPitchState()` instead — no need
 *  to go through the bus for a value the camera already knows. */
type PitchState = "flat" | "tilting" | "tilted" | "untilting";

const CANVAS_SIZE = { w: CANVAS_W, h: CANVAS_H } as const;
/** Target pitch when entering battle: 30° classic isometric / Rampart 3/4 view. */
const TILT_BATTLE_PITCH = Math.PI / 6;
/** Pitch animation duration (seconds). CSS `transition: Xms ease-out` equivalent. */
const PITCH_DURATION = 0.6;

export function createCameraSystem(deps: CameraDeps): CameraSystem {
  // --- Internal state ---
  //
  // CAMERA STATE MACHINE — viewport priority (highest to lowest):
  //   castleBuildVp  — during castle build phase (mobile auto-zoom to player zone)
  //   pinchVp        — user pinch gesture (mobile, persists per-phase via phasePinch)
  //   cameraZone     — follow player zone or crosshair (mobile auto-zoom)
  //   fullMapVp      — default (entire map, desktop)
  // updateViewport() lerps currentVp toward the highest-priority non-null target.

  // Platform & session flags
  let mobileZoomEnabled = false;
  let zoomActivated = false;

  // Zoom targets (see priority comment above)
  let cameraZone: number | undefined;
  let pinchVp: Viewport | undefined;
  let castleBuildVp: Viewport | undefined;
  let lastAutoZoomPhase: Phase | undefined;

  // Pinch gesture — transient state, non-null only during an active two-finger gesture
  interface ActivePinch {
    readonly startVp: Viewport;
    startMidX: number;
    startMidY: number;
  }
  let activePinch: ActivePinch | undefined;

  // Per-phase pinch memory — saved/restored on phase transitions so each phase
  // remembers its own user-chosen zoom level independently
  const phasePinch: {
    build: Viewport | undefined;
    battle: Viewport | undefined;
  } = {
    build: undefined,
    battle: undefined,
  };

  // Selection zoom lifecycle — tracks the one-time deferred zoom to the
  // player's home tower after the "Select your castle" announcement finishes
  const selectionZoom: { applied: boolean; pendingVp: TilePos | undefined } = {
    applied: false,
    pendingVp: undefined,
  };
  const MIN_ZOOM_W = MAP_PX_W * MIN_ZOOM_RATIO;
  const cachedZoneBounds: Map<
    number,
    { viewport: Viewport; wallHash: number }
  > = new Map();

  const fullMapVp: Viewport = {
    x: 0,
    y: 0,
    w: MAP_PX_W,
    h: MAP_PX_H,
  };
  const currentVp: Viewport = { ...fullMapVp };
  let lastVp: Viewport | undefined;

  // Pre-transition unzoom choreography — parked callback fired by the
  // post-render hook once drawFrame has rendered a full-map flat frame.
  // Parked via `onCameraReady`; the flatten itself runs in
  // `unzoomForOverlays` whenever `frameCtx.shouldUnzoom` is set.
  let pendingUnzoomReady: (() => void) | undefined;

  // Pitch animation — targetPitch is re-set on phase-enter (see
  // handlePhaseChangeZoom); currentPitch eases toward target each tick
  // in tickCamera. Gated on `cameraTiltEnabled` — headless has no place
  // to apply tilt, so we keep both values at 0 there.
  // TODO(step-6): loupe (render-loupe.ts) and auto-zoom fit
  // (fitTileBoundsToViewport) are pitch-agnostic; under tilt the loupe
  // crop and zone fit are slightly off. Cosmetic at 30°; fix in step 6.
  let currentPitch = 0;
  let targetPitch = 0;
  let pitchAnimFrom = 0;
  let pitchAnimElapsed = PITCH_DURATION;
  let pitchState: PitchState = "flat";

  function setPitchTarget(next: number): void {
    if (next === targetPitch) return;
    pitchAnimFrom = currentPitch;
    targetPitch = next;
    pitchAnimElapsed = 0;
    // Entering an animation: `tilting` if the new target is non-zero,
    // `untilting` otherwise. Covers mid-anim reversals too (e.g. a
    // paused battle-enter that gets undone before the animation
    // settles) since direction is derived from the target, not the
    // prior state.
    pitchState = next > 0 ? "tilting" : "untilting";
  }

  function emitPitchSettled(pitch: number): void {
    const state = deps.getState();
    if (!state) return;
    emitGameEvent(state.bus, GAME_EVENT.PITCH_SETTLED, { pitch });
  }

  // --- Helpers ---

  function povPlayerId(): number {
    return deps.getCtx().povPlayerId;
  }

  function getMyZone(): number | null {
    const state = deps.getState();
    if (!state) return null;
    return state.playerZones[povPlayerId()] ?? null;
  }

  function getBestEnemyZone(): number | null {
    const state = deps.getState();
    if (!state) return null;
    return bestEnemyZone(state.players, state.playerZones, povPlayerId());
  }

  function getEnemyZones(): number[] {
    const state = deps.getState();
    if (!state) return [];
    return enemyZones(state.players, state.playerZones, povPlayerId());
  }

  function computeZoneBounds(zoneId: number): Viewport {
    const state = deps.getState()!;
    const pid = state.playerZones.indexOf(zoneId);
    const player = pid >= 0 ? state.players[pid] : undefined;

    const hash = wallSetHash(player?.walls);
    const cached = cachedZoneBounds.get(zoneId);
    if (cached && cached.wallHash === hash) return cached.viewport;

    const { bounds, pad } = zoneTileBounds(
      zoneId,
      state.playerZones,
      state.players,
      state.map.zones,
      ZONE_PAD_WITH_WALLS,
      ZONE_PAD_NO_WALLS,
    );
    const result = fitTileBoundsToViewport(
      {
        minR: bounds.minR,
        maxR: bounds.maxR,
        minC: bounds.minC,
        maxC: bounds.maxC,
      },
      pad,
    );
    cachedZoneBounds.set(zoneId, { viewport: result, wallHash: hash });
    return result;
  }

  function computeCastleBuildViewport(
    wallPlans: readonly { playerId: ValidPlayerSlot; tiles: number[] }[],
  ): Viewport {
    const state = deps.getState()!;
    const myPid = povPlayerId();
    const plan =
      wallPlans.find((plan) => plan.playerId === myPid) ?? wallPlans[0];
    if (!plan || plan.tiles.length === 0) return fullMapVp;
    const player = state.players[plan.playerId];
    let minR = GRID_ROWS,
      maxR = 0,
      minC = GRID_COLS,
      maxC = 0;
    for (const key of plan.tiles) {
      const { r, c } = unpackTile(key);
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
    if (player?.homeTower) {
      const { row, col } = player.homeTower;
      if (row < minR) minR = row;
      if (row > maxR) maxR = row;
      if (col < minC) minC = col;
      if (col > maxC) maxC = col;
    }
    const tileBounds: TileBounds = { minR, maxR, minC, maxC };
    return fitTileBoundsToViewport(tileBounds, ZONE_PAD_WITH_WALLS);
  }

  // --- Auto-zoom ---

  function savePinchForCurrentPhase(isBattle: boolean): void {
    if (!pinchVp) return;
    if (isBattle) phasePinch.battle = { ...pinchVp };
    else phasePinch.build = { ...pinchVp };
  }

  /** Save current pinch viewport to the phase-specific slot and restore the other.
   *  enteringBattle=true: save current zoom as build-phase zoom, restore battle zoom.
   *  enteringBattle=false: save current zoom as battle-phase zoom, restore build zoom. */
  function swapPinchViewport(enteringBattle: boolean): void {
    savePinchForCurrentPhase(!enteringBattle);
    const candidate = enteringBattle ? phasePinch.battle : phasePinch.build;
    pinchVp = candidate ? { ...candidate } : undefined;
  }

  /** Derive map zone from a world-pixel position. */
  function zoneAtPixel(x: number, y: number): number | null {
    const state = deps.getState();
    if (!state) return null;
    const row = pxToTile(y);
    const col = pxToTile(x);
    return state.map.zones[row]?.[col] ?? null;
  }

  /** Derive camera zone from the human crosshair position (enemy zones only). */
  function crosshairZone(): number | null {
    const ch = deps.getPointerPlayerCrosshair?.();
    if (!ch) return null;
    const zone = zoneAtPixel(ch.x, ch.y);
    if (zone === null || zone === getMyZone()) return null;
    return zone;
  }

  function autoZoom(phase: Phase): void {
    // No auto-zoom when there is no human player (demo / spectator / eliminated)
    if (!deps.getCtx().hasPointerPlayer) return;
    if (phase === Phase.BATTLE) {
      swapPinchViewport(true);
      // If pinch points at own zone, reset — always pick enemy
      const myZone = getMyZone();
      if (pinchVp && myZone !== null) {
        const zoneBounds = computeZoneBounds(myZone);
        const cx = pinchVp.x + pinchVp.w / 2;
        const cy = pinchVp.y + pinchVp.h / 2;
        if (
          cx >= zoneBounds.x &&
          cx <= zoneBounds.x + zoneBounds.w &&
          cy >= zoneBounds.y &&
          cy <= zoneBounds.y + zoneBounds.h
        ) {
          pinchVp = undefined;
          phasePinch.battle = undefined;
        }
      }
      if (pinchVp) {
        cameraZone = undefined;
      } else {
        // Camera follows crosshair zone; fall back to best enemy
        cameraZone = crosshairZone() ?? getBestEnemyZone() ?? undefined;
      }
    } else {
      swapPinchViewport(false);
      if (pinchVp) {
        cameraZone = undefined;
      } else {
        cameraZone = getMyZone() ?? undefined;
      }
    }
  }

  // --- Per-frame tick ---

  let prevFramePaused = false;
  let prevFrameQuitPending = false;

  function tickCamera(): void {
    const state = deps.getState();
    if (!state) return;
    const frameCtx = deps.getCtx();
    const mobileAuto = mobileZoomEnabled && zoomActivated;

    unzoomForOverlays(state, frameCtx);
    restoreZoomAfterModal(mobileAuto, state, frameCtx);
    handleSelectionZoom(mobileAuto, state, frameCtx);
    const notTransition = !frameCtx.isTransition;
    handlePhaseChangeZoom(mobileAuto, state, frameCtx, notTransition);
    followCrosshairInBattle(mobileAuto, frameCtx, notTransition);
    tickPitch();
  }

  /** Ease currentPitch toward targetPitch each frame. Hard-zero when tilt is
   *  disabled (headless) so PITCH_SETTLED events don't pollute the determinism
   *  event log. Emits `PITCH_SETTLED` on the frame the animation completes. */
  function tickPitch(): void {
    if (!deps.cameraTiltEnabled) {
      currentPitch = 0;
      targetPitch = 0;
      pitchAnimFrom = 0;
      pitchAnimElapsed = PITCH_DURATION;
      pitchState = "flat";
      return;
    }
    if (pitchAnimElapsed >= PITCH_DURATION) {
      if (currentPitch !== targetPitch) currentPitch = targetPitch;
      return;
    }
    const dt = deps.getFrameDt();
    if (dt <= 0) return;
    pitchAnimElapsed = Math.min(PITCH_DURATION, pitchAnimElapsed + dt);
    const t = pitchAnimElapsed / PITCH_DURATION;
    const eased = 1 - (1 - t) * (1 - t) * (1 - t); // cubic ease-out
    currentPitch = pitchAnimFrom + (targetPitch - pitchAnimFrom) * eased;
    // Settle on the tick that crosses the duration boundary. We only
    // fire the event here (not in the `>= PITCH_DURATION` early-exit
    // above) so it triggers exactly once per animation, not on every
    // idle frame that follows.
    if (pitchAnimElapsed >= PITCH_DURATION) {
      currentPitch = targetPitch;
      pitchState = targetPitch > 0 ? "tilted" : "flat";
      emitPitchSettled(currentPitch);
    }
  }

  /** Clear zoom targets whenever `frameCtx.shouldUnzoom` is set.
   *  Triggers: UI overlays (paused / quit / life-lost), mobile human-done
   *  predicates, phase-ending on desktop, and phase transitions.
   *
   *  Does NOT touch pitch — that's `onCameraReady`'s job. Pitch flatten
   *  is coupled to "a display chain is about to run" (banner capture
   *  needs a flat scene), not to every transition frame, so flattening
   *  here would fight `beginBattleTilt` (which runs in BALLOON_ANIM /
   *  BANNER postDisplay, where isTransition is still true). */
  function unzoomForOverlays(state: GameState, frameCtx: FrameContext): void {
    if (
      !frameCtx.shouldUnzoom ||
      (cameraZone === undefined &&
        pinchVp === undefined &&
        castleBuildVp === undefined)
    )
      return;
    savePinchForCurrentPhase(state.phase === Phase.BATTLE);
    cameraZone = undefined;
    pinchVp = undefined;
    castleBuildVp = undefined;
  }

  /** Re-engage auto-zoom when pause or quit dialog is dismissed (mobile only). */
  function restoreZoomAfterModal(
    mobileAuto: boolean,
    state: GameState,
    frameCtx: FrameContext,
  ): void {
    if (
      mobileAuto &&
      ((prevFramePaused && !frameCtx.paused) ||
        (prevFrameQuitPending && !frameCtx.quitPending))
    ) {
      autoZoom(state.phase);
    }
    prevFramePaused = frameCtx.paused;
    prevFrameQuitPending = frameCtx.quitPending;
  }

  /** Auto-zoom to selection after announcement finishes. */
  function handleSelectionZoom(
    mobileAuto: boolean,
    state: GameState,
    frameCtx: FrameContext,
  ): void {
    if (
      frameCtx.mode !== Mode.SELECTION ||
      selectionZoom.applied ||
      !frameCtx.isSelectionReady
    )
      return;
    selectionZoom.applied = true;
    if (!mobileAuto) return;
    if (!isReselectPhase(state.phase) || frameCtx.humanIsReselecting) {
      autoZoom(state.phase);
    }
    if (selectionZoom.pendingVp) {
      castleBuildVp = fitTileBoundsToViewport(
        {
          minR: selectionZoom.pendingVp.row,
          maxR: selectionZoom.pendingVp.row + 1,
          minC: selectionZoom.pendingVp.col,
          maxC: selectionZoom.pendingVp.col + 1,
        },
        ZONE_PAD_SELECTION,
      );
      selectionZoom.pendingVp = undefined;
    }
  }

  /** Auto-zoom when the game phase changes (mobile only, skip during transitions). */
  function handlePhaseChangeZoom(
    mobileAuto: boolean,
    state: GameState,
    frameCtx: FrameContext,
    notTransition: boolean,
  ): void {
    if (state.phase === lastAutoZoomPhase || !notTransition) return;
    if (state.phase === Phase.CASTLE_RESELECT) {
      selectionZoom.applied = false;
      if (mobileAuto && frameCtx.humanIsReselecting) {
        autoZoom(state.phase);
      }
    } else if (mobileAuto && frameCtx.mode !== Mode.SELECTION) {
      // SELECTION mode is owned by `handleSelectionZoom`, which times the
      // zoom against the announcement-end signal. Don't preempt it here.
      autoZoom(state.phase);
    }
    // Pitch is no longer set here. Tilt-in is driven explicitly by
    // `beginBattleTilt` (called from the phase machine at battle-banner
    // end, so the tilt plays unzoomed BEFORE balloons / ready). Untilt
    // is driven by `onCameraReady` (which flattens pitch as part of
    // requesting convergence — so the end-of-battle banner captures +
    // sweeps a flat scene). Letting phase-change drive pitch would
    // re-fire those animations at the wrong moments.
    lastAutoZoomPhase = state.phase;
  }

  /** Track crosshair zone during battle for camera follow (mobile only). */
  function followCrosshairInBattle(
    mobileAuto: boolean,
    frameCtx: FrameContext,
    notTransition: boolean,
  ): void {
    if (
      !mobileAuto ||
      !frameCtx.inBattle ||
      pinchVp ||
      frameCtx.shouldUnzoom ||
      !notTransition
    )
      return;
    const zone = crosshairZone();
    if (zone !== null && zone !== cameraZone) {
      cameraZone = zone;
    }
  }

  // --- Viewport lerp ---

  function updateViewport(): Viewport | undefined {
    const { mode } = deps.getCtx();
    let target: Viewport;
    if (
      castleBuildVp &&
      (mode === Mode.CASTLE_BUILD || mode === Mode.SELECTION) &&
      mobileZoomEnabled &&
      zoomActivated
    ) {
      target = castleBuildVp;
    } else if (pinchVp) {
      target = pinchVp;
    } else if (cameraZone !== undefined) {
      target = computeZoneBounds(cameraZone);
    } else {
      target = fullMapVp;
    }

    const time = Math.min(1, ZOOM_LERP_SPEED * deps.getFrameDt());
    currentVp.x += (target.x - currentVp.x) * time;
    currentVp.y += (target.y - currentVp.y) * time;
    currentVp.w += (target.w - currentVp.w) * time;
    currentVp.h += (target.h - currentVp.h) * time;

    const dx =
      Math.abs(currentVp.x - target.x) +
      Math.abs(currentVp.y - target.y) +
      Math.abs(currentVp.w - target.w) +
      Math.abs(currentVp.h - target.h);
    if (dx < VIEWPORT_SNAP_THRESHOLD) {
      currentVp.x = target.x;
      currentVp.y = target.y;
      currentVp.w = target.w;
      currentVp.h = target.h;
    }

    if (
      currentVp.x === fullMapVp.x &&
      currentVp.y === fullMapVp.y &&
      currentVp.w === fullMapVp.w &&
      currentVp.h === fullMapVp.h
    ) {
      lastVp = undefined;
    } else {
      lastVp = currentVp;
    }
    return lastVp;
  }

  function getViewport(): Viewport | undefined {
    return lastVp;
  }

  // --- Coordinate conversion ---

  function screenToWorld(x: number, y: number): WorldPos {
    const viewport = getViewport();
    if (!viewport) return { wx: x / SCALE, wy: y / SCALE };
    const state = cameraStateFromViewport(viewport, CANVAS_SIZE, currentPitch);
    const { x: wx, y: wy } = projectScreenToWorld(state, CANVAS_SIZE, x, y);
    return { wx, wy };
  }

  /** Inverse of screenToWorld: world-pixel → canvas backing-store pixel. */
  function worldToScreen(wx: number, wy: number): { sx: number; sy: number } {
    const viewport = getViewport();
    if (!viewport) return { sx: wx * SCALE, sy: wy * SCALE };
    const state = cameraStateFromViewport(viewport, CANVAS_SIZE, currentPitch);
    return projectWorldToScreen(state, CANVAS_SIZE, wx, wy);
  }

  function pixelToTile(x: number, y: number): { row: number; col: number } {
    // Pointer may land on letterbox or outside the zoomed viewport's
    // back-projected rect; snap to the nearest edge tile so phantom/hit
    // tests keep working at the map boundary.
    const { wx, wy } = screenToWorld(x, y);
    return {
      col: Math.max(0, Math.min(GRID_COLS - 1, pxToTile(wx))),
      row: Math.max(0, Math.min(GRID_ROWS - 1, pxToTile(wy))),
    };
  }

  /** Like `screenToWorld` but ray-picks elevated geometry under battle tilt.
   *  At pitch=0 this is `screenToWorld`; under tilt, a tap visually on the
   *  top of a wall/tower/etc resolves to that tile instead of the ground
   *  row visually underneath it. Used for battle aim/fire so the crosshair
   *  lands on the object the user sees. */
  function pickHitWorld(x: number, y: number): WorldPos {
    const ground = screenToWorld(x, y);
    if (currentPitch <= 0 || !deps.pickElevatedHit) return ground;
    const state = deps.getState();
    if (!state) return ground;
    const overlay = deps.getOverlay?.();
    const hit = deps.pickElevatedHit(
      ground.wx,
      ground.wy,
      currentPitch,
      overlay,
      state.map,
    );
    return { wx: hit.wx, wy: hit.wy };
  }

  // --- Pinch-to-zoom ---

  function onPinchStart(midX: number, midY: number): void {
    const { mode } = deps.getCtx();
    if (!isInteractiveMode(mode)) return;
    activePinch = {
      startVp: { ...currentVp },
      startMidX: midX,
      startMidY: midY,
    };
  }

  function onPinchUpdate(midX: number, midY: number, scale: number): void {
    const { mode } = deps.getCtx();
    if (!activePinch || !isInteractiveMode(mode)) return;
    const newW = Math.max(
      MIN_ZOOM_W,
      Math.min(fullMapVp.w, activePinch.startVp.w * scale),
    );
    const newH = newW * (fullMapVp.h / fullMapVp.w);

    const startState = cameraStateFromViewport(
      activePinch.startVp,
      CANVAS_SIZE,
    );
    const { x: anchorWx, y: anchorWy } = projectScreenToWorld(
      startState,
      CANVAS_SIZE,
      activePinch.startMidX,
      activePinch.startMidY,
    );

    // Solve for new-viewport top-left such that (midX, midY) maps to (anchorWx, anchorWy).
    // Equivalent to: screenToWorld on a zero-origin viewport of size (newW, newH).
    const zeroOrigin = cameraStateFromViewport(
      { x: 0, y: 0, w: newW, h: newH },
      CANVAS_SIZE,
    );
    const { x: midWx, y: midWy } = projectScreenToWorld(
      zeroOrigin,
      CANVAS_SIZE,
      midX,
      midY,
    );
    let x = anchorWx - midWx;
    let y = anchorWy - midWy;

    x = Math.max(0, Math.min(fullMapVp.w - newW, x));
    y = Math.max(0, Math.min(fullMapVp.h - newH, y));

    pinchVp = { x, y, w: newW, h: newH };
    currentVp.x = x;
    currentVp.y = y;
    currentVp.w = newW;
    currentVp.h = newH;
    lastVp = currentVp;
    cameraZone = undefined;
    zoomActivated = true;
  }

  function onPinchEnd(): void {
    const state = deps.getState();
    activePinch = undefined;
    if (!pinchVp) return;
    if (pinchVp.w >= fullMapVp.w * PINCH_FULL_MAP_SNAP) {
      pinchVp = undefined;
      return;
    }
    if (state && state.phase === Phase.BATTLE) {
      phasePinch.battle = { ...pinchVp };
    } else {
      phasePinch.build = { ...pinchVp };
    }
  }

  // --- Lifecycle commands ---

  /** Park `onReady` to fire the first frame whose drawFrame ran at
   *  fullMapVp AND pitch settled at 0. Callers (the phase machine's
   *  `runTransition`) wait for that callback before running mutate +
   *  display, which guarantees the banner's prev-scene capture reads a
   *  full-map-rendered, flat pre-mutation frame.
   *
   *  Flattens the pitch target as part of the request — battle→build
   *  transitions need the banner to capture a flat scene, and this is
   *  the one point where we know "a display chain is about to run"
   *  (after postDisplay, `beginBattleTilt` may re-tilt and we must not
   *  undo that from the overlay-unzoom path).
   *
   *  Viewport flatten is separate, driven by `unzoomForOverlays` on
   *  `frameCtx.shouldUnzoom` (which includes `isTransition`, so
   *  `setMode(Mode.TRANSITION)` before this call drives convergence). */
  function onCameraReady(onReady: () => void): void {
    setPitchTarget(0);
    pendingUnzoomReady = onReady;
  }

  /** Post-render hook. Called by the render loop AFTER drawFrame so the
   *  parked `onReady` fires on the frame whose pixels reflect the
   *  full-map flat view — any `captureScene` inside the callback reads
   *  those pixels, not a mid-lerp one. Checks `lastVp === undefined`
   *  (updateViewport sets that exactly when currentVp has converged to
   *  fullMapVp) AND pitch settled at 0 (tickPitch parks `currentPitch`
   *  at `targetPitch` on the settle frame, and in 2D mode pitch is
   *  hard-zeroed so the second clause is trivially true). */
  function onRenderedFrame(): void {
    if (pendingUnzoomReady === undefined) return;
    if (lastVp !== undefined) return;
    if (currentPitch !== 0 || targetPitch !== 0) return;
    const ready = pendingUnzoomReady;
    pendingUnzoomReady = undefined;
    ready();
  }

  /** Clear all zoom state including per-phase pinch memory.
   *  Use for full resets (rematch, return to lobby). */
  function clearAllZoomState(): void {
    cameraZone = undefined;
    pinchVp = undefined;
    phasePinch.build = undefined;
    phasePinch.battle = undefined;
  }

  function resetCamera(): void {
    cameraZone = undefined;
    pinchVp = undefined;
    phasePinch.build = undefined;
    phasePinch.battle = undefined;
    castleBuildVp = undefined;
    lastAutoZoomPhase = undefined;
    selectionZoom.applied = false;
    selectionZoom.pendingVp = undefined;
    cachedZoneBounds.clear();
    // Re-arm auto-zoom for the next match. `zoomActivated` is toggled
    // off in-game when the player taps the touch zoom-home button on
    // their own zone (`setCameraZone(undefined)`); the next game
    // bootstrap runs through here and starts with auto-zoom on if the
    // device supports it.
    zoomActivated = mobileZoomEnabled;
    // Snap viewport to full map so there's no lerp animation on game start
    currentVp.x = fullMapVp.x;
    currentVp.y = fullMapVp.y;
    currentVp.w = fullMapVp.w;
    currentVp.h = fullMapVp.h;
    currentPitch = 0;
    targetPitch = 0;
    pitchAnimFrom = 0;
    pitchAnimElapsed = PITCH_DURATION;
    pitchState = "flat";
  }

  /** Request an immediate untilt. Idempotent. Standalone path for the
   *  rare "flatten pitch but keep zoom" case; the transition path goes
   *  through `unzoomForOverlays` (flattens pitch + clears viewport). */
  function beginUntilt(): void {
    setPitchTarget(0);
  }

  /** Start the build→battle tilt. Called explicitly from the phase
   *  machine at battle-banner end (inside `proceedToBattle`) so the
   *  tilt animation plays with the camera already at fullMapVp,
   *  BEFORE balloons / "ready" / auto-zoom into the battle zone.
   *  2D mode: no-op — `tickPitch` hard-zeros pitch when the renderer
   *  isn't 3d, so the target we set here is overwritten next tick. */
  function beginBattleTilt(): void {
    setPitchTarget(TILT_BATTLE_PITCH);
  }

  /** Current pitch state machine value. When tilt is disabled (headless)
   *  always `"flat"` — pitch is hard-zeroed by `tickPitch`. Subscribers
   *  that need the settle edge should listen for `GAME_EVENT.PITCH_SETTLED`
   *  instead — this getter is for call sites that already poll per tick. */
  function getPitchState(): PitchState {
    if (!deps.cameraTiltEnabled) return "flat";
    return pitchState;
  }

  function setCameraZone(zone: number | undefined): void {
    const state = deps.getState();
    cameraZone = zone;
    zoomActivated = zone !== undefined;
    pinchVp = undefined;
    if (state && state.phase === Phase.BATTLE) {
      phasePinch.battle = undefined;
    } else {
      phasePinch.build = undefined;
    }
  }

  /** Zoom around a tower during selection (5 tiles around for context). */
  function setSelectionViewport(towerRow: number, towerCol: number): void {
    if (!mobileZoomEnabled || !zoomActivated) return;
    // Block until the "Select your home castle" banner delay has elapsed
    if (!selectionZoom.applied || lastAutoZoomPhase === undefined) {
      selectionZoom.pendingVp = { row: towerRow, col: towerCol };
      return;
    }
    selectionZoom.pendingVp = undefined;
    castleBuildVp = fitTileBoundsToViewport(
      {
        minR: towerRow,
        maxR: towerRow + 1,
        minC: towerCol,
        maxC: towerCol + 1,
      },
      ZONE_PAD_SELECTION,
    );
  }

  function setCastleBuildViewport(
    wallPlans: readonly { playerId: ValidPlayerSlot; tiles: number[] }[],
  ): void {
    castleBuildVp = computeCastleBuildViewport(wallPlans);
  }

  function clearCastleBuildViewport(): void {
    castleBuildVp = undefined;
  }

  function enableMobileZoom(): void {
    mobileZoomEnabled = true;
    zoomActivated = true;
  }

  /** Re-engage the current phase's auto-zoom. Used at life-lost popup
   *  time: the scores overlay ran unzoomed, and the spec calls for the
   *  camera to zoom into the pov player's zone before the popup shows
   *  (`scores → zoom → life lost popup`). `handlePhaseChangeZoom` can't
   *  trigger it — the phase hasn't changed — so the phase machine calls
   *  this directly. No-op when auto-zoom is disabled. */
  function engageAutoZoom(): void {
    const state = deps.getState();
    if (!state) return;
    if (!(mobileZoomEnabled && zoomActivated)) return;
    autoZoom(state.phase);
  }

  // --- Touch battle targeting ---

  /** Crosshair position from the previous battle (null = first battle). */
  let lastBattleCrosshair: { x: number; y: number } | undefined;

  /** Compute target position for the human crosshair at battle start (touch devices).
   *  Delegates targeting logic to battleTargetPosition(); camera owns only the
   *  mobile-zoom guard and lastBattleCrosshair state. */
  function computeBattleTarget(): { x: number; y: number } | null {
    const state = deps.getState();
    if (!state) return null;
    if (!(mobileZoomEnabled && zoomActivated)) return null;

    const target = battleTargetPosition(
      state.players,
      state.playerZones,
      state.map.zones,
      povPlayerId(),
      lastBattleCrosshair,
    );
    if (target) lastBattleCrosshair = { x: target.x, y: target.y };
    return target;
  }

  /** Store a crosshair position for restoration at the next battle start. */
  function saveBattleCrosshair(pos: { x: number; y: number }): void {
    lastBattleCrosshair = { x: pos.x, y: pos.y };
  }

  function resetBattleCrosshair(): void {
    lastBattleCrosshair = undefined;
  }

  // --- Return public API ---

  return {
    tickCamera,
    updateViewport,
    getViewport,
    getPitch: () => currentPitch,
    beginUntilt,
    beginBattleTilt,
    getPitchState,
    screenToWorld,
    pickHitWorld,
    worldToScreen,
    pixelToTile,
    onPinchStart,
    onPinchUpdate,
    onPinchEnd,
    povPlayerId,
    getMyZone,
    getBestEnemyZone,
    getEnemyZones,
    computeZoneBounds,
    onCameraReady,
    onRenderedFrame,
    getCameraZone: () => cameraZone,
    setCameraZone,
    clearAllZoomState,
    resetCamera,
    setSelectionViewport,
    setCastleBuildViewport,
    clearCastleBuildViewport,
    enableMobileZoom,
    engageAutoZoom,
    isMobileAutoZoom: () => mobileZoomEnabled && zoomActivated,
    computeBattleTarget,
    saveBattleCrosshair,
    resetBattleCrosshair,
  };
}

/** Cheap fingerprint for a wall set — count combined with sum of keys. */
function wallSetHash(walls: ReadonlySet<number> | undefined): number {
  if (!walls || walls.size === 0) return 0;
  let sum = 0;
  for (const key of walls) sum = (sum + key) | 0;
  return (walls.size << 20) ^ sum;
}
