/**
 * Camera / zoom system — extracted from runtime.ts.
 *
 * Owns all viewport state (zone bounds, pinch zoom, auto-zoom, lerp)
 * and exposes a pure API for the runtime to call.
 */

import {
  MAX_ZOOM_VIEWPORT_RATIO,
  MIN_ZOOM_RATIO,
  PINCH_FULL_MAP_SNAP,
  VIEWPORT_SNAP_THRESHOLD,
  ZONE_PAD_NO_WALLS,
  ZONE_PAD_SELECTION,
  ZONE_PAD_WITH_WALLS,
  ZOOM_LERP_SPEED,
} from "./game-constants.ts";
import type { TilePos, WorldPos } from "./geometry-types.ts";
import {
  CANVAS_H,
  CANVAS_W,
  GRID_COLS,
  GRID_ROWS,
  SCALE,
  TILE_SIZE,
} from "./grid.ts";
import type { Viewport } from "./render-types.ts";
import type { CameraSystem } from "./runtime-types.ts";
import { pxToTile, towerCenterPx, unpackTile } from "./spatial.ts";
import {
  type FrameContext,
  type GameState,
  isReselectPhase,
  isTransitionMode,
  Mode,
  Phase,
} from "./types.ts";

interface CameraDeps {
  getState: () => GameState | undefined;
  getCtx: () => FrameContext;
  getFrameDt: () => number;
  setFrameAnnouncement: (text: string) => void;
  getFirstHumanCrosshair?: () => { x: number; y: number } | null;
  /** Set the first human's crosshair position (for battle targeting). */
  setFirstHumanCrosshair?: (x: number, y: number) => void;
}

// Note: unlike other sub-systems, CameraDeps is all getters — no rs to destructure.
// State is accessed via deps.getState(), deps.getCtx(), etc. throughout.
export function createCameraSystem(deps: CameraDeps): CameraSystem {
  // --- Internal state ---

  // Platform & session flags
  let mobileZoomEnabled = false;
  let zoomActivated = false;

  // Zoom targets (priority in updateViewport: castleBuildVp > pinchVp > cameraZone > fullMap)
  let cameraZone: number | null = null;
  let pinchVp: Viewport | null = null;
  let castleBuildVp: Viewport | null = null;
  let lastAutoZoomPhase: Phase | null = null;

  // Pinch gesture — transient state, non-null only during an active two-finger gesture
  interface ActivePinch {
    readonly startVp: Viewport;
    startMidX: number;
    startMidY: number;
  }
  let activePinch: ActivePinch | null = null;

  // Per-phase pinch memory — saved/restored on phase transitions so each phase
  // remembers its own user-chosen zoom level independently
  const phasePinch: { build: Viewport | null; battle: Viewport | null } = {
    build: null,
    battle: null,
  };

  // Selection zoom lifecycle — tracks the one-time deferred zoom to the
  // player's home tower after the "Select your castle" announcement finishes
  const selectionZoom: { applied: boolean; pendingVp: TilePos | null } = {
    applied: false,
    pendingVp: null,
  };
  const MIN_ZOOM_W = GRID_COLS * TILE_SIZE * MIN_ZOOM_RATIO;
  const cachedZoneBounds: Map<number, { vp: Viewport; wallCount: number }> =
    new Map();

  const fullMapVp: Viewport = {
    x: 0,
    y: 0,
    w: GRID_COLS * TILE_SIZE,
    h: GRID_ROWS * TILE_SIZE,
  };
  const currentVp: Viewport = { ...fullMapVp };
  let lastVp: Viewport | null = null;

  // --- Helpers ---

  function myPlayerId(): number {
    const ctx = deps.getCtx();
    const pid = ctx.myPlayerId;
    return pid >= 0 ? pid : ctx.firstHumanPlayerId;
  }

  function getMyZone(): number | null {
    const state = deps.getState();
    if (!state) return null;
    const pid = myPlayerId();
    if (pid < 0) return null;
    return state.playerZones[pid] ?? null;
  }

  function getBestEnemyZone(): number | null {
    const state = deps.getState();
    if (!state) return null;
    const myPid = myPlayerId();
    let bestPid = -1,
      bestScore = -1;
    for (let i = 0; i < state.players.length; i++) {
      if (i === myPid || state.players[i]!.eliminated) continue;
      if (state.players[i]!.score > bestScore) {
        bestScore = state.players[i]!.score;
        bestPid = i;
      }
    }
    if (bestPid < 0) return null;
    return state.playerZones[bestPid] ?? null;
  }

  function getEnemyZones(): number[] {
    const state = deps.getState();
    if (!state) return [];
    const myPid = myPlayerId();
    const zones: number[] = [];
    for (let i = 0; i < state.players.length; i++) {
      if (i === myPid || state.players[i]!.eliminated) continue;
      const z = state.playerZones[i];
      if (z !== undefined && !zones.includes(z)) zones.push(z);
    }
    return zones;
  }

  function boundsToViewport(
    minR: number,
    maxR: number,
    minC: number,
    maxC: number,
    pad: number,
  ): Viewport {
    minR = Math.max(0, minR - pad);
    maxR = Math.min(GRID_ROWS - 1, maxR + pad);
    minC = Math.max(0, minC - pad);
    maxC = Math.min(GRID_COLS - 1, maxC + pad);
    const fullW = GRID_COLS * TILE_SIZE,
      fullH = GRID_ROWS * TILE_SIZE;
    const maxW = fullW * MAX_ZOOM_VIEWPORT_RATIO,
      maxH = fullH * MAX_ZOOM_VIEWPORT_RATIO;
    const targetAspect = GRID_COLS / GRID_ROWS;
    const w = (maxC - minC + 1) * TILE_SIZE,
      h = (maxR - minR + 1) * TILE_SIZE;
    const vpAspect = w / h;
    const newW =
      vpAspect < targetAspect
        ? Math.min(maxW, h * targetAspect)
        : Math.min(maxW, Math.min(maxH, w / targetAspect) * targetAspect);
    const newH = newW / targetAspect;
    const cx = ((minC + maxC + 1) * TILE_SIZE) / 2,
      cy = ((minR + maxR + 1) * TILE_SIZE) / 2;
    const x = Math.max(0, Math.min(fullW - newW, cx - newW / 2));
    const y = Math.max(0, Math.min(fullH - newH, cy - newH / 2));
    return { x, y, w: newW, h: newH };
  }

  interface Bounds {
    minR: number;
    maxR: number;
    minC: number;
    maxC: number;
  }

  function newBounds(): Bounds {
    return { minR: GRID_ROWS, maxR: 0, minC: GRID_COLS, maxC: 0 };
  }

  function expandBounds(b: Bounds, r: number, c: number): void {
    if (r < b.minR) b.minR = r;
    if (r > b.maxR) b.maxR = r;
    if (c < b.minC) b.minC = c;
    if (c > b.maxC) b.maxC = c;
  }

  function computeZoneBounds(zoneId: number): Viewport {
    const state = deps.getState()!;
    const pid = state.playerZones.indexOf(zoneId);
    const player = pid >= 0 ? state.players[pid] : undefined;

    const cached = cachedZoneBounds.get(zoneId);
    if (cached && cached.wallCount === (player?.walls.size ?? 0))
      return cached.vp;

    const b = newBounds();

    if (player && player.walls.size > 0) {
      for (const key of player.walls) {
        const { r, c } = unpackTile(key);
        expandBounds(b, r, c);
      }
      if (player.homeTower)
        expandBounds(b, player.homeTower.row, player.homeTower.col);
    } else {
      const zones = state.map.zones;
      for (let r = 0; r < GRID_ROWS; r++) {
        for (let c = 0; c < GRID_COLS; c++) {
          if (zones[r]![c] === zoneId) expandBounds(b, r, c);
        }
      }
    }

    const pad =
      player && player.walls.size > 0 ? ZONE_PAD_WITH_WALLS : ZONE_PAD_NO_WALLS;
    const result = boundsToViewport(b.minR, b.maxR, b.minC, b.maxC, pad);
    cachedZoneBounds.set(zoneId, {
      vp: result,
      wallCount: player?.walls.size ?? 0,
    });
    return result;
  }

  function computeCastleBuildViewport(
    wallPlans: readonly { playerId: number; tiles: number[] }[],
  ): Viewport {
    const state = deps.getState()!;
    const myPid = myPlayerId();
    const plan = wallPlans.find((p) => p.playerId === myPid) ?? wallPlans[0];
    if (!plan || plan.tiles.length === 0) return fullMapVp;
    const player = state.players[plan.playerId];
    const b = newBounds();
    for (const key of plan.tiles) {
      const { r, c } = unpackTile(key);
      expandBounds(b, r, c);
    }
    if (player?.homeTower)
      expandBounds(b, player.homeTower.row, player.homeTower.col);
    return boundsToViewport(
      b.minR,
      b.maxR,
      b.minC,
      b.maxC,
      ZONE_PAD_WITH_WALLS,
    );
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
    pinchVp = candidate ? { ...candidate } : null;
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
    const ch = deps.getFirstHumanCrosshair?.();
    if (!ch) return null;
    const zone = zoneAtPixel(ch.x, ch.y);
    if (zone === null || zone === getMyZone()) return null;
    return zone;
  }

  function autoZoom(phase: Phase): void {
    // No auto-zoom when spectating (no human player)
    if (myPlayerId() < 0) return;
    if (phase === Phase.BATTLE) {
      swapPinchViewport(true);
      // If pinch points at own zone, reset — always pick enemy
      const myZone = getMyZone();
      if (pinchVp && myZone !== null) {
        const zb = computeZoneBounds(myZone);
        const cx = pinchVp.x + pinchVp.w / 2;
        const cy = pinchVp.y + pinchVp.h / 2;
        if (
          cx >= zb.x &&
          cx <= zb.x + zb.w &&
          cy >= zb.y &&
          cy <= zb.y + zb.h
        ) {
          pinchVp = null;
          phasePinch.battle = null;
        }
      }
      if (pinchVp) {
        cameraZone = null;
      } else {
        // Camera follows crosshair zone; fall back to best enemy
        cameraZone = crosshairZone() ?? getBestEnemyZone();
      }
    } else {
      swapPinchViewport(false);
      if (pinchVp) {
        cameraZone = null;
      } else {
        cameraZone = getMyZone();
      }
    }
  }

  // --- Per-frame tick ---

  let wasPaused = false;
  let wasQuitPending = false;

  function tickCamera(): void {
    const state = deps.getState();
    if (!state) return;
    const ctx = deps.getCtx();
    const mobileAuto = mobileZoomEnabled && zoomActivated;

    unzoomForOverlays(state, ctx);
    restoreZoomAfterModal(mobileAuto, state, ctx);
    handleSelectionZoom(mobileAuto, state, ctx);
    const notTransition = isNotTransitionMode(ctx);
    handlePhaseChangeZoom(mobileAuto, state, ctx, notTransition);
    followCrosshairInBattle(mobileAuto, state, ctx, notTransition);
  }

  /** Clear zoom when UI overlays or phase-end unzoom is active. */
  function unzoomForOverlays(state: GameState, ctx: FrameContext): void {
    if (
      !ctx.shouldUnzoom ||
      (cameraZone === null && pinchVp === null && castleBuildVp === null)
    )
      return;
    savePinchForCurrentPhase(state.phase === Phase.BATTLE);
    cameraZone = null;
    pinchVp = null;
    castleBuildVp = null;
  }

  /** Re-engage auto-zoom when pause or quit dialog is dismissed (mobile only). */
  function restoreZoomAfterModal(
    mobileAuto: boolean,
    state: GameState,
    ctx: FrameContext,
  ): void {
    if (
      mobileAuto &&
      ((wasPaused && !ctx.paused) || (wasQuitPending && !ctx.quitPending))
    ) {
      autoZoom(state.phase);
    }
    wasPaused = ctx.paused;
    wasQuitPending = ctx.quitPending;
  }

  /** Auto-zoom to selection after announcement finishes. */
  function handleSelectionZoom(
    mobileAuto: boolean,
    state: GameState,
    ctx: FrameContext,
  ): void {
    if (
      ctx.mode !== Mode.SELECTION ||
      selectionZoom.applied ||
      !ctx.isSelectionReady
    )
      return;
    selectionZoom.applied = true;
    if (!mobileAuto) return;
    if (!isReselectPhase(state.phase) || ctx.humanIsReselecting) {
      autoZoom(state.phase);
    }
    if (selectionZoom.pendingVp) {
      castleBuildVp = boundsToViewport(
        selectionZoom.pendingVp.row,
        selectionZoom.pendingVp.row + 1,
        selectionZoom.pendingVp.col,
        selectionZoom.pendingVp.col + 1,
        ZONE_PAD_SELECTION,
      );
      selectionZoom.pendingVp = null;
    }
  }

  function isNotTransitionMode(ctx: FrameContext): boolean {
    return !isTransitionMode(ctx.mode);
  }

  /** Auto-zoom when the game phase changes (mobile only, skip during transitions). */
  function handlePhaseChangeZoom(
    mobileAuto: boolean,
    state: GameState,
    ctx: FrameContext,
    notTransition: boolean,
  ): void {
    if (state.phase === lastAutoZoomPhase || !notTransition) return;
    if (state.phase === Phase.CASTLE_RESELECT) {
      selectionZoom.applied = false;
      if (mobileAuto && ctx.humanIsReselecting) {
        autoZoom(state.phase);
      }
    } else if (
      mobileAuto &&
      !(ctx.mode === Mode.SELECTION && lastAutoZoomPhase === null)
    ) {
      autoZoom(state.phase);
    }
    lastAutoZoomPhase = state.phase;
  }

  /** Track crosshair zone during battle for camera follow (mobile only). */
  function followCrosshairInBattle(
    mobileAuto: boolean,
    state: GameState,
    ctx: FrameContext,
    notTransition: boolean,
  ): void {
    if (
      !mobileAuto ||
      state.phase !== Phase.BATTLE ||
      pinchVp ||
      ctx.shouldUnzoom ||
      !notTransition
    )
      return;
    const zone = crosshairZone();
    if (zone !== null && zone !== cameraZone) {
      cameraZone = zone;
    }
  }

  // --- Viewport lerp ---

  function updateViewport(): Viewport | null {
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
    } else if (cameraZone !== null) {
      target = computeZoneBounds(cameraZone);
    } else {
      target = fullMapVp;
    }

    const t = Math.min(1, ZOOM_LERP_SPEED * deps.getFrameDt());
    currentVp.x += (target.x - currentVp.x) * t;
    currentVp.y += (target.y - currentVp.y) * t;
    currentVp.w += (target.w - currentVp.w) * t;
    currentVp.h += (target.h - currentVp.h) * t;

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
      lastVp = null;
    } else {
      lastVp = currentVp;
    }
    return lastVp;
  }

  function getViewport(): Viewport | null {
    return lastVp;
  }

  // --- Coordinate conversion ---

  function screenToWorld(x: number, y: number): WorldPos {
    const vp = getViewport();
    if (!vp) return { wx: x / SCALE, wy: y / SCALE };
    return {
      wx: vp.x + (x / CANVAS_W) * vp.w,
      wy: vp.y + (y / CANVAS_H) * vp.h,
    };
  }

  /** Inverse of screenToWorld: world-pixel → canvas backing-store pixel. */
  function worldToScreen(wx: number, wy: number): { sx: number; sy: number } {
    const vp = getViewport();
    if (!vp) return { sx: wx * SCALE, sy: wy * SCALE };
    return {
      sx: ((wx - vp.x) / vp.w) * CANVAS_W,
      sy: ((wy - vp.y) / vp.h) * CANVAS_H,
    };
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
    if (mode !== Mode.GAME && mode !== Mode.SELECTION) return;
    activePinch = {
      startVp: { ...currentVp },
      startMidX: midX,
      startMidY: midY,
    };
  }

  function onPinchUpdate(midX: number, midY: number, scale: number): void {
    const { mode } = deps.getCtx();
    if (!activePinch || (mode !== Mode.GAME && mode !== Mode.SELECTION)) return;
    const newW = Math.max(
      MIN_ZOOM_W,
      Math.min(fullMapVp.w, activePinch.startVp.w * scale),
    );
    const newH = newW * (fullMapVp.h / fullMapVp.w);

    const anchorWx =
      activePinch.startVp.x +
      (activePinch.startMidX / CANVAS_W) * activePinch.startVp.w;
    const anchorWy =
      activePinch.startVp.y +
      (activePinch.startMidY / CANVAS_H) * activePinch.startVp.h;

    let x = anchorWx - (midX / CANVAS_W) * newW;
    let y = anchorWy - (midY / CANVAS_H) * newH;

    x = Math.max(0, Math.min(fullMapVp.w - newW, x));
    y = Math.max(0, Math.min(fullMapVp.h - newH, y));

    pinchVp = { x, y, w: newW, h: newH };
    currentVp.x = x;
    currentVp.y = y;
    currentVp.w = newW;
    currentVp.h = newH;
    lastVp = currentVp;
    cameraZone = null;
    zoomActivated = true;
  }

  function onPinchEnd(): void {
    const state = deps.getState();
    activePinch = null;
    if (!pinchVp) return;
    if (pinchVp.w >= fullMapVp.w * PINCH_FULL_MAP_SNAP) {
      pinchVp = null;
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
   *  Use for phase transitions where the player may return to the same zoom. */
  function phaseUnzoom(): void {
    cameraZone = null;
    pinchVp = null;
  }

  /** Clear all zoom state including per-phase pinch memory.
   *  Use for full resets (rematch, return to lobby). */
  function fullUnzoom(): void {
    cameraZone = null;
    pinchVp = null;
    phasePinch.build = null;
    phasePinch.battle = null;
  }

  function resetCamera(): void {
    cameraZone = null;
    pinchVp = null;
    phasePinch.build = null;
    phasePinch.battle = null;
    castleBuildVp = null;
    lastAutoZoomPhase = null;
    selectionZoom.applied = false;
    selectionZoom.pendingVp = null;
    cachedZoneBounds.clear();
    // Snap viewport to full map so there's no lerp animation on game start
    currentVp.x = fullMapVp.x;
    currentVp.y = fullMapVp.y;
    currentVp.w = fullMapVp.w;
    currentVp.h = fullMapVp.h;
  }

  function setCameraZone(z: number | null): void {
    const state = deps.getState();
    cameraZone = z;
    zoomActivated = z !== null;
    pinchVp = null;
    if (state && state.phase === Phase.BATTLE) {
      phasePinch.battle = null;
    } else {
      phasePinch.build = null;
    }
  }

  /** Zoom around a tower during selection (5 tiles around for context). */
  function setSelectionViewport(towerRow: number, towerCol: number): void {
    if (!mobileZoomEnabled || !zoomActivated) return;
    // Block until the "Select your home castle" banner delay has elapsed
    if (!selectionZoom.applied || lastAutoZoomPhase === null) {
      selectionZoom.pendingVp = { row: towerRow, col: towerCol };
      return;
    }
    selectionZoom.pendingVp = null;
    castleBuildVp = boundsToViewport(
      towerRow,
      towerRow + 1,
      towerCol,
      towerCol + 1,
      ZONE_PAD_SELECTION,
    );
  }

  function setCastleBuildViewport(
    wallPlans: readonly { playerId: number; tiles: number[] }[],
  ): void {
    castleBuildVp = computeCastleBuildViewport(wallPlans);
  }

  function clearCastleBuildViewport(): void {
    castleBuildVp = null;
  }

  function enableMobileZoom(): void {
    mobileZoomEnabled = true;
    zoomActivated = true;
  }

  // --- Touch battle targeting ---

  /** Crosshair position from the previous battle (null = first battle). */
  let lastBattleCrosshair: { x: number; y: number } | null = null;

  /**
   * Position the human crosshair at the start of battle (touch devices).
   * - First battle: aim at best enemy's home tower.
   * - Subsequent battles: restore last position (unless that opponent died).
   * - Without auto-zoom: don't move the cursor (first tap positions it).
   */
  function aimAtEnemyCastle(): void {
    const state = deps.getState();
    if (!state) return;
    if (!deps.setFirstHumanCrosshair) return;
    if (!(mobileZoomEnabled && zoomActivated)) return;

    // Subsequent battle: restore last position if targeted opponent is alive
    if (lastBattleCrosshair) {
      const row = pxToTile(lastBattleCrosshair.y);
      const col = pxToTile(lastBattleCrosshair.x);
      const zone = state.map.zones[row]?.[col];
      if (zone !== undefined) {
        const pid = state.playerZones.indexOf(zone);
        if (
          pid >= 0 &&
          pid !== myPlayerId() &&
          !state.players[pid]?.eliminated
        ) {
          deps.setFirstHumanCrosshair(
            lastBattleCrosshair.x,
            lastBattleCrosshair.y,
          );
          return;
        }
      }
      // Targeted opponent died or invalid — fall through to best enemy
    }

    // First battle or opponent died: aim at best enemy's home tower
    const zone = getBestEnemyZone();
    if (zone === null) return;
    const pid = state.playerZones.indexOf(zone);
    const tower = pid >= 0 ? state.players[pid]?.homeTower : null;
    if (!tower) return;
    const px = towerCenterPx(tower);
    deps.setFirstHumanCrosshair(px.x, px.y);
    lastBattleCrosshair = { x: px.x, y: px.y };
  }

  function saveBattleCrosshair(): void {
    const ch = deps.getFirstHumanCrosshair?.();
    if (ch) lastBattleCrosshair = { x: ch.x, y: ch.y };
  }

  function resetBattleCrosshair(): void {
    lastBattleCrosshair = null;
  }

  // --- Return public API ---

  return {
    tickCamera,
    updateViewport,
    getViewport,
    screenToWorld,
    worldToScreen,
    pixelToTile,
    onPinchStart,
    onPinchUpdate,
    onPinchEnd,
    myPlayerId,
    getMyZone,
    getBestEnemyZone,
    getEnemyZones,
    computeZoneBounds,
    phaseUnzoom,
    getCameraZone: () => cameraZone,
    setCameraZone,
    fullUnzoom,
    resetCamera,
    setSelectionViewport,
    setCastleBuildViewport,
    clearCastleBuildViewport,
    enableMobileZoom,
    isMobileAutoZoom: () => mobileZoomEnabled && zoomActivated,
    aimAtEnemyCastle,
    saveBattleCrosshair,
    resetBattleCrosshair,
  };
}
