/**
 * Camera / zoom system — extracted from game-runtime.ts.
 *
 * Owns all viewport state (zone bounds, pinch zoom, auto-zoom, lerp)
 * and exposes a pure API for the runtime to call.
 */

import { BANNER_SELECT } from "./game-engine.ts";
import { Mode } from "./game-ui-types.ts";
import type { WorldPos } from "./geometry-types.ts";
import { GRID_COLS, GRID_ROWS, SCALE, TILE_SIZE } from "./grid.ts";
import type { Viewport } from "./render-types.ts";
import { unpackTile } from "./spatial.ts";
import type { GameState } from "./types.ts";
import { Phase } from "./types.ts";


// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

interface CameraDeps {
  getState: () => GameState | undefined;
  getMode: () => Mode;
  getQuitPending: () => boolean;
  hasLifeLostDialog: () => boolean;
  getPaused: () => boolean;
  getFrameDt: () => number;
  setFrameAnnouncement: (text: string) => void;
  getMyPlayerId: () => number;
  getFirstHumanPlayerId: () => number;
}

interface CameraSystem {
  // Per-frame lifecycle
  tickCamera: (dt: number) => void;
  updateViewport: () => Viewport | null;

  // Coordinate conversion
  getViewport: () => Viewport | null;
  screenToWorld: (x: number, y: number) => WorldPos;
  pixelToTile: (x: number, y: number) => { row: number; col: number };

  // Pinch gesture handlers
  onPinchStart: (midX: number, midY: number) => void;
  onPinchUpdate: (midX: number, midY: number, scale: number) => void;
  onPinchEnd: () => void;

  // Zone queries
  myPlayerId: () => number;
  getMyZone: () => number | null;
  getBestEnemyZone: () => number | null;
  getEnemyZones: () => number[];

  // Zone bounds (used by advanceToCannonPhase for score delta positions)
  computeZoneBounds: (zoneId: number) => Viewport;

  // Zoom state
  getCameraZone: () => number | null;
  setCameraZone: (zone: number | null) => void;

  // Lifecycle commands
  /** Light unzoom: clear cameraZone + pinchVp only (preserves per-phase memory for autoZoom restore). */
  unzoomForBanner: () => void;
  /** Full unzoom: clear all zoom state for returnToLobby/endGame. */
  unzoom: () => void;
  /** Full reset for rematch. */
  resetCamera: () => void;

  // Castle build viewport
  setCastleBuildViewport: (wallPlans: { playerId: number; tiles: number[] }[]) => void;
  clearCastleBuildViewport: () => void;

  // Mobile zoom
  enableMobileZoom: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCameraSystem(deps: CameraDeps): CameraSystem {
  // --- Internal state ---
  let cameraZone: number | null = null;
  let battleZoom: number | null = null;
  let lastAutoZoomPhase: Phase | null = null;
  let mobileZoomEnabled = false;
  let zoomActivated = false;
  let selectionZoomDelay = 0;
  let pinchVp: Viewport | null = null;
  let pinchStartVp: Viewport | null = null;
  let pinchStartMidX = 0;
  let pinchStartMidY = 0;
  let castleBuildVp: Viewport | null = null;
  let buildPinchVp: Viewport | null = null;
  let battlePinchVp: Viewport | null = null;
  const MIN_ZOOM_W = GRID_COLS * TILE_SIZE * 0.15;
  const cachedZoneBounds: Map<number, { vp: Viewport; wallCount: number }> = new Map();

  const fullMapVp: Viewport = { x: 0, y: 0, w: GRID_COLS * TILE_SIZE, h: GRID_ROWS * TILE_SIZE };
  const currentVp: Viewport = { ...fullMapVp };
  let lastVp: Viewport | null = null;
  const ZOOM_LERP_SPEED = 6;
  const MAX_ZOOM_VIEWPORT_RATIO = 0.85;
  const PINCH_FULL_MAP_SNAP = 0.95;

  // --- Helpers ---

  function myPlayerId(): number {
    const pid = deps.getMyPlayerId();
    return pid >= 0 ? pid : deps.getFirstHumanPlayerId();
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
    let bestPid = -1, bestScore = -1;
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

  function boundsToViewport(minR: number, maxR: number, minC: number, maxC: number, pad: number): Viewport {
    minR = Math.max(0, minR - pad);
    maxR = Math.min(GRID_ROWS - 1, maxR + pad);
    minC = Math.max(0, minC - pad);
    maxC = Math.min(GRID_COLS - 1, maxC + pad);
    const fullW = GRID_COLS * TILE_SIZE, fullH = GRID_ROWS * TILE_SIZE;
    const maxW = fullW * MAX_ZOOM_VIEWPORT_RATIO, maxH = fullH * MAX_ZOOM_VIEWPORT_RATIO;
    const targetAspect = GRID_COLS / GRID_ROWS;
    const w = (maxC - minC + 1) * TILE_SIZE, h = (maxR - minR + 1) * TILE_SIZE;
    const vpAspect = w / h;
    const newW = vpAspect < targetAspect
      ? Math.min(maxW, h * targetAspect)
      : Math.min(maxW, (Math.min(maxH, w / targetAspect)) * targetAspect);
    const newH = newW / targetAspect;
    const cx = (minC + maxC + 1) * TILE_SIZE / 2, cy = (minR + maxR + 1) * TILE_SIZE / 2;
    const x = Math.max(0, Math.min(fullW - newW, cx - newW / 2));
    const y = Math.max(0, Math.min(fullH - newH, cy - newH / 2));
    return { x, y, w: newW, h: newH };
  }

  function computeZoneBounds(zoneId: number): Viewport {
    const state = deps.getState()!;
    const pid = state.playerZones.indexOf(zoneId);
    const player = pid >= 0 ? state.players[pid] : undefined;

    const cached = cachedZoneBounds.get(zoneId);
    if (cached && cached.wallCount === (player?.walls.size ?? 0)) return cached.vp;

    let minR = GRID_ROWS, maxR = 0, minC = GRID_COLS, maxC = 0;
    function expand(r: number, c: number) {
      if (r < minR) minR = r; if (r > maxR) maxR = r;
      if (c < minC) minC = c; if (c > maxC) maxC = c;
    }

    if (player && player.walls.size > 0) {
      for (const key of player.walls) { const { r, c } = unpackTile(key); expand(r, c); }
      if (player.homeTower) expand(player.homeTower.row, player.homeTower.col);
    } else {
      const zones = state.map.zones;
      for (let r = 0; r < GRID_ROWS; r++) {
        for (let c = 0; c < GRID_COLS; c++) {
          if (zones[r]![c] === zoneId) expand(r, c);
        }
      }
    }

    const pad = player && player.walls.size > 0 ? 4 : 1;
    const result = boundsToViewport(minR, maxR, minC, maxC, pad);
    cachedZoneBounds.set(zoneId, { vp: result, wallCount: player?.walls.size ?? 0 });
    return result;
  }

  function computeCastleBuildViewport(wallPlans: { playerId: number; tiles: number[] }[]): Viewport {
    const state = deps.getState()!;
    const myPid = myPlayerId();
    const plan = wallPlans.find(p => p.playerId === myPid) ?? wallPlans[0];
    if (!plan || plan.tiles.length === 0) return fullMapVp;
    const player = state.players[plan.playerId];
    let minR = GRID_ROWS, maxR = 0, minC = GRID_COLS, maxC = 0;
    function expand(r: number, c: number) {
      if (r < minR) minR = r; if (r > maxR) maxR = r;
      if (c < minC) minC = c; if (c > maxC) maxC = c;
    }
    for (const key of plan.tiles) { const { r, c } = unpackTile(key); expand(r, c); }
    if (player?.homeTower) expand(player.homeTower.row, player.homeTower.col);
    return boundsToViewport(minR, maxR, minC, maxC, 4);
  }

  // --- Auto-zoom ---

  function autoZoom(phase: Phase): void {
    if (phase === Phase.BATTLE) {
      if (pinchVp) buildPinchVp = { ...pinchVp };
      pinchVp = battlePinchVp ? { ...battlePinchVp } : null;
      // If pinch or battleZoom points at own zone, reset — always pick enemy
      const myZone = getMyZone();
      if (pinchVp && myZone !== null) {
        const zb = computeZoneBounds(myZone);
        const cx = pinchVp.x + pinchVp.w / 2;
        const cy = pinchVp.y + pinchVp.h / 2;
        if (cx >= zb.x && cx <= zb.x + zb.w && cy >= zb.y && cy <= zb.y + zb.h) {
          pinchVp = null;
          battlePinchVp = null;
        }
      }
      if (battleZoom === myZone) battleZoom = null;
      if (pinchVp) {
        cameraZone = null;
      } else if (battleZoom !== null) {
        const state = deps.getState()!;
        const pid = state.playerZones.indexOf(battleZoom);
        if (pid >= 0 && !state.players[pid]?.eliminated) {
          cameraZone = battleZoom;
        } else {
          battleZoom = getBestEnemyZone();
          cameraZone = battleZoom;
        }
      } else {
        battleZoom = getBestEnemyZone();
        cameraZone = battleZoom;
      }
    } else {
      if (pinchVp) battlePinchVp = { ...pinchVp };
      pinchVp = buildPinchVp ? { ...buildPinchVp } : null;
      if (pinchVp) {
        cameraZone = null;
      } else {
        cameraZone = getMyZone();
      }
    }
  }

  // --- Per-frame tick ---

  function tickCamera(dt: number): void {
    const state = deps.getState();
    if (!state) return;
    const mode = deps.getMode();

    // Unzoom for UI overlays and near end of phase
    if (cameraZone !== null || pinchVp !== null) {
      const phaseEnding = state.timer > 0 && state.timer <= 1.5 &&
        (state.phase === Phase.WALL_BUILD || state.phase === Phase.CANNON_PLACE || state.phase === Phase.BATTLE);
      if (phaseEnding || deps.getQuitPending() || deps.hasLifeLostDialog() || deps.getPaused()) {
        if (pinchVp) {
          if (state.phase === Phase.BATTLE) battlePinchVp = { ...pinchVp };
          else buildPinchVp = { ...pinchVp };
        }
        cameraZone = null;
        pinchVp = null;
      }
    }

    // On mobile with auto-zoom, zoom to player zone for life-lost dialog
    if (mobileZoomEnabled && zoomActivated && deps.hasLifeLostDialog()) {
      cameraZone = getMyZone();
    }

    // Selection delay: show "Select your home castle" for 2s on first selection
    if (mode === Mode.SELECTION && lastAutoZoomPhase === null && selectionZoomDelay <= 0) {
      selectionZoomDelay = 2;
    }
    if (selectionZoomDelay > 0 && mode === Mode.SELECTION) {
      deps.setFrameAnnouncement(BANNER_SELECT);
      selectionZoomDelay -= dt;
      if (selectionZoomDelay <= 0) {
        selectionZoomDelay = 0;
        if (mobileZoomEnabled && zoomActivated) autoZoom(state.phase);
      }
    }

    // Auto-zoom on phase change (mobile only, not during banners)
    if (mobileZoomEnabled && zoomActivated && state.phase !== lastAutoZoomPhase &&
        mode !== Mode.BANNER && mode !== Mode.BALLOON_ANIM && mode !== Mode.CASTLE_BUILD) {
      if (!(mode === Mode.SELECTION && lastAutoZoomPhase === null)) {
        autoZoom(state.phase);
      }
      lastAutoZoomPhase = state.phase;
    } else if (state.phase !== lastAutoZoomPhase &&
        mode !== Mode.BANNER && mode !== Mode.BALLOON_ANIM && mode !== Mode.CASTLE_BUILD) {
      lastAutoZoomPhase = state.phase;
    }
  }

  // --- Viewport lerp ---

  function updateViewport(): Viewport | null {
    const mode = deps.getMode();
    let target: Viewport;
    if (castleBuildVp && mode === Mode.CASTLE_BUILD && mobileZoomEnabled) {
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

    const dx = Math.abs(currentVp.x - target.x) + Math.abs(currentVp.y - target.y) +
               Math.abs(currentVp.w - target.w) + Math.abs(currentVp.h - target.h);
    if (dx < 0.5) {
      currentVp.x = target.x;
      currentVp.y = target.y;
      currentVp.w = target.w;
      currentVp.h = target.h;
    }

    if (currentVp.x === fullMapVp.x && currentVp.y === fullMapVp.y &&
        currentVp.w === fullMapVp.w && currentVp.h === fullMapVp.h) {
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
    const cw = GRID_COLS * TILE_SIZE * SCALE;
    const ch = GRID_ROWS * TILE_SIZE * SCALE;
    if (!vp) return { wx: x / SCALE, wy: y / SCALE };
    return {
      wx: vp.x + (x / cw) * vp.w,
      wy: vp.y + (y / ch) * vp.h,
    };
  }

  function pixelToTile(x: number, y: number): { row: number; col: number } {
    const { wx, wy } = screenToWorld(x, y);
    return {
      col: Math.max(0, Math.min(GRID_COLS - 1, Math.floor(wx / TILE_SIZE))),
      row: Math.max(0, Math.min(GRID_ROWS - 1, Math.floor(wy / TILE_SIZE))),
    };
  }

  // --- Pinch-to-zoom ---

  function onPinchStart(midX: number, midY: number): void {
    const mode = deps.getMode();
    if (mode !== Mode.GAME && mode !== Mode.SELECTION) return;
    pinchStartVp = { ...currentVp };
    pinchStartMidX = midX;
    pinchStartMidY = midY;
  }

  function onPinchUpdate(midX: number, midY: number, scale: number): void {
    const mode = deps.getMode();
    if (!pinchStartVp || (mode !== Mode.GAME && mode !== Mode.SELECTION)) return;
    const cw = GRID_COLS * TILE_SIZE * SCALE;
    const ch = GRID_ROWS * TILE_SIZE * SCALE;

    const newW = Math.max(MIN_ZOOM_W, Math.min(fullMapVp.w, pinchStartVp.w * scale));
    const newH = newW * (fullMapVp.h / fullMapVp.w);

    const anchorWx = pinchStartVp.x + (pinchStartMidX / cw) * pinchStartVp.w;
    const anchorWy = pinchStartVp.y + (pinchStartMidY / ch) * pinchStartVp.h;

    let x = anchorWx - (midX / cw) * newW;
    let y = anchorWy - (midY / ch) * newH;

    x = Math.max(0, Math.min(fullMapVp.w - newW, x));
    y = Math.max(0, Math.min(fullMapVp.h - newH, y));

    pinchVp = { x, y, w: newW, h: newH };
    currentVp.x = x; currentVp.y = y; currentVp.w = newW; currentVp.h = newH;
    lastVp = currentVp;
    cameraZone = null;
    zoomActivated = true;
  }

  function onPinchEnd(): void {
    const state = deps.getState();
    pinchStartVp = null;
    if (!pinchVp) return;
    if (pinchVp.w >= fullMapVp.w * PINCH_FULL_MAP_SNAP) {
      pinchVp = null;
      return;
    }
    if (state && state.phase === Phase.BATTLE) {
      battlePinchVp = { ...pinchVp };
    } else {
      buildPinchVp = { ...pinchVp };
    }
  }

  // --- Lifecycle commands ---

  function unzoomForBanner(): void {
    cameraZone = null;
    pinchVp = null;
  }

  function unzoom(): void {
    cameraZone = null;
    pinchVp = null;
    buildPinchVp = null;
    battlePinchVp = null;
  }

  function resetCamera(): void {
    cameraZone = null;
    pinchVp = null;
    buildPinchVp = null;
    battlePinchVp = null;
    castleBuildVp = null;
    battleZoom = null;
    lastAutoZoomPhase = null;
    selectionZoomDelay = 0;
    cachedZoneBounds.clear();
  }

  function setCameraZone(z: number | null): void {
    const state = deps.getState();
    cameraZone = z;
    zoomActivated = true;
    pinchVp = null;
    if (state && state.phase === Phase.BATTLE) {
      battlePinchVp = null;
      if (z !== null) battleZoom = z;
    } else {
      buildPinchVp = null;
    }
  }

  function setCastleBuildViewport(wallPlans: { playerId: number; tiles: number[] }[]): void {
    castleBuildVp = computeCastleBuildViewport(wallPlans);
  }

  function clearCastleBuildViewport(): void {
    castleBuildVp = null;
  }

  function enableMobileZoom(): void {
    mobileZoomEnabled = true;
    zoomActivated = true;
  }

  // --- Return public API ---

  return {
    tickCamera,
    updateViewport,
    getViewport,
    screenToWorld,
    pixelToTile,
    onPinchStart,
    onPinchUpdate,
    onPinchEnd,
    myPlayerId,
    getMyZone,
    getBestEnemyZone,
    getEnemyZones,
    computeZoneBounds,
    unzoomForBanner,
    getCameraZone: () => cameraZone,
    setCameraZone,
    unzoom,
    resetCamera,
    setCastleBuildViewport,
    clearCastleBuildViewport,
    enableMobileZoom,
  };
}
