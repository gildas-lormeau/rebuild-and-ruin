/**
 * Camera / zoom system — extracted from runtime-composition.ts.
 *
 * Owns all viewport state (zone bounds, pinch zoom, auto-zoom, lerp)
 * and exposes a pure API for the runtime to call.
 *
 * NOTE: Uses the all-getters deps pattern (not destructured runtimeState) because
 * camera state can change during host migration — every field must be re-read via
 * getter to avoid stale references. See CameraDeps interface below and the
 * convention note in runtime-types.ts.
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
import { isReselectPhase, Phase } from "../shared/core/game-phase.ts";
import type {
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
import type { RendererKind } from "../shared/ui/player-config.ts";
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
  getRendererKind: () => RendererKind;
  setFrameAnnouncement: (text: string) => void;
  getPointerPlayerCrosshair?: () => { x: number; y: number } | null;
}

const CANVAS_SIZE = { w: CANVAS_W, h: CANVAS_H } as const;
/** Target pitch when entering battle: 30° classic isometric / Rampart 3/4 view. */
const TILT_BATTLE_PITCH = Math.PI / 6;
/** Pitch animation duration (seconds). CSS `transition: Xms ease-out` equivalent. */
const PITCH_DURATION = 0.6;

// Note: unlike other sub-systems, CameraDeps is all getters — no runtimeState to destructure.
// State is accessed via deps.getState(), deps.getCtx(), etc. throughout.
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

  // Pitch animation — targetPitch is re-set on phase-enter (see
  // handlePhaseChangeZoom); currentPitch eases toward target each tick
  // in tickCamera. Gated on rendererKind=3d — 2D mode has no place to
  // apply tilt, so we keep both values at 0 there.
  // TODO(step-6): loupe (render-loupe.ts) and auto-zoom fit
  // (fitTileBoundsToViewport) are pitch-agnostic; under tilt the loupe
  // crop and zone fit are slightly off. Cosmetic at 30°; fix in step 6.
  let currentPitch = 0;
  let targetPitch = 0;
  let pitchAnimFrom = 0;
  let pitchAnimElapsed = PITCH_DURATION;

  function setPitchTarget(next: number): void {
    if (next === targetPitch) return;
    pitchAnimFrom = currentPitch;
    targetPitch = next;
    pitchAnimElapsed = 0;
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

  /** Ease currentPitch toward targetPitch each frame. Hard-zero in 2D mode so
   *  stale state from a previous 3D session can't leak into a 2D screen↔world
   *  conversion. */
  function tickPitch(): void {
    if (deps.getRendererKind() !== "3d") {
      currentPitch = 0;
      targetPitch = 0;
      pitchAnimFrom = 0;
      pitchAnimElapsed = PITCH_DURATION;
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
  }

  /** Clear zoom when UI overlays or phase-end unzoom is active. */
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
    } else if (
      mobileAuto &&
      !(frameCtx.mode === Mode.SELECTION && lastAutoZoomPhase === undefined)
    ) {
      autoZoom(state.phase);
    }
    // Camera pitch target: battle enters get the classic 3/4 tilt; every
    // other phase (including lobby/select/reselect/build/upgrade-pick)
    // rests flat. Applies to everyone, not just mobileAuto — the tilt is
    // a presentational cue independent of auto-zoom.
    setPitchTarget(state.phase === Phase.BATTLE ? TILT_BATTLE_PITCH : 0);
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
    const { wx, wy } = screenToWorld(x, y);
    return {
      col: Math.max(0, Math.min(GRID_COLS - 1, pxToTile(wx))),
      row: Math.max(0, Math.min(GRID_ROWS - 1, pxToTile(wy))),
    };
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

  /** Clear current zoom but preserve per-phase pinch memory (battle↔build).
   *  Use for phase transitions where the player may return to the same zoom.
   *  Resets lastAutoZoomPhase so handlePhaseChangeZoom re-fires autoZoom
   *  when the next interactive mode begins (fixes upgrade-pick → banner → build). */
  function clearPhaseZoom(): void {
    cameraZone = undefined;
    pinchVp = undefined;
    lastAutoZoomPhase = undefined;
    cachedZoneBounds.clear();
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
    // Snap viewport to full map so there's no lerp animation on game start
    currentVp.x = fullMapVp.x;
    currentVp.y = fullMapVp.y;
    currentVp.w = fullMapVp.w;
    currentVp.h = fullMapVp.h;
    currentPitch = 0;
    targetPitch = 0;
  }

  /** Request an immediate untilt. Called from the phase-ticks system at
   *  battle-end, BEFORE the banner captures, so the banner's prev-scene
   *  snapshot is flat. Idempotent — safe to call every tick while waiting
   *  for `isPitchSettled()` to return true. */
  function beginUntilt(): void {
    setPitchTarget(0);
  }

  /** True when the pitch animation has reached its target. In 2D mode
   *  always true (pitch is hard-zeroed). Used by the phase-ticks system
   *  to gate the battle-end banner capture on the untilt easing. */
  function isPitchSettled(): boolean {
    if (deps.getRendererKind() !== "3d") return true;
    return pitchAnimElapsed >= PITCH_DURATION;
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
    isPitchSettled,
    screenToWorld,
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
    clearPhaseZoom,
    getCameraZone: () => cameraZone,
    setCameraZone,
    clearAllZoomState,
    resetCamera,
    setSelectionViewport,
    setCastleBuildViewport,
    clearCastleBuildViewport,
    enableMobileZoom,
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
