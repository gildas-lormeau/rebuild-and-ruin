/**
 * Camera / zoom system — extracted from runtime-composition.ts.
 *
 * Owns all viewport state (zone bounds, pinch zoom, auto-zoom, lerp)
 * and exposes a pure API for the runtime to call.
 */

import {
  CROSSHAIR_TRACK_PAD_TILES,
  MIN_ZOOM_RATIO,
  PHANTOM_TRACK_PAD_TILES,
  PINCH_FULL_MAP_SNAP,
  VIEWPORT_SNAP_THRESHOLD,
  ZONE_AUTO_ZOOM_RATIO,
  ZONE_PAD_SELECTION,
  ZONE_PAD_WITH_WALLS,
  ZOOM_LERP_SPEED,
} from "../shared/core/game-constants.ts";
import {
  type CameraTargetSource,
  GAME_EVENT,
} from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type {
  GameMap,
  TileBounds,
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
  TILE_SIZE,
} from "../shared/core/grid.ts";
import type {
  CannonPhantom,
  PiecePhantom,
} from "../shared/core/phantom-types.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import {
  bestEnemyZone,
  enemyZones,
  isPlayerEliminated,
  playerByZone,
  zoneByPlayer,
} from "../shared/core/player-types.ts";
import {
  cannonSize,
  castleCenterPx as castleCenterPxShared,
  pxToTile,
  towerCenterPx,
  zoneAt,
} from "../shared/core/spatial.ts";
import type { FrameContext, GameState } from "../shared/core/types.ts";
import type { ZoneCell, ZoneId } from "../shared/core/zone-id.ts";
import type { RenderOverlay } from "../shared/ui/overlay-types.ts";
import { isInteractiveMode, Mode } from "../shared/ui/ui-mode.ts";
import {
  cameraStateFromViewport,
  fitTileBoundsToViewport,
  screenToWorld as projectScreenToWorld,
  worldToScreen as projectWorldToScreen,
} from "./camera-projection.ts";
import type { CameraSystem } from "./runtime-types.ts";

/** EXCEPTION: CameraDeps uses all-getter pattern (late binding) because camera state
 *  can change during host migration. Other sub-systems destructure runtimeState directly. */
interface CameraDeps {
  getState: () => GameState | undefined;
  getCtx: () => FrameContext;
  /** "Is a human player driving the pointer right now?" — the gate inside
   *  `mobileAutoZoomActive()`. Must be cache-independent because the
   *  predicate runs both from `runtime-main-loop.ts` while `FrameContext` is itself
   *  being assembled (`frameMeta` may still be null on the first tick) and
   *  from between-frame paths (bootstrap → enterTowerSelection →
   *  setSelectionViewport on lobby expiry, where the per-frame
   *  `pointerPlayer()` cache still holds the lobby's stale `null`). */
  hasPointerPlayer: () => boolean;
  getFrameDt: () => number;
  /** Whether camera pitch animations run. `false` in headless (no renderer
   *  to apply tilt); `true` in the browser, where the 3D renderer renders
   *  tilt and the pitch animation drives `awaitPitchSettled` callbacks. */
  cameraTiltEnabled: boolean;
  setFrameAnnouncement: (text: string) => void;
  getPointerPlayerCrosshair?: () => { x: number; y: number } | null;
  /** Pointer player's active phantoms — raw shapes only. The camera derives
   *  the tile-space bounding box from these when it needs to edge-pan
   *  during BUILD/CANNON_PLACE so the preview stays on-screen. Returns null
   *  when there is no pointer player. */
  getPointerPlayerPhantoms?: () => {
    buildPhantoms: readonly PiecePhantom[];
    cannonPhantom: CannonPhantom | undefined;
  } | null;
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
 *  Call sites that need the settle edge as a one-shot continuation
 *  park a callback via `awaitPitchSettled(cb)`. Call sites that already
 *  poll per tick (phase-ticks' untilt wait) read `getPitchState()`. */
type PitchState = "flat" | "tilting" | "tilted" | "untilting";

const CANVAS_SIZE = { w: CANVAS_W, h: CANVAS_H } as const;
/** Target pitch when entering battle: 30° classic isometric / Rampart 3/4 view. */
const TILT_BATTLE_PITCH = Math.PI / 6;
/** Pitch animation duration (seconds). CSS `transition: Xms ease-out` equivalent. */
const PITCH_DURATION = 0.6;

export function createCameraSystem(deps: CameraDeps): CameraSystem {
  // --- Internal state ---
  //
  // CAMERA STATE MACHINE
  //
  // The user-driven camera target is a single tagged union (`UserTarget`):
  //   - { kind: "fullMap" }            — default, entire map visible
  //   - { kind: "zone", zone }         — auto-zoom on a zone (zone-cycle
  //                                       button, follow-crosshair, life-lost
  //                                       snap, phase-entry default)
  //   - { kind: "pinch", viewport }    — freeform user viewport (pinch,
  //                                       two-finger drag, tap-nudge, edge-
  //                                       pan, river-crosshair pan)
  //
  // A separate `castleFrameVp` is an engine-driven OVERRIDE that wins over
  // the user target while the UI is in `Mode.SELECTION` or `Mode.CASTLE_BUILD`
  // — it locks the camera onto the home tower / castle ring during the
  // non-interactive auto-build sequence. It's set by `setSelectionViewport`
  // / `setCastleBuildViewport` and cleared by `clearCastleBuildViewport`
  // (phase machine, just before enterCannonPhase). User-target writes
  // during these modes still update `target` silently — the queued zone /
  // pinch takes effect the moment the lock clears.
  //
  // updateViewport() lerps currentVp toward the resolved target each tick.

  // Platform flag — true on touch devices (set by `enableMobileZoom`,
  // called from input setup). Gates every auto-zoom code path via
  // `mobileAutoZoomActive`. Survives `resetCamera` (session-level, not
  // per-game) since the platform doesn't change between matches.
  let mobileZoomEnabled = false;

  // User-driven camera target. Single union — exactly one kind at a time.
  type UserTarget =
    | { readonly kind: "fullMap" }
    | { readonly kind: "zone"; readonly zone: ZoneId }
    | { readonly kind: "pinch"; readonly viewport: Viewport };
  const FULL_MAP_TARGET: UserTarget = { kind: "fullMap" };
  let target: UserTarget = FULL_MAP_TARGET;

  // Engine-driven override — only honoured while in SELECTION / CASTLE_BUILD.
  let castleFrameVp: Viewport | undefined;
  let lastAutoZoomPhase: Phase | undefined;

  // Pinch gesture — transient state, non-null only during an active two-finger gesture
  interface ActivePinch {
    readonly startVp: Viewport;
    startMidX: number;
    startMidY: number;
  }
  let activePinch: ActivePinch | undefined;

  // Persisted zoom level (viewport.w / fullMap.w) from the most recent
  // pinch gesture. Survives phase changes and overlays so the user's
  // preferred zoom carries forward, while the pan target always re-anchors
  // to the phase default (home zone / best enemy zone) on phase entry and
  // overlay close — there is no per-phase pan memory. undefined = no
  // preference yet → fall back to ZONE_AUTO_ZOOM_RATIO. Cleared on snap-
  // to-fullMap and on game reset.
  let userZoomRatio: number | undefined = undefined;

  // Pending selection-zoom target — the tile the camera should center on
  // when the "Select your home castle" announcement finishes. Set by
  // setSelectionViewport, consumed by handleSelectionZoom (gated on
  // frameCtx.isSelectionReady). One-shot is intrinsic: consume = clear.
  let selectionTargetVp: TilePos | undefined;
  const MIN_ZOOM_W = MAP_PX_W * MIN_ZOOM_RATIO;
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
  // Parked via `awaitCameraFlat`; the flatten itself runs in
  // `unzoomForOverlays` whenever `frameCtx.shouldUnzoom` is set.
  let pendingUnzoomReady: (() => void) | undefined;

  // Tilt-settle choreography — parked callback fired when `tickPitch`
  // finishes the in-flight animation. Parked via `awaitPitchSettled`;
  // the phase machine uses it to gate balloon-anim / battle-mode entry
  // behind the build→battle tilt-in.
  let pendingPitchSettled: (() => void) | undefined;

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

  function firePitchSettled(): void {
    const callback = pendingPitchSettled;
    pendingPitchSettled = undefined;
    callback?.();
  }

  // --- Target accessors ---

  function getZoneTarget(): ZoneId | undefined {
    return target.kind === "zone" ? target.zone : undefined;
  }

  function getPinchTarget(): Viewport | undefined {
    return target.kind === "pinch" ? target.viewport : undefined;
  }

  /** The zone the user is visually looking at right now. Resolves the
   *  pinch case via the viewport center → tile → `state.map.zones` lookup,
   *  so a freeform pinch on enemy B reads as zone B (the touch zone-cycle
   *  button uses this to base its "next zone" preview on the actually
   *  visible zone, not on the explicit `cameraZone` slot). Returns
   *  undefined when the viewport center is over a river / letterbox tile,
   *  or when the camera is at full map. (Zone 0 is the water sentinel from
   *  `floodFillZones` — player zones start at 1.) */
  function getViewedZone(): ZoneId | undefined {
    if (target.kind === "zone") return target.zone;
    if (target.kind === "pinch") {
      const state = deps.getState();
      if (!state) return undefined;
      const view = target.viewport;
      const row = pxToTile(view.y + view.h / 2);
      const col = pxToTile(view.x + view.w / 2);
      if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) {
        return undefined;
      }
      return zoneAt(state.map, row, col);
    }
    return undefined;
  }

  /** Mutable pinch viewport: returns the existing `target.viewport` if
   *  already pinch, otherwise installs a fresh pinch target seeded from
   *  `seed` and returns the new mutable viewport. Used by edge-pan and
   *  tap-nudge which need to mutate the viewport in-place each frame. */
  function ensurePinchTarget(seed: Viewport): Viewport {
    if (target.kind === "pinch") return target.viewport;
    const viewport: Viewport = { x: seed.x, y: seed.y, w: seed.w, h: seed.h };
    target = { kind: "pinch", viewport };
    return viewport;
  }

  // --- Target writers ---

  /** Set the user-driven target without side effects beyond the assignment.
   *  Used by silent paths (overlay-unzoom, overlay-restore, river-pan,
   *  pinch-update, pinch-out snap, clearAll). Does not emit a CAMERA_TARGET
   *  event and does not touch `tapNudge`. */
  function setTargetSilent(next: UserTarget): void {
    target = next;
  }

  /** Set the user-driven target, clear any in-flight tap-nudge animation,
   *  and emit a CAMERA_TARGET event. The single entry point for explicit
   *  "go-to" commands (button, follow-crosshair, life-lost, phase-entry
   *  default). Always called with a non-fullMap target. */
  function setTargetAndEmit(
    next: UserTarget,
    source: CameraTargetSource,
  ): void {
    target = next;
    tapNudge = undefined;
    emitCameraTarget(source);
  }

  // --- Helpers ---

  function povPlayerId(): number {
    return deps.getCtx().povPlayerId;
  }

  function getBestEnemyZone(): ZoneId | null {
    const state = deps.getState();
    if (!state) return null;
    return bestEnemyZone(state.players, state.playerZones, povPlayerId());
  }

  function getEnemyZones(): ZoneId[] {
    const state = deps.getState();
    if (!state) return [];
    return enemyZones(state.players, state.playerZones, povPlayerId());
  }

  /** Auto-zoom viewport for a zone: centered on the geometric center of
   *  the player's castle (walls + home tower bounding box), at the user's
   *  persisted `userZoomRatio` if set, else `ZONE_AUTO_ZOOM_RATIO`. Ratio
   *  is clamped to `[MIN_ZOOM_RATIO, 1]` so a stale value can't push the
   *  viewport below the minimum or beyond fullMap. Falls back to the home
   *  tower alone when the player has no walls yet, then to the zone's
   *  static tile center when the zone has no occupant. */
  function computeZoneViewport(zoneId: ZoneId): Viewport {
    const center = castleCenterPx(zoneId);
    const ratio = Math.max(
      MIN_ZOOM_RATIO,
      Math.min(1, userZoomRatio ?? ZONE_AUTO_ZOOM_RATIO),
    );
    const w = MAP_PX_W * ratio;
    const h = MAP_PX_H * ratio;
    const x = Math.max(0, Math.min(MAP_PX_W - w, center.x - w / 2));
    const y = Math.max(0, Math.min(MAP_PX_H - h, center.y - h / 2));
    return { x, y, w, h };
  }

  /** Pixel center of the player's castle in `zoneId` — wraps the shared
   *  `castleCenterPx` helper with the camera's `state` access. Same anchor
   *  is used by the life-lost popup so the panel sits at the viewport
   *  center under the auto-zoom. */
  function castleCenterPx(zoneId: ZoneId): { x: number; y: number } {
    const state = deps.getState()!;
    return castleCenterPxShared(
      state.players,
      state.playerZones,
      state.map.zones,
      zoneId,
    );
  }

  /** Frame the precomputed ideal castle ring (one tile outside the castle's
   *  interior bounds), not the actual wall plan — clumsy-builder variations
   *  are intentionally ignored so the viewport is deterministic and the
   *  camera doesn't tightly hug the noisy wall layout during auto-build. */
  function computeCastleBuildViewport(playerId: ValidPlayerSlot): Viewport {
    const state = deps.getState();
    const castle = state?.players[playerId]?.castle;
    if (!castle) return fullMapVp;
    const tileBounds: TileBounds = {
      minR: castle.top - 1,
      maxR: castle.bottom + 1,
      minC: castle.left - 1,
      maxC: castle.right + 1,
    };
    return fitTileBoundsToViewport(tileBounds, ZONE_PAD_WITH_WALLS);
  }

  // --- Camera target events ---
  //
  // Discrete-transition emit: phase entry / per-phase restore, explicit
  // zone command (zone-cycle button), holdLifeLostZoom (life-lost),
  // follow-crosshair, pinch-end. Continuous motion (edge-pan, tap-nudge
  // animation, mid-pinch updates) does NOT emit — only the moments where
  // the player's intended target changes. Gated on `mobileZoomEnabled` so
  // existing determinism fixtures (which run with mobile zoom off) don't
  // see new events.
  //
  // No dedupe: every call emits, even when the resulting target equals
  // the previous one. Makes the fixture a strict per-call spec — a
  // regression that breaks one of the call sites still surfaces even
  // when the restored target happens to match the one already in place.
  function emitCameraTarget(source: CameraTargetSource): void {
    if (!mobileZoomEnabled) return;
    const state = deps.getState();
    if (!state) return;
    // emitGameEvent's `Omit<GameEventMap[K], "type">` collapses the
    // discriminated union, so call bus.emit directly with the full event.
    // `castleFrameVp` (engine override) is intentionally invisible to the
    // event stream — only user-target transitions emit.
    if (target.kind === "zone") {
      state.bus.emit(GAME_EVENT.CAMERA_TARGET, {
        type: "cameraTarget",
        kind: "zone",
        zone: target.zone,
        source,
      });
      return;
    }
    if (target.kind === "pinch") {
      const view = target.viewport;
      state.bus.emit(GAME_EVENT.CAMERA_TARGET, {
        type: "cameraTarget",
        kind: "pinch",
        viewport: { x: view.x, y: view.y, w: view.w, h: view.h },
        source,
      });
      return;
    }
    state.bus.emit(GAME_EVENT.CAMERA_TARGET, {
      type: "cameraTarget",
      kind: "fullmap",
      source,
    });
  }

  // --- Auto-zoom ---
  //
  // Camera persists across BUILD / CANNON_PLACE / BATTLE phase changes —
  // the user `target` is recorded into per-phase memory each frame and
  // restored on phase re-entry (zone or pinch identity preserved). The
  // zone kind is only ever installed by the touch zone-cycle button or
  // by the battle crosshair-follow / life-lost holdLifeLostZoom paths
  // (explicit user navigation), never by phase transitions directly.

  // --- Per-frame tick ---

  /** Single source of truth for "is mobile auto-zoom active right now?".
   *  By definition auto-zoom only applies when a human player owns the
   *  pointer on a touch device — all-AI rematch / lobby demo / spectator
   *  must read as inactive even when `mobileZoomEnabled` is still latched
   *  from a prior session. Every read site (predicate, per-frame tick,
   *  viewport selection, follow-crosshair, etc.) routes through here so
   *  the invariant lives in one place. */
  function mobileAutoZoomActive(): boolean {
    return mobileZoomEnabled && deps.hasPointerPlayer();
  }

  function tickCamera(): void {
    const state = deps.getState();
    if (!state) return;
    const frameCtx = deps.getCtx();

    holdLifeLostZoom(state, frameCtx);
    unzoomForOverlays(state, frameCtx);
    restoreCameraAfterOverlay(state, frameCtx);
    handleSelectionZoom(state, frameCtx);
    const notTransition = !frameCtx.isTransition;
    handlePhaseChangeZoom(state, frameCtx, notTransition);
    followCrosshairInBattle(state, frameCtx);
    edgePan(state, frameCtx);
    tickTapNudge();
    tickPitch();
  }

  /** Snap to the local pov player's home zone while they have an unresolved
   *  life-lost entry. Runs before `unzoomForOverlays` — `lifeLostKeepZoom`
   *  also gates `shouldUnzoom` off in `computeFrameContext`, so the
   *  overlay-unzoom path won't fight us. The zone is set silently to keep
   *  the touch zone-cycle button color in sync without firing a user-target
   *  event (the popup-driven snap isn't user intent). Idempotent across
   *  frames: a no-op once the target already matches the local zone. */
  function holdLifeLostZoom(_state: GameState, frameCtx: FrameContext): void {
    if (!frameCtx.lifeLostKeepZoom) return;
    if (!mobileAutoZoomActive()) return;
    const myZone = zoneByPlayer(deps.getState(), povPlayerId());
    if (myZone === null) return;
    if (target.kind === "zone" && target.zone === myZone) return;
    setCameraZoneInternal(myZone, "lifeLostHold");
  }

  /** When the battle crosshair crosses into a different zone, snap the camera
   *  to that zone — same effect as the player tapping the zone-cycle button.
   *  Crossing into the player's own zone is allowed (e.g. defending against
   *  grunts at home). River / letterbox tiles return null and don't trigger
   *  a zone snap, but the camera free-pans to keep the crosshair visible
   *  while it's over null tiles — the river acts as a continuous panning
   *  passage between zones. Skipped while pinching, transitioning or while
   *  an overlay is up. */
  let lastBattleCrosshairZone: number | null | undefined;
  function followCrosshairInBattle(
    state: GameState,
    frameCtx: FrameContext,
  ): void {
    if (state.phase !== Phase.BATTLE) {
      lastBattleCrosshairZone = undefined;
      return;
    }
    if (frameCtx.shouldUnzoom || frameCtx.isTransition || activePinch) return;
    if (!mobileAutoZoomActive()) return;
    const zone = currentCrosshairZone(state);
    const zoneChanged = zone !== lastBattleCrosshairZone;
    lastBattleCrosshairZone = zone;
    if (zoneChanged && zone !== null) {
      setCameraZoneInternal(zone, "followCrosshair");
      return;
    }
    if (zone === null) panToCrosshairIfOffscreen();
  }

  /** Crosshair sits over a river / letterbox tile (no zone). If it has drifted
   *  out of the current viewport — possible with keyboard / dpad input pushing
   *  past the edge of a zone whose castle sits far from the river — set the
   *  user target to a pinch viewport that minimally contains the crosshair.
   *  Re-runs every frame while over null tiles, so the camera tracks the
   *  crosshair smoothly through the river. Replaced by `setTargetAndEmit`
   *  with a zone target the moment the crosshair next enters a zone.
   *
   *  We read `currentVp` (the lerped position) rather than the resolved
   *  target so the new pinch is anchored just-outside-the-margin from
   *  where the camera is right now — the next-frame lerp then drives the
   *  convergence. Reading the target instead would jump the pinch to the
   *  destination immediately and lose the smooth-follow feel. */
  function panToCrosshairIfOffscreen(): void {
    const ch = deps.getPointerPlayerCrosshair?.();
    if (!ch) return;
    const margin = TILE_SIZE;
    const w = currentVp.w;
    const h = currentVp.h;
    let x = currentVp.x;
    let y = currentVp.y;
    if (ch.x < x + margin) x = ch.x - margin;
    else if (ch.x > x + w - margin) x = ch.x - w + margin;
    if (ch.y < y + margin) y = ch.y - margin;
    else if (ch.y > y + h - margin) y = ch.y - h + margin;
    if (x === currentVp.x && y === currentVp.y) return;
    setTargetSilent({
      kind: "pinch",
      viewport: {
        x: Math.max(0, Math.min(MAP_PX_W - w, x)),
        y: Math.max(0, Math.min(MAP_PX_H - h, y)),
        w,
        h,
      },
    });
  }

  /** Map the pov player's battle crosshair to its zone id, or null when
   *  the crosshair is missing, off-grid, or over a river / letterbox tile.
   *  (Zone 0 is the water sentinel from `floodFillZones` — player zones
   *  start at 1, so a 0 result means "no zone" and is mapped to null.) */
  function currentCrosshairZone(state: GameState): ZoneId | null {
    const ch = deps.getPointerPlayerCrosshair?.();
    if (!ch) return null;
    const row = pxToTile(ch.y);
    const col = pxToTile(ch.x);
    if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) return null;
    return zoneAt(state.map, row, col) ?? null;
  }

  // --- Edge-pan ---
  //
  // Continuous proportional pan that nudges the camera in the direction of
  // the pov player's focus point (build/cannon phantom or battle crosshair)
  // when that focus is within the per-phase edge zone. Speed = 0 at the
  // edge-zone inner boundary, max at the very edge. The pinch viewport
  // is the mutable surface — when edge-pan triggers while the camera is
  // on a zone target, `ensurePinchTarget` converts it into a pinch (the
  // auto-zoom is overridden by user-driven movement).

  /** Pixel speed at the very edge of the viewport (depth = 1). */
  const EDGE_PAN_MAX_SPEED = 200;

  /** Tile-space bounding box of the pointer player's active phantom in
   *  BUILD or CANNON_PLACE — null when no phantom is being placed. */
  function pointerPhantomTileBounds(phase: Phase): TileBounds | null {
    const phantoms = deps.getPointerPlayerPhantoms?.();
    if (!phantoms) return null;
    if (phase === Phase.WALL_BUILD) {
      if (phantoms.buildPhantoms.length === 0) return null;
      let minR = Infinity;
      let maxR = -Infinity;
      let minC = Infinity;
      let maxC = -Infinity;
      for (const phantom of phantoms.buildPhantoms) {
        for (const [dr, dc] of phantom.offsets) {
          const r = phantom.row + dr;
          const c = phantom.col + dc;
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
        }
      }
      return Number.isFinite(minR) ? { minR, maxR, minC, maxC } : null;
    }
    if (phase === Phase.CANNON_PLACE) {
      const cannon = phantoms.cannonPhantom;
      if (!cannon) return null;
      const size = cannonSize(cannon.mode);
      return {
        minR: cannon.row,
        maxR: cannon.row + size - 1,
        minC: cannon.col,
        maxC: cannon.col + size - 1,
      };
    }
    return null;
  }

  function focusBoundsForEdgePan(
    phase: Phase,
  ): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (phase === Phase.WALL_BUILD || phase === Phase.CANNON_PLACE) {
      const tile = pointerPhantomTileBounds(phase);
      if (!tile) return null;
      return {
        minX: tile.minC * TILE_SIZE,
        minY: tile.minR * TILE_SIZE,
        maxX: (tile.maxC + 1) * TILE_SIZE,
        maxY: (tile.maxR + 1) * TILE_SIZE,
      };
    }
    if (phase === Phase.BATTLE) {
      const ch = deps.getPointerPlayerCrosshair?.();
      if (!ch) return null;
      return { minX: ch.x, minY: ch.y, maxX: ch.x, maxY: ch.y };
    }
    return null;
  }

  function edgePan(state: GameState, frameCtx: FrameContext): void {
    if (frameCtx.shouldUnzoom || frameCtx.isTransition || activePinch) return;
    const focus = focusBoundsForEdgePan(state.phase);
    if (!focus) return;
    // Determine current viewport. Skip on full map (already shows everything)
    // and the round-1 castle-build override.
    if (castleFrameVp) return;
    let viewport: Viewport;
    if (target.kind === "pinch") viewport = target.viewport;
    else if (target.kind === "zone")
      viewport = computeZoneViewport(target.zone);
    else return;

    // If the focus is fully OUTSIDE the current viewport, the user just
    // jumped the camera (zone-cycle button, pinch, two-finger pan) —
    // the stale cursor in the old zone shouldn't drag the camera back.
    // Edge-pan resumes once the cursor is dragged into the new viewport.
    if (
      focus.maxX < viewport.x ||
      focus.minX > viewport.x + viewport.w ||
      focus.maxY < viewport.y ||
      focus.minY > viewport.y + viewport.h
    ) {
      return;
    }

    const tiles =
      state.phase === Phase.BATTLE
        ? CROSSHAIR_TRACK_PAD_TILES
        : PHANTOM_TRACK_PAD_TILES;
    const zonePx = tiles * TILE_SIZE;
    if (zonePx <= 0) return;

    const leftDepth = Math.max(
      0,
      Math.min(1, (zonePx - (focus.minX - viewport.x)) / zonePx),
    );
    const rightDepth = Math.max(
      0,
      Math.min(1, (zonePx - (viewport.x + viewport.w - focus.maxX)) / zonePx),
    );
    const topDepth = Math.max(
      0,
      Math.min(1, (zonePx - (focus.minY - viewport.y)) / zonePx),
    );
    const bottomDepth = Math.max(
      0,
      Math.min(1, (zonePx - (viewport.y + viewport.h - focus.maxY)) / zonePx),
    );

    const dt = deps.getFrameDt();
    const dx = (rightDepth - leftDepth) * EDGE_PAN_MAX_SPEED * dt;
    const dy = (bottomDepth - topDepth) * EDGE_PAN_MAX_SPEED * dt;
    if (dx === 0 && dy === 0) return;

    const pinch = ensurePinchTarget(viewport);
    pinch.x = Math.max(0, Math.min(MAP_PX_W - pinch.w, pinch.x + dx));
    pinch.y = Math.max(0, Math.min(MAP_PX_H - pinch.h, pinch.y + dy));
  }

  // --- Tap-nudge ---
  //
  // One-shot smooth pan when the player taps in the outer 25% ring of the
  // viewport. Always runs to completion (per spec) — additional taps queue
  // a new target only after the current animation finishes.

  /** Tap-nudge animation duration (seconds). */
  const TAP_NUDGE_DURATION = 0.25;
  let tapNudge:
    | {
        fromX: number;
        fromY: number;
        toX: number;
        toY: number;
        elapsed: number;
      }
    | undefined;

  function tickTapNudge(): void {
    const pinch = getPinchTarget();
    if (!tapNudge || !pinch) {
      tapNudge = undefined;
      return;
    }
    tapNudge.elapsed = Math.min(
      TAP_NUDGE_DURATION,
      tapNudge.elapsed + deps.getFrameDt(),
    );
    const t = tapNudge.elapsed / TAP_NUDGE_DURATION;
    const eased = 1 - (1 - t) * (1 - t) * (1 - t); // cubic ease-out
    const nx = tapNudge.fromX + (tapNudge.toX - tapNudge.fromX) * eased;
    const ny = tapNudge.fromY + (tapNudge.toY - tapNudge.fromY) * eased;
    pinch.x = nx;
    pinch.y = ny;
    if (tapNudge.elapsed >= TAP_NUDGE_DURATION) {
      pinch.x = tapNudge.toX;
      pinch.y = tapNudge.toY;
      tapNudge = undefined;
    }
  }

  /** Ease currentPitch toward targetPitch each frame. Hard-zero when tilt is
   *  disabled (headless) — no animation runs, so `tickPitch` never invokes
   *  the parked callback. `awaitPitchSettled` handles this by firing
   *  synchronously when pitch is already settled (including the headless
   *  always-flat case), so callers don't need to pre-check. */
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
      firePitchSettled();
    }
  }

  /** Clear zoom targets whenever `frameCtx.shouldUnzoom` is set.
   *  Triggers: UI overlays (paused / quit / life-lost), mobile human-done
   *  predicates, phase-ending on desktop, and phase transitions.
   *
   *  Does NOT touch pitch — that's `awaitCameraFlat`'s job. Pitch flatten
   *  is coupled to "a display chain is about to run" (banner capture
   *  needs a flat scene), not to every transition frame, so flattening
   *  here would fight `beginTilt` (which runs in BALLOON_ANIM /
   *  BANNER postDisplay, where isTransition is still true). */
  function unzoomForOverlays(_state: GameState, frameCtx: FrameContext): void {
    if (!frameCtx.shouldUnzoom) return;
    if (target.kind === "fullMap" && castleFrameVp === undefined) return;
    setTargetSilent(FULL_MAP_TARGET);
    castleFrameVp = undefined;
  }

  /** Drive per-phase camera memory on phase entry — applyPhaseCameraOnEnter
   *  restores or defaults the zoom for the new phase (BUILD/CANNON/BATTLE).
   *  CASTLE_SELECT has no per-phase memory; its deferred zoom is handled
   *  by handleSelectionZoom (via setSelectionViewport's pending target). */
  function handlePhaseChangeZoom(
    state: GameState,
    _frameCtx: FrameContext,
    notTransition: boolean,
  ): void {
    if (state.phase === lastAutoZoomPhase || !notTransition) return;
    applyPhaseCameraOnEnter(state);
    lastAutoZoomPhase = state.phase;
  }

  /** Maps a Phase to its per-phase camera slot, or null when the phase has
   *  no per-phase camera memory (selection / modifier-reveal). */
  function phaseSlot(phase: Phase): "build" | "cannon" | "battle" | null {
    if (phase === Phase.WALL_BUILD) return "build";
    if (phase === Phase.CANNON_PLACE) return "cannon";
    if (phase === Phase.BATTLE) return "battle";
    return null;
  }

  /** Default zone target for a gameplay phase: home zone for BUILD /
   *  CANNON_PLACE, best enemy zone for BATTLE. Returns null for phases
   *  with no auto-anchor (selection / modifier-reveal / upgrade-pick) or
   *  when the chosen zone can't be resolved (no live human / no enemy). */
  function defaultTargetForPhase(phase: Phase): UserTarget | null {
    const slot = phaseSlot(phase);
    if (!slot) return null;
    const zoneId =
      slot === "battle"
        ? getBestEnemyZone()
        : zoneByPlayer(deps.getState(), povPlayerId());
    if (zoneId === null) return null;
    return { kind: "zone", zone: zoneId };
  }

  /** Apply the phase default on phase entry. No per-phase pan memory —
   *  every entry re-anchors to home zone (build/cannon) or best enemy
   *  (battle). The user's persisted `userZoomRatio` (set by pinch) is
   *  honored by `computeZoneViewport` so the zoom level carries forward
   *  even though the pan does not. No-op when mobile auto-zoom is disabled. */
  function applyPhaseCameraOnEnter(state: GameState): void {
    if (!mobileAutoZoomActive()) return;
    const next = defaultTargetForPhase(state.phase);
    if (!next) return;
    tapNudge = undefined;
    // Seed the follow-crosshair tracker so the default camera wins on
    // BATTLE entry — the carried-over crosshair (potentially over a
    // different enemy from the last battle) won't snap us off the
    // default target on the first frame. Subsequent crosshair zone
    // changes still trigger follow normally.
    if (state.phase === Phase.BATTLE) {
      lastBattleCrosshairZone = currentCrosshairZone(state);
    }
    setTargetAndEmit(next, "phaseEnter");
  }

  /** Re-anchor to the phase default after an overlay (pause / quit / life-
   *  lost dialog) cleared the target via unzoomForOverlays. Silent (no
   *  event) because the overlay close is not a user-intent change. No-op
   *  while the overlay is still up or some target other than fullMap is
   *  already set. Mirrors `applyPhaseCameraOnEnter` minus the BATTLE
   *  crosshair seeding (no phase change happened). */
  function restoreCameraAfterOverlay(
    state: GameState,
    frameCtx: FrameContext,
  ): void {
    if (frameCtx.shouldUnzoom || frameCtx.isTransition) return;
    if (target.kind !== "fullMap") return;
    if (!mobileAutoZoomActive()) return;
    const next = defaultTargetForPhase(state.phase);
    if (!next) return;
    setTargetSilent(next);
  }

  /** Consume the pending selection-zoom target once the "Select your home
   *  castle" announcement finishes. Mirrors pattern A (per-phase
   *  applyPhaseCameraOnEnter): single state slot, single apply site,
   *  one-shot via consume. The data IS the latch — no separate boolean. */
  function handleSelectionZoom(
    _state: GameState,
    frameCtx: FrameContext,
  ): void {
    if (frameCtx.mode !== Mode.SELECTION) return;
    if (!frameCtx.isSelectionReady) return;
    if (!selectionTargetVp) return;
    if (!mobileAutoZoomActive()) {
      selectionTargetVp = undefined;
      return;
    }
    castleFrameVp = fitTileBoundsToViewport(
      {
        minR: selectionTargetVp.row,
        maxR: selectionTargetVp.row + 1,
        minC: selectionTargetVp.col,
        maxC: selectionTargetVp.col + 1,
      },
      ZONE_PAD_SELECTION,
    );
    selectionTargetVp = undefined;
  }

  // --- Viewport lerp ---

  /** Resolve the active viewport: castle-frame override (during SELECTION /
   *  CASTLE_BUILD) wins, otherwise the user `target` union resolves to a
   *  viewport (fullMap / zone / pinch). Auto-zoom is gated on
   *  `mobileAutoZoomActive()` — all-AI / spectator / lobby-demo sessions
   *  stay at fullMapVp regardless of latched state, since the touch input
   *  writers intentionally mutate state without checking the predicate. */
  function resolveViewport(mode: Mode): Viewport {
    if (!mobileAutoZoomActive()) return fullMapVp;
    if (
      castleFrameVp &&
      (mode === Mode.CASTLE_BUILD || mode === Mode.SELECTION)
    ) {
      return castleFrameVp;
    }
    if (target.kind === "pinch") return target.viewport;
    if (target.kind === "zone") return computeZoneViewport(target.zone);
    return fullMapVp;
  }

  function updateViewport(): Viewport | undefined {
    const frameCtx = deps.getCtx();
    const resolved = resolveViewport(frameCtx.mode);

    // Edge-pan (per-frame, in tickCamera) and tap-nudge (animation, in
    // tickTapNudge) mutate the pinch viewport directly, so updateViewport
    // just lerps currentVp toward the resolved target — no extra
    // focus-tracking pass.

    const time = Math.min(1, ZOOM_LERP_SPEED * deps.getFrameDt());
    currentVp.x += (resolved.x - currentVp.x) * time;
    currentVp.y += (resolved.y - currentVp.y) * time;
    currentVp.w += (resolved.w - currentVp.w) * time;
    currentVp.h += (resolved.h - currentVp.h) * time;

    const dx =
      Math.abs(currentVp.x - resolved.x) +
      Math.abs(currentVp.y - resolved.y) +
      Math.abs(currentVp.w - resolved.w) +
      Math.abs(currentVp.h - resolved.h);
    if (dx < VIEWPORT_SNAP_THRESHOLD) {
      currentVp.x = resolved.x;
      currentVp.y = resolved.y;
      currentVp.w = resolved.w;
      currentVp.h = resolved.h;
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

    setTargetSilent({
      kind: "pinch",
      viewport: { x, y, w: newW, h: newH },
    });
    currentVp.x = x;
    currentVp.y = y;
    currentVp.w = newW;
    currentVp.h = newH;
    lastVp = currentVp;
    // Persist the zoom level so future phase entries (which always re-
    // anchor pan to the home/enemy zone) honor the user's current zoom.
    userZoomRatio = newW / fullMapVp.w;
  }

  function onPinchEnd(): void {
    activePinch = undefined;
    // No-op when no pinch target was actually installed (gesture started
    // outside an interactive mode, or onPinchUpdate never ran a frame).
    if (target.kind !== "pinch") return;
    // Snap to fullMap when pinched all the way out and reset the persisted
    // zoom — pinching out is the "show me everything, forget my zoom"
    // gesture. Otherwise keep the current pinch target and the recorded
    // zoom level (the pan target itself is not persisted across phases).
    if (target.viewport.w >= fullMapVp.w * PINCH_FULL_MAP_SNAP) {
      setTargetSilent(FULL_MAP_TARGET);
      userZoomRatio = undefined;
    }
    // Emit the settled target on gesture end (intermediate per-frame
    // updates during pinch are continuous motion and intentionally not
    // emitted — see emitCameraTarget JSDoc).
    emitCameraTarget("userPinch");
  }

  /** Tap-nudge: when a single-finger tap lands in the outer 25% ring of the
   *  current viewport, smoothly pan (preserving zoom) so the tap point
   *  enters the inner 75% comfort zone. Tap inside the inner 75% → no-op.
   *
   *  Animation always finishes (per spec) — additional touches don't cancel
   *  the in-flight tween. New gestures interact with the pinch handler
   *  separately. Skipped when target is the full map or the round-1
   *  castle-build override. */
  function centerCameraOnTap(wx: number, wy: number): void {
    if (castleFrameVp || tapNudge) return;
    let seed: Viewport;
    if (target.kind === "pinch") seed = target.viewport;
    else if (target.kind === "zone") seed = computeZoneViewport(target.zone);
    else return;
    const { x: curX, y: curY, w, h } = seed;
    const insetX = w * 0.125;
    const insetY = h * 0.125;
    let toX = curX;
    let toY = curY;
    if (wx < curX + insetX) toX = wx - insetX;
    else if (wx > curX + w - insetX) toX = wx - w + insetX;
    if (wy < curY + insetY) toY = wy - insetY;
    else if (wy > curY + h - insetY) toY = wy - h + insetY;
    toX = Math.max(0, Math.min(MAP_PX_W - w, toX));
    toY = Math.max(0, Math.min(MAP_PX_H - h, toY));
    if (toX === curX && toY === curY) return;

    const pinch = ensurePinchTarget(seed);
    tapNudge = {
      fromX: pinch.x,
      fromY: pinch.y,
      toX,
      toY,
      elapsed: 0,
    };
  }

  // --- Lifecycle commands ---

  /** Run `cb` once the next-rendered frame is at fullMap AND pitch is at
   *  0. Callers (the phase machine's `runTransition`) wait for this before
   *  running mutate + display, which guarantees the banner's prev-scene
   *  capture reads a full-map-rendered, flat pre-mutation frame. Fires
   *  synchronously when both conditions already hold.
   *
   *  Flattens the pitch target as part of the call — battle→build
   *  transitions need the banner to capture a flat scene, and this is
   *  the one point where we know "a display chain is about to run"
   *  (after postDisplay, `beginTilt` may re-tilt and we must not
   *  undo that from the overlay-unzoom path).
   *
   *  Viewport flatten is separate, driven by `unzoomForOverlays` on
   *  `frameCtx.shouldUnzoom` (which includes `isTransition`, so
   *  `setMode(Mode.TRANSITION)` before this call drives convergence). */
  function awaitCameraFlat(callback: () => void): void {
    setPitchTarget(0);
    // Already flat (viewport at fullMap AND pitch at 0)? Fire synchronously
    // — the runtime ticks on a mock clock in tests, so deferring would
    // change replay timing.
    if (lastVp === undefined && currentPitch === 0 && targetPitch === 0) {
      callback();
      return;
    }
    pendingUnzoomReady = callback;
  }

  /** Run `cb` once the in-flight pitch animation completes (in either
   *  direction — `flat` or `tilted` both count as settled). Fires
   *  synchronously when the pitch is already settled, including the
   *  headless / `cameraTiltEnabled === false` case where `getPitchState()`
   *  always reports `"flat"` and `tickPitch` never invokes the parked
   *  callback. Without the sync-fire path, headless callers would hang.
   *
   *  Used by the phase machine's battle-banner postDisplay (see
   *  `proceedToBattleFromCtx`) to gate balloon-anim / battle-mode entry
   *  behind the build→battle tilt-in. `set` overwrites any prior pending
   *  callback.
   *
   *  Closure-stored callbacks (not Promises) because the runtime ticks
   *  synchronously this frame when an animation completes — `Promise.then`
   *  would defer to a microtask the runtime can't schedule, breaking
   *  mock-clock determinism. */
  function awaitPitchSettled(callback: () => void): void {
    const state = getPitchState();
    if (state === "flat" || state === "tilted") {
      callback();
      return;
    }
    pendingPitchSettled = callback;
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

  /** Clear every camera-target / tracking field. Used by both `teardownSession`
   *  (game-over / quit-to-lobby) and `resetCamera` (rematch bootstrap). The
   *  goal is "no field can leak across game boundaries". The platform flag
   *  (`mobileZoomEnabled`) survives because it reflects the device, not the
   *  session. The rendered-frame state (`currentVp`, `currentPitch`) also
   *  survives because clearing it on quit would jump-cut the visible
   *  viewport mid-transition; on rematch we want the snap, so
   *  `resetCamera` does it explicitly. */
  function clearAllZoomState(): void {
    setTargetSilent(FULL_MAP_TARGET);
    tapNudge = undefined;
    castleFrameVp = undefined;
    userZoomRatio = undefined;
    lastBattleCrosshairZone = undefined;
    lastAutoZoomPhase = undefined;
    selectionTargetVp = undefined;
    lastBattleCrosshair = undefined;
  }

  function resetCamera(): void {
    clearAllZoomState();
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
  function beginTilt(): void {
    setPitchTarget(TILT_BATTLE_PITCH);
  }

  /** Current pitch state machine value. When tilt is disabled (headless)
   *  always `"flat"` — pitch is hard-zeroed by `tickPitch`. Sites that
   *  need the settle edge as a one-shot continuation use `awaitPitchSettled`
   *  instead — this getter is for call sites that already poll per tick. */
  function getPitchState(): PitchState {
    if (!deps.cameraTiltEnabled) return "flat";
    return pitchState;
  }

  function setCameraZone(zone: ZoneId): void {
    setCameraZoneInternal(zone, "userZone");
  }

  /** Internal setter that lets sub-systems (holdLifeLostZoom, follow-crosshair)
   *  attribute the source on the emitted CAMERA_TARGET event. The public
   *  `setCameraZone` is reserved for the zone-cycle button path.
   *
   *  Does NOT clear `castleFrameVp` — during SELECTION / CASTLE_BUILD the
   *  engine override stays in charge of the visible viewport, while the
   *  zone target sits queued for when the lock clears. (Pressing the
   *  zone-cycle button during castle selection thus updates the button
   *  color without disturbing the tower frame.) */
  function setCameraZoneInternal(
    zone: ZoneId,
    source: CameraTargetSource,
  ): void {
    setTargetAndEmit({ kind: "zone", zone }, source);
  }

  /** Park the desired selection-zoom target tile. Always deferred to the
   *  camera tick: handleSelectionZoom consumes it once
   *  `frameCtx.isSelectionReady` becomes true (within ≤1 frame if the
   *  announcement has already finished).
   *
   *  Does NOT gate on `mobileAutoZoomActive()` here — this is called from
   *  `enterTowerSelection` during bootstrap, BEFORE `setMode(SELECTION)`
   *  flips, so `isSessionLive` (and therefore `hasPointerPlayer`) is still
   *  false at this exact moment. Gate at consume time instead. */
  function setSelectionViewport(towerRow: number, towerCol: number): void {
    selectionTargetVp = { row: towerRow, col: towerCol };
  }

  function setCastleBuildViewport(playerId: ValidPlayerSlot): void {
    if (!mobileAutoZoomActive()) return;
    castleFrameVp = computeCastleBuildViewport(playerId);
  }

  function clearCastleBuildViewport(): void {
    castleFrameVp = undefined;
    // Per-phase camera memory takes over from here — applyPhaseCameraOnEnter
    // (in handlePhaseChangeZoom) seeds the user target on the next phase
    // entry (CANNON_PLACE round 1 → home zone default).
  }

  function enableMobileZoom(): void {
    mobileZoomEnabled = true;
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
    if (!mobileAutoZoomActive()) return null;

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

  // --- Return public API ---

  return {
    tickCamera,
    updateViewport,
    getViewport,
    getPitch: () => currentPitch,
    getPitchMax: () => TILT_BATTLE_PITCH,
    beginUntilt,
    beginTilt,
    getPitchState,
    screenToWorld,
    pickHitWorld,
    worldToScreen,
    pixelToTile,
    onPinchStart,
    onPinchUpdate,
    onPinchEnd,
    centerCameraOnTap,
    povPlayerId,
    getEnemyZones,
    awaitCameraFlat,
    awaitPitchSettled,
    onRenderedFrame,
    getCameraZone: getZoneTarget,
    getViewedZone,
    setCameraZone,
    clearAllZoomState,
    resetCamera,
    setSelectionViewport,
    setCastleBuildViewport,
    clearCastleBuildViewport,
    enableMobileZoom,
    isMobileAutoZoom: mobileAutoZoomActive,
    computeBattleTarget,
    saveBattleCrosshair,
  };
}

/** Compute the crosshair target for battle start (touch devices).
 *  - If `lastPos` targets a living enemy, return it.
 *  - Otherwise aim at the best enemy's home tower.
 *  Returns null when no valid target exists. */
function battleTargetPosition(
  players: readonly {
    eliminated: boolean;
    score: number;
    homeTower: TilePos | null;
  }[],
  playerZones: readonly ZoneId[],
  zones: readonly (readonly ZoneCell[])[],
  myPid: number,
  lastPos: { x: number; y: number } | undefined,
): { x: number; y: number } | null {
  // Restore last position if targeted opponent is alive
  if (lastPos) {
    const row = pxToTile(lastPos.y);
    const col = pxToTile(lastPos.x);
    const zone = zones[row]?.[col];
    if (zone !== undefined && zone !== 0) {
      const pid = playerByZone(playerZones, zone);
      if (
        pid !== undefined &&
        pid !== myPid &&
        !isPlayerEliminated(players[pid])
      ) {
        return { x: lastPos.x, y: lastPos.y };
      }
    }
  }

  // First battle or opponent died: aim at best enemy's home tower
  const zone = bestEnemyZone(players, playerZones, myPid);
  if (zone === null) return null;
  const pid = playerByZone(playerZones, zone);
  const tower = pid !== undefined ? players[pid]?.homeTower : null;
  if (!tower) return null;
  return towerCenterPx(tower);
}
