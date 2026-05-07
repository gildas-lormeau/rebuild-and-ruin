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
  battleTargetPosition,
  bestEnemyZone,
  cannonSize,
  enemyZones,
  playerByZone,
  pxToTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { FrameContext, GameState } from "../shared/core/types.ts";
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
   *  predicate runs both from `assembly.ts` while `FrameContext` is itself
   *  being assembled (`frameMeta` may still be null on the first tick) and
   *  from between-frame paths (bootstrap → enterTowerSelection →
   *  setSelectionViewport on lobby expiry, where the per-frame
   *  `pointerPlayer()` cache still holds the lobby's stale `null`). */
  hasPointerPlayer: () => boolean;
  getFrameDt: () => number;
  /** Whether camera pitch animations run. `false` in headless (no renderer
   *  to apply tilt); `true` in the browser, where the 3D renderer renders
   *  tilt and the pitch animation drives `onPitchSettled` callbacks. */
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
 *  park a callback via `onPitchSettled(cb)`. Call sites that already
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

  // Platform & session flags
  let mobileZoomEnabled = false;
  let zoomActivated = false;

  // User-driven camera target. Single union — exactly one kind at a time.
  type UserTarget =
    | { readonly kind: "fullMap" }
    | { readonly kind: "zone"; readonly zone: number }
    | { readonly kind: "pinch"; readonly viewport: Viewport };
  const FULL_MAP_TARGET: UserTarget = { kind: "fullMap" };
  let target: UserTarget = FULL_MAP_TARGET;
  // True when the active target was installed by `panToCrosshairIfOffscreen`
  // (river / letterbox visibility-keeping pan), false when set by any
  // deliberate user input (button, pinch, edge-pan, tap-nudge, follow-
  // crosshair zone snap, phase-entry default). Flag is reset whenever a
  // non-river-pan writer touches the target. `recordCameraForPhase` skips
  // saving while this is true so river positions don't get restored as
  // the camera anchor on next BATTLE entry / overlay-resume.
  let targetIsTransient = false;

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

  // Per-phase camera memory — each gameplay phase (BUILD / CANNON_PLACE /
  // BATTLE) remembers its own camera target across rounds. On phase entry:
  //   - If a slot is already set → restore it (continuity across rounds).
  //   - If empty (first entry of the match for that phase) → apply the per-
  //     phase default (home zone for build/cannon, best enemy for battle).
  // The stored value is the zone or pinch variant of `UserTarget` —
  // castle-frame is a one-shot UI override and never recorded, and
  // fullMap means "no memory" (skipped on record). The slot type narrows
  // away `kind: "fullMap"` so the invariant is compile-checked.
  type RememberedTarget = Exclude<UserTarget, { kind: "fullMap" }>;
  const phaseCamera: {
    build: RememberedTarget | undefined;
    cannon: RememberedTarget | undefined;
    battle: RememberedTarget | undefined;
  } = { build: undefined, cannon: undefined, battle: undefined };

  // Pending selection-zoom target — the tile the camera should center on
  // when the "Select your home castle" announcement finishes. Set by
  // setSelectionViewport, consumed by handleSelectionZoom (gated on
  // frameCtx.isSelectionReady). One-shot is intrinsic: consume = clear.
  let selectionTargetVp: TilePos | undefined;
  const MIN_ZOOM_W = MAP_PX_W * MIN_ZOOM_RATIO;
  // Tile-rect of every zone, derived from `state.map.zones`. Tile-mutating
  // modifiers (sinkhole, high-tide, low-water) recompute zones and bump
  // `state.map.mapVersion`; we invalidate the cache when the version
  // advances. Used for both auto-zoom centering and the pinch-on-own-zone
  // check in BATTLE.
  const cachedZoneTileBounds = new Map<number, TileBounds>();
  let cachedZoneTileBoundsMapVersion = -1;

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

  // Tilt-settle choreography — parked callback fired when `tickPitch`
  // finishes the in-flight animation. Parked via `onPitchSettled`; the
  // phase machine uses it to gate balloon-anim / battle-mode entry
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

  function getZoneTarget(): number | undefined {
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
  function getViewedZone(): number | undefined {
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
      const zoneId = state.map.zones[row]?.[col];
      return zoneId !== undefined && zoneId > 0 ? zoneId : undefined;
    }
    return undefined;
  }

  /** Mutable pinch viewport: returns the existing `target.viewport` if
   *  already pinch, otherwise installs a fresh pinch target seeded from
   *  `seed` and returns the new mutable viewport. Used by edge-pan and
   *  tap-nudge which need to mutate the viewport in-place each frame.
   *  Both are deliberate user intent, so this also promotes any prior
   *  transient (river-pan) target to non-transient — once the user takes
   *  over, the resulting viewport IS worth remembering. */
  function ensurePinchTarget(seed: Viewport): Viewport {
    targetIsTransient = false;
    if (target.kind === "pinch") return target.viewport;
    const viewport: Viewport = { x: seed.x, y: seed.y, w: seed.w, h: seed.h };
    target = { kind: "pinch", viewport };
    zoomActivated = true;
    return viewport;
  }

  // --- Target writers ---
  //
  // `zoomActivated` is the session arm flag — once true, it stays true until
  // `resetCamera` re-arms it on a fresh match. These setters intentionally
  // do NOT touch `zoomActivated`; arming is an orthogonal concern, set
  // explicitly at the user-input sites (zone-cycle button, pinch start,
  // tap-nudge, follow-crosshair, life-lost, phase-entry default).

  /** Set the user-driven target without side effects beyond the assignment.
   *  Used by silent paths (overlay-unzoom, overlay-restore, river-pan,
   *  pinch-update, pinch-out snap, clearAll). Does not emit a CAMERA_TARGET
   *  event and does not touch `zoomActivated` or `tapNudge`. The optional
   *  `transient` flag marks river-pan-style writes whose viewport should
   *  not be persisted to per-phase memory. */
  function setTargetSilent(next: UserTarget, transient = false): void {
    target = next;
    targetIsTransient = transient;
  }

  /** Set the user-driven target, arm auto-zoom, clear any in-flight tap-nudge
   *  animation, and emit a CAMERA_TARGET event. The single entry point for
   *  explicit "go-to" commands (button, follow-crosshair, life-lost,
   *  phase-entry default). Always called with a non-fullMap target. */
  function setTargetAndEmit(
    next: UserTarget,
    source: CameraTargetSource,
  ): void {
    target = next;
    targetIsTransient = false;
    zoomActivated = true;
    tapNudge = undefined;
    emitCameraTarget(source);
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

  /** Tile-bounds of a zone, scanned from `state.map.zones`. Cache keyed
   *  on `state.map.mapVersion` so tile-mutating modifiers invalidate it. */
  function computeZoneTileBounds(zoneId: number): TileBounds {
    const state = deps.getState()!;
    if (state.map.mapVersion !== cachedZoneTileBoundsMapVersion) {
      cachedZoneTileBounds.clear();
      cachedZoneTileBoundsMapVersion = state.map.mapVersion;
    }
    const cached = cachedZoneTileBounds.get(zoneId);
    if (cached) return cached;
    const zones = state.map.zones;
    let minR = GRID_ROWS,
      maxR = 0,
      minC = GRID_COLS,
      maxC = 0;
    for (let r = 0; r < GRID_ROWS; r++) {
      const row = zones[r]!;
      for (let c = 0; c < GRID_COLS; c++) {
        if (row[c] === zoneId) {
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
        }
      }
    }
    const bounds: TileBounds = { minR, maxR, minC, maxC };
    cachedZoneTileBounds.set(zoneId, bounds);
    return bounds;
  }

  /** Auto-zoom viewport for a zone: fixed size (ZONE_AUTO_ZOOM_RATIO of map),
   *  centered on the geometric center of the player's castle (walls + home
   *  tower bounding box). Falls back to the home tower alone when the
   *  player has no walls yet, then to the zone's static tile center when
   *  the zone has no occupant. */
  function computeZoneViewport(zoneId: number): Viewport {
    const center = castleCenterPx(zoneId);
    const w = MAP_PX_W * ZONE_AUTO_ZOOM_RATIO;
    const h = MAP_PX_H * ZONE_AUTO_ZOOM_RATIO;
    const x = Math.max(0, Math.min(MAP_PX_W - w, center.x - w / 2));
    const y = Math.max(0, Math.min(MAP_PX_H - h, center.y - h / 2));
    return { x, y, w, h };
  }

  /** Pixel center of the castle owned by the player in `zoneId`: bounding
   *  box of walls + home tower (best for the zone-cycle use case so the
   *  whole castle area frames symmetrically). Falls back to the home tower
   *  when there are no walls, then to the zone's static tile-rect center. */
  function castleCenterPx(zoneId: number): { x: number; y: number } {
    const state = deps.getState();
    const pid = state ? playerByZone(state.playerZones, zoneId) : undefined;
    const player = pid !== undefined ? state!.players[pid] : undefined;
    if (player) {
      let minR = Number.POSITIVE_INFINITY;
      let maxR = Number.NEGATIVE_INFINITY;
      let minC = Number.POSITIVE_INFINITY;
      let maxC = Number.NEGATIVE_INFINITY;
      let any = false;
      if (player.walls.size > 0) {
        for (const key of player.walls) {
          const { r, c } = unpackTile(key);
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
          any = true;
        }
      }
      if (player.homeTower) {
        const t = player.homeTower;
        // 2x2 tower footprint extends to (row+1, col+1) inclusive.
        if (t.row < minR) minR = t.row;
        if (t.row + 1 > maxR) maxR = t.row + 1;
        if (t.col < minC) minC = t.col;
        if (t.col + 1 > maxC) maxC = t.col + 1;
        any = true;
      }
      if (any) {
        return {
          x: ((minC + maxC + 1) * TILE_SIZE) / 2,
          y: ((minR + maxR + 1) * TILE_SIZE) / 2,
        };
      }
    }
    const bounds = computeZoneTileBounds(zoneId);
    return {
      x: ((bounds.minC + bounds.maxC + 1) * TILE_SIZE) / 2,
      y: ((bounds.minR + bounds.maxR + 1) * TILE_SIZE) / 2,
    };
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
  // zone command (zone-cycle button), engageAutoZoom (life-lost),
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
  // by the battle crosshair-follow / life-lost engageAutoZoom paths
  // (explicit user navigation), never by phase transitions directly.

  // --- Per-frame tick ---

  /** Single source of truth for "is mobile auto-zoom active right now?".
   *  By definition auto-zoom only applies when a human player owns the
   *  pointer on a touch device — all-AI rematch / lobby demo / spectator
   *  must read as inactive even when `mobileZoomEnabled` / `zoomActivated`
   *  are still latched from a prior session. Every read site (predicate,
   *  per-frame tick, viewport selection, follow-crosshair, etc.) routes
   *  through here so the invariant lives in one place. */
  function mobileAutoZoomActive(): boolean {
    return mobileZoomEnabled && zoomActivated && deps.hasPointerPlayer();
  }

  function tickCamera(): void {
    const state = deps.getState();
    if (!state) return;
    const frameCtx = deps.getCtx();

    unzoomForOverlays(state, frameCtx);
    restoreCameraAfterOverlay(state, frameCtx);
    handleSelectionZoom(state, frameCtx);
    const notTransition = !frameCtx.isTransition;
    handlePhaseChangeZoom(state, frameCtx, notTransition);
    followCrosshairInBattle(state, frameCtx);
    edgePan(state, frameCtx);
    tickTapNudge();
    recordCameraForPhase(state, frameCtx);
    tickPitch();
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
    setTargetSilent(
      {
        kind: "pinch",
        viewport: {
          x: Math.max(0, Math.min(MAP_PX_W - w, x)),
          y: Math.max(0, Math.min(MAP_PX_H - h, y)),
          w,
          h,
        },
      },
      true,
    );
  }

  /** Map the pov player's battle crosshair to its zone id, or null when
   *  the crosshair is missing, off-grid, or over a river / letterbox tile.
   *  (Zone 0 is the water sentinel from `floodFillZones` — player zones
   *  start at 1, so a 0 result means "no zone" and is mapped to null.) */
  function currentCrosshairZone(state: GameState): number | null {
    const ch = deps.getPointerPlayerCrosshair?.();
    if (!ch) return null;
    const row = pxToTile(ch.y);
    const col = pxToTile(ch.x);
    if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) return null;
    const zoneId = state.map.zones[row]?.[col];
    return zoneId !== undefined && zoneId > 0 ? zoneId : null;
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
   *  disabled (headless) — no animation runs, so `onPitchSettled` parked
   *  callbacks never fire there (callers should gate on `getPitchState()` first
   *  and skip parking when state is already `flat`/`tilted`). */
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
   *  Does NOT touch pitch — that's `onCameraReady`'s job. Pitch flatten
   *  is coupled to "a display chain is about to run" (banner capture
   *  needs a flat scene), not to every transition frame, so flattening
   *  here would fight `beginBattleTilt` (which runs in BALLOON_ANIM /
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

  /** Apply per-phase camera memory or first-entry default on phase entry.
   *  Defaults: BUILD/CANNON_PLACE → home zone; BATTLE → best enemy zone.
   *  Memory restore replays the saved `UserTarget` verbatim (zone-cycle
   *  button or pinch viewport) so the touch button color reflects the
   *  active zone. No-op when mobile auto-zoom is disabled. */
  function applyPhaseCameraOnEnter(state: GameState): void {
    if (!mobileAutoZoomActive()) return;
    const slot = phaseSlot(state.phase);
    if (!slot) return;
    tapNudge = undefined;
    const remembered = phaseCamera[slot];
    let next: UserTarget;
    let source: CameraTargetSource;
    if (remembered) {
      next =
        remembered.kind === "pinch"
          ? { kind: "pinch", viewport: { ...remembered.viewport } }
          : remembered;
      source = "phaseEnter";
    } else {
      const zoneId = slot === "battle" ? getBestEnemyZone() : getMyZone();
      if (zoneId === null) return;
      next = { kind: "zone", zone: zoneId };
      source = "phaseEnterDefault";
    }
    // Seed the follow-crosshair tracker so the saved/default camera wins
    // on BATTLE entry — the carried-over crosshair (potentially over a
    // different enemy from the last battle) won't snap us off the
    // restored target on the first frame. Subsequent crosshair zone
    // changes still trigger follow normally.
    if (slot === "battle") {
      lastBattleCrosshairZone = currentCrosshairZone(state);
    }
    setTargetAndEmit(next, source);
  }

  /** Save the active phase's user target every gameplay frame. Skipped
   *  during transitions / overlays so a phase-end unzoom doesn't overwrite
   *  the user's last good camera state, skipped when target is fullMap
   *  (slot retains its last meaningful value), and skipped when the active
   *  pinch is transient (river-pan visibility-keeping pan, not user
   *  intent — the slot keeps the last meaningful value so re-entry
   *  restores a real anchor). The castle-frame override is intentionally
   *  not memorable — it lives only while the matching mode is active. */
  function recordCameraForPhase(
    state: GameState,
    frameCtx: FrameContext,
  ): void {
    if (frameCtx.shouldUnzoom || frameCtx.isTransition) return;
    const slot = phaseSlot(state.phase);
    if (!slot) return;
    if (target.kind === "pinch") {
      if (targetIsTransient) return;
      const view = target.viewport;
      phaseCamera[slot] = {
        kind: "pinch",
        viewport: { x: view.x, y: view.y, w: view.w, h: view.h },
      };
    } else if (target.kind === "zone") {
      phaseCamera[slot] = target;
    }
  }

  /** Restore the active phase's saved target after an overlay (pause / quit /
   *  life-lost dialog) cleared it via unzoomForOverlays. Silent (no event)
   *  because the overlay close is not a user-intent change. No-op while the
   *  overlay is still up or some target other than fullMap is already set. */
  function restoreCameraAfterOverlay(
    state: GameState,
    frameCtx: FrameContext,
  ): void {
    if (frameCtx.shouldUnzoom || frameCtx.isTransition) return;
    if (target.kind !== "fullMap") return;
    if (!mobileAutoZoomActive()) return;
    const slot = phaseSlot(state.phase);
    if (!slot) return;
    const remembered = phaseCamera[slot];
    if (!remembered) return;
    setTargetSilent(
      remembered.kind === "pinch"
        ? { kind: "pinch", viewport: { ...remembered.viewport } }
        : remembered,
    );
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
    zoomActivated = true;
    currentVp.x = x;
    currentVp.y = y;
    currentVp.w = newW;
    currentVp.h = newH;
    lastVp = currentVp;
  }

  function onPinchEnd(): void {
    activePinch = undefined;
    // No-op when no pinch target was actually installed (gesture started
    // outside an interactive mode, or onPinchUpdate never ran a frame).
    if (target.kind !== "pinch") return;
    // Snap to fullMap when pinched all the way out, otherwise keep the
    // current pinch target. Either way persists across phases — no
    // per-phase memory write.
    if (target.viewport.w >= fullMapVp.w * PINCH_FULL_MAP_SNAP) {
      setTargetSilent(FULL_MAP_TARGET);
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

  /** Park a callback to fire on the next pitch-animation settle.
   *
   *  Used by the phase machine's battle-banner postDisplay (see
   *  `proceedToBattleFromCtx`) to gate balloon-anim / battle-mode entry
   *  behind the build→battle tilt-in. Callers are expected to check
   *  `getPitchState()` first and only park this callback when pitch is
   *  mid-animation (`tilting` / `untilting`); the callback is fired the
   *  next time `tickPitch` reaches its target, regardless of which
   *  target that is. `set` overwrites any prior pending callback.
   *
   *  Closure-stored deliberately — runtime control flow must not depend
   *  on the event bus (see feedback_bus_observation_only). Replaces the
   *  former `GAME_EVENT.PITCH_SETTLED` subscription. */
  function onPitchSettled(callback: () => void): void {
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
   *  (`mobileZoomEnabled`) and the session-arm flag (`zoomActivated`) survive
   *  — `resetCamera` owns re-arming. The rendered-frame state (`currentVp`,
   *  `currentPitch`) also survives because clearing it on quit would
   *  jump-cut the visible viewport mid-transition; on rematch we want the
   *  snap, so `resetCamera` does it explicitly. */
  function clearAllZoomState(): void {
    setTargetSilent(FULL_MAP_TARGET);
    tapNudge = undefined;
    castleFrameVp = undefined;
    phaseCamera.build = undefined;
    phaseCamera.cannon = undefined;
    phaseCamera.battle = undefined;
    lastBattleCrosshairZone = undefined;
    lastAutoZoomPhase = undefined;
    selectionTargetVp = undefined;
    lastBattleCrosshair = undefined;
    cachedZoneTileBounds.clear();
    cachedZoneTileBoundsMapVersion = -1;
  }

  function resetCamera(): void {
    clearAllZoomState();
    // Re-arm auto-zoom for the next match.
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
   *  always `"flat"` — pitch is hard-zeroed by `tickPitch`. Sites that
   *  need the settle edge as a one-shot continuation use `onPitchSettled`
   *  instead — this getter is for call sites that already poll per tick. */
  function getPitchState(): PitchState {
    if (!deps.cameraTiltEnabled) return "flat";
    return pitchState;
  }

  function setCameraZone(zone: number): void {
    setCameraZoneInternal(zone, "userZone");
  }

  /** Internal setter that lets sub-systems (engageAutoZoom, follow-crosshair)
   *  attribute the source on the emitted CAMERA_TARGET event. The public
   *  `setCameraZone` is reserved for the zone-cycle button path.
   *
   *  Does NOT clear `castleFrameVp` — during SELECTION / CASTLE_BUILD the
   *  engine override stays in charge of the visible viewport, while the
   *  zone target sits queued for when the lock clears. (Pressing the
   *  zone-cycle button during castle selection thus updates the button
   *  color without disturbing the tower frame.) */
  function setCameraZoneInternal(
    zone: number,
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
    zoomActivated = true;
  }

  /** Snap the camera to the pov player's home zone before the life-lost
   *  popup opens (spec sequence: scores → zoom → life-lost popup). Called
   *  by the phase machine at life-loss time. No-op when mobile auto-zoom
   *  is disabled. The home-zone snap goes through `setCameraZoneInternal`
   *  so the touch zone-cycle button color reflects the active state. */
  function engageAutoZoom(): void {
    if (!mobileAutoZoomActive()) return;
    const myZone = getMyZone();
    if (myZone === null) return;
    setCameraZoneInternal(myZone, "engageAutoZoom");
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
    centerCameraOnTap,
    povPlayerId,
    getMyZone,
    getBestEnemyZone,
    getEnemyZones,
    onCameraReady,
    onPitchSettled,
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
    engageAutoZoom,
    isMobileAutoZoom: mobileAutoZoomActive,
    computeBattleTarget,
    saveBattleCrosshair,
  };
}
