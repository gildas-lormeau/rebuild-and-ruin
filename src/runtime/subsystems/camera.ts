/**
 * Camera / zoom system — extracted from runtime/composition.ts.
 *
 * Owns all viewport state (zone bounds, pinch zoom, auto-zoom, lerp)
 * and exposes a pure API for the runtime to call.
 */

import { BATTLE_TILT_PITCH_RAD } from "../../shared/core/elevation-constants.ts";
import {
  CROSSHAIR_TRACK_PAD_TILES,
  MIN_ZOOM_RATIO,
  PHANTOM_TRACK_PAD_TILES,
  PINCH_FULL_MAP_SNAP,
  VIEWPORT_SNAP_THRESHOLD,
  ZONE_AUTO_ZOOM_RATIO,
  ZONE_PAD_SELECTION,
  ZOOM_LERP_SPEED,
} from "../../shared/core/game-constants.ts";
import {
  type CameraTargetSource,
  GAME_EVENT,
} from "../../shared/core/game-event-bus.ts";
import { isPlacementPhase, Phase } from "../../shared/core/game-phase.ts";
import type {
  GameMap,
  TileBounds,
  TilePos,
  Viewport,
  WorldPos,
} from "../../shared/core/geometry-types.ts";
import {
  CANVAS_H,
  CANVAS_W,
  GRID_COLS,
  GRID_ROWS,
  MAP_PX_H,
  MAP_PX_W,
  SCALE,
  TILE_SIZE,
} from "../../shared/core/grid.ts";
import type {
  CannonPhantom,
  PiecePhantom,
} from "../../shared/core/phantom-types.ts";
import type { ValidPlayerId } from "../../shared/core/player-slot.ts";
import { enemyZones, zoneByPlayer } from "../../shared/core/player-types.ts";
import {
  cannonSize,
  castleCenterPx as castleCenterPxShared,
  pxToTile,
  zoneAt,
} from "../../shared/core/spatial.ts";
import type { FrameContext, GameState } from "../../shared/core/types.ts";
import type { ZoneId } from "../../shared/core/zone-id.ts";
import type { RenderOverlay } from "../../shared/ui/overlay-types.ts";
import {
  isGameplayMode,
  isInteractiveMode,
  Mode,
} from "../../shared/ui/ui-mode.ts";
import { battleTargetPosition } from "../battle-aim.ts";
import {
  createPitchAnim,
  easeOutCubic,
  isPitchSettled,
  type PitchState,
  resetPitchAnim,
  setPitchTarget as setPitchAnimTarget,
  snapPitchAnim,
  tickPitchAnim,
} from "../camera-pitch.ts";
import {
  cameraStateFromViewport,
  fitTileBoundsToViewport,
  screenToWorld as projectScreenToWorld,
  worldToScreen as projectWorldToScreen,
} from "../camera-projection.ts";

/** Public camera handle exposed on `GameRuntime`. Consumed via `Pick<>`
 *  by sub-systems that need a slice (selection, input, game-lifecycle);
 *  the full surface is for the composition root only. */
export interface RuntimeCamera {
  // Per-frame lifecycle
  tickCamera: () => void;

  // Coordinate conversion
  /** Read the displayed viewport (undefined at full map). Advanced once
   *  per sim substep by `tickCamera`'s viewport lerp; the render path
   *  and `dev/e2e-bridge.ts` are pure readers. */
  getViewport: () => Viewport | undefined;
  /** Current camera pitch in radians (animated on phase transitions). The
   *  tilt is always-on — the deterministic animation runs on every peer,
   *  headless included (see 31d05f2f). */
  getPitch: () => number;
  /** Maximum pitch the camera reaches when fully tilted into the battle
   *  view. Constant for the lifetime of the runtime; exposed so the
   *  renderer can normalize `getPitch()` into a `[0, 1]` tilt progress
   *  without duplicating the constant cross-domain. */
  getPitchMax: () => number;
  /** Request an immediate pitch=0 ease. Idempotent. Used for "untilt
   *  without unzoom" (pitch only) — battle-done's pre-dispatch untilt
   *  gate (phase-ticks) is the sole flatten owner; `unzoomForOverlays`
   *  deliberately never touches pitch. */
  beginUntilt: () => void;
  /** Start the build→battle tilt animation. Called explicitly at
   *  battle-banner end so the tilt plays unzoomed, before balloons /
   *  "ready" / auto-zoom into the battle zone. */
  beginTilt: () => void;
  /** Pitch-animation state machine value. `"flat"` / `"tilted"` are
   *  resting states; `"tilting"` / `"untilting"` indicate an in-progress
   *  ease. Callers that want the settle edge as a one-shot continuation
   *  (not the polled state) use the internal `awaitPitchSettled` instead. */
  getPitchState: () => PitchState;
  /** Hard-set the pitch machine to a settled pose and drop any parked
   *  settle continuation. FULL_STATE adoption path (online-rehydrate):
   *  the snapshot skips the transition choreography that owns
   *  `beginTilt`/`beginUntilt`, so the local ease + parked continuation
   *  belong to a superseded timeline — left in place, this peer renders
   *  the adopted battle at the wrong pose and the next battle-done
   *  untilt gate (phase-ticks) counts a different number of ease ticks
   *  here than on every other peer, skewing the dispatch tick. */
  snapPitchSettled: (settled: "flat" | "tilted") => void;
  screenToWorld: (x: number, y: number) => WorldPos;
  /** Like `screenToWorld` but returns the world position of the first
   *  elevated-geometry hit under battle tilt (walls/towers/etc). At
   *  pitch=0 this is identical to `screenToWorld`. */
  pickHitWorld: (x: number, y: number) => WorldPos;
  worldToScreen: (wx: number, wy: number) => { sx: number; sy: number };
  pixelToTile: (x: number, y: number) => { row: number; col: number };

  // Pinch gesture handlers
  onPinchStart: (midX: number, midY: number) => void;
  onPinchUpdate: (midX: number, midY: number, scale: number) => void;
  onPinchEnd: () => void;

  /** Tap-nudge (despite the name, NOT a snap-to-center): when a
   *  single-finger tap lands in the outer 12.5%-per-edge ring of the
   *  current viewport, smoothly pan (zoom preserved) just far enough to
   *  bring the tap point inside the inner comfort zone. Taps inside the
   *  comfort zone, during the selection castle-frame override, while a
   *  nudge is in flight, or at full map are no-ops. Used by touch
   *  handlers on single-finger touchstart. */
  centerCameraOnTap: (wx: number, wy: number) => void;

  // Zone queries
  povPlayerId: () => number;
  getEnemyZones: () => ZoneId[];

  // Zoom state
  getCameraZone: () => ZoneId | undefined;
  /** The zone the user is visually looking at — explicit zone target if set,
   *  otherwise the zone at the pinch viewport center, or undefined when on
   *  full map / over a river. Drives the touch zone-cycle button preview. */
  getViewedZone: () => ZoneId | undefined;
  setCameraZone: (zone: ZoneId) => void;

  // Lifecycle commands
  /** Cosmetic hard-cut of the displayed viewport to fullMapVp at
   *  transition dispatch. Parks the outgoing user target (same semantics
   *  as `unzoomForOverlays`, which would otherwise park it next tick)
   *  and pins `currentVp` so the banner's uniform map→display scale
   *  assumption (render-map.ts) holds from the first sweep frame.
   *  Game-state timing must NEVER wait on the camera — transition
   *  mutates run at the dispatch tick on every peer (see
   *  `runTransition`'s LOCKSTEP INVARIANT) — so the displayed viewport
   *  snaps instead of being awaited. No-op on desktop, which never
   *  leaves fullmap. Does NOT touch pitch: battle-done's pre-dispatch
   *  untilt gate (phase-ticks) is the sole pitch-flatten owner, and
   *  every other transition dispatches from flat phases. */
  snapToFullMapForTransition: () => void;
  /** Run `cb` once the in-flight pitch animation completes (in either
   *  direction — `flat` and `tilted` both count as settled). Fires
   *  synchronously when pitch is already settled. Used by the phase machine's
   *  battle-banner postDisplay to gate balloon-anim / battle-mode entry
   *  behind the build→battle tilt-in. Caller-overwrite semantics. */
  awaitPitchSettled: (callback: () => void) => void;
  /** Full unzoom: clear all zoom state for returnToLobby/endGame. */
  clearAllZoomState: () => void;
  /** Full reset for rematch. */
  resetCamera: () => void;

  // Selection zoom
  setSelectionViewport: (towerRow: number, towerCol: number) => void;

  // Mobile zoom
  enableMobileZoom: () => void;
  isMobileAutoZoom: () => boolean;
}

/** EXCEPTION: CameraDeps uses all-getter pattern (late binding) because camera state
 *  can change during host migration. Other sub-systems destructure runtimeState directly. */
interface CameraDeps {
  getState: () => GameState | undefined;
  getCtx: () => FrameContext;
  /** Persisted last battle crosshair (`RuntimeState.lastBattleCrosshair`) —
   *  read-only here; the composition root's battle-aim seeding owns the
   *  writes. Anchors the battle-entry camera on the zone the crosshair
   *  will restore into (see `battleTargetZone`). */
  getLastBattleCrosshair: () => { x: number; y: number } | undefined;
  /** "Is a human player driving the pointer right now?" — the gate inside
   *  `mobileAutoZoomActive()`. Must be cache-independent because the
   *  predicate runs both from `main-loop.ts` while `FrameContext` is itself
   *  being assembled (`frameMeta` may still be null on the first tick) and
   *  from between-frame paths (bootstrap → enterTowerSelection →
   *  setSelectionViewport on lobby expiry, where the per-frame
   *  `pointerPlayer()` cache still holds the lobby's stale `null`). */
  hasPointerPlayer: () => boolean;
  getFrameDt: () => number;
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

const CANVAS_SIZE = { w: CANVAS_W, h: CANVAS_H } as const;
/** Target pitch when entering battle: 30° classic isometric / Rampart 3/4
 *  view. Single source in shared/core so the sim's aim-occlusion snap reads
 *  the same settled value (see `BATTLE_TILT_PITCH_RAD`). */
const TILT_BATTLE_PITCH = BATTLE_TILT_PITCH_RAD;

export function createCameraSystem(deps: CameraDeps): RuntimeCamera {
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
  // the user target while the UI is in `Mode.SELECTION`
  // — it locks the camera onto the home tower during tower selection. It's
  // set when `handleSelectionZoom` consumes the parked `setSelectionViewport`
  // target and cleared by `unzoomForOverlays` (the human-confirm /
  // transition unzoom) or `clearAllZoomState`. User-target writes during
  // these modes still update `target` silently — the queued zone / pinch
  // takes effect the moment the lock clears.
  //
  // tickViewportLerp() lerps currentVp toward the resolved target each
  // sim substep (from tickCamera).

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
  // Pre-overlay user target parked by `unzoomForOverlays` so the camera is
  // restored exactly as it was when the overlay (pause / quit / life-lost
  // dialog) closes — pause must be camera-invisible. (Re-deriving the
  // phase default instead used to strand the BATTLE camera on the stale
  // start-of-battle zone after a mid-battle pause, with the crosshair
  // off-screen.) Stamped with the phase it was parked in: restore fires
  // only into the SAME phase, because the per-frame restore runs BEFORE
  // `handlePhaseChangeZoom` in the tick — on the first frame after a
  // one-way unzoom episode that ended in a phase change (human-done /
  // phase-ending / transition), an unstamped restore would resurrect the
  // old phase's pan before the new phase re-anchors.
  // undefined = the current fullMap is NOT overlay residue and must not be
  // restored over: `onPinchEnd`'s pinch-out snap clears it (a deliberate
  // "show me everything" gesture — restoring over it would undo the snap
  // one frame later, desyncing the emitted CAMERA_TARGET event), as do
  // phase entry (`handlePhaseChangeZoom`) and `clearAllZoomState`.
  let overlayParked: { target: UserTarget; phase: Phase } | undefined;

  // Engine-driven override — only honoured while in SELECTION.
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

  // Pitch animation state machine — extracted to `camera-pitch.ts`
  // (target is re-set on phase-enter via handlePhaseChangeZoom; `current`
  // eases toward it each tick in tickCamera).
  // TODO(step-6): loupe (render-loupe.ts) and auto-zoom fit
  // (fitTileBoundsToViewport) are pitch-agnostic; under tilt the loupe
  // crop and zone fit are slightly off. Cosmetic at 30°; fix in step 6.
  const pitch = createPitchAnim();

  // Tilt-settle choreography — parked callback fired off `tickPitchAnim`'s
  // settle edge. Parked via `awaitPitchSettled`; the phase machine uses it
  // to gate balloon-anim / battle-mode entry behind the build→battle
  // tilt-in. Lives here (not on PitchAnim) so the low-layer primitive
  // never stores a subsystem closure.
  let pendingPitchSettled: (() => void) | undefined;

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
      return zoneAtPixel(state.map, view.x + view.w / 2, view.y + view.h / 2);
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

  function povPlayerId(): ValidPlayerId {
    return deps.getCtx().povPlayerId;
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
  // No per-phase camera memory: every entry into BUILD / CANNON_PLACE /
  // BATTLE re-anchors to that phase's default zone via
  // `applyPhaseCameraOnEnter` (home zone for build/cannon, the crosshair-
  // target enemy for battle), which installs a `zone` target directly
  // from the phase transition. Only the pinch zoom *ratio* persists
  // across phases (`userZoomRatio`); the pan does not. Zone targets are
  // also installed by the touch zone-cycle button, battle
  // crosshair-follow, and life-lost holdLifeLostZoom.

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
    tickViewportLerp();
    tickPitch(frameCtx);
  }

  /** Snap to the local pov player's home zone while they have an unresolved
   *  life-lost entry. Runs before `unzoomForOverlays` — `lifeLostKeepZoom`
   *  also gates `shouldUnzoom` off in `computeFrameContext`, so the
   *  overlay-unzoom path won't fight us. The zone is set via
   *  `setCameraZoneInternal`, which keeps the touch zone-cycle button color
   *  in sync and emits CAMERA_TARGET attributed to `"lifeLostHold"` (so
   *  fixtures can tell the popup-driven snap from user intent). Idempotent
   *  across frames: a no-op once the target already matches the local zone. */
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
    const { x, y } = pullPointIntoInset(currentVp, ch.x, ch.y, margin, margin);
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
    return zoneAtPixel(state.map, ch.x, ch.y) ?? null;
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
    if (isPlacementPhase(phase)) {
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
    const eased = easeOutCubic(t);
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

  function tickPitch(frameCtx: FrameContext): void {
    // Freeze the tilt (and its parked settle continuation) while a menu
    // overlay is open. A mid-tilt F1 opens Mode.OPTIONS over the battle
    // tilt-in (TRANSITION); ungated, the next pitch-settle edge fires
    // `proceedToBattleFromCtx`'s `proceed` and flips the game mode out from
    // under the menu. Same freeze the overlay tick observes (main-loop.ts).
    // Edge-preserved: the advance resumes — and settles — once the menu
    // closes back into the gameplay mode. No-op in LOBBY/STOPPED (pitch is
    // already snapped flat; the all-AI demo runs in gameplay modes).
    if (!isGameplayMode(frameCtx.mode)) return;
    if (tickPitchAnim(pitch, deps.getFrameDt())) {
      const callback = pendingPitchSettled;
      pendingPitchSettled = undefined;
      callback?.();
    }
  }

  /** Clear zoom targets whenever `frameCtx.shouldUnzoom` is set.
   *  Triggers: UI overlays (paused / quit / life-lost), mobile human-done
   *  predicates, phase-ending on desktop, and phase transitions.
   *
   *  Does NOT touch pitch — battle-done's pre-dispatch untilt gate
   *  (phase-ticks) owns the flatten. Flattening here would fight
   *  `beginTilt` (which runs in BALLOON_ANIM / BANNER postDisplay,
   *  where isTransition is still true). */
  function unzoomForOverlays(state: GameState, frameCtx: FrameContext): void {
    if (!frameCtx.shouldUnzoom) return;
    if (target.kind === "fullMap" && castleFrameVp === undefined) return;
    // Park the outgoing target (with its phase) so the post-overlay
    // restore puts the camera back exactly where it was — the early-return
    // above makes this once per unzoom episode. A fullMap target isn't
    // worth parking (restoring it is a no-op), so selection episodes that
    // only clear `castleFrameVp` park nothing.
    if (target.kind !== "fullMap") {
      overlayParked = { target, phase: state.phase };
    }
    setTargetSilent(FULL_MAP_TARGET);
    castleFrameVp = undefined;
  }

  /** Re-anchor the camera on phase entry — applyPhaseCameraOnEnter
   *  installs the new phase's default target (BUILD/CANNON/BATTLE; no
   *  per-phase memory, see the Auto-zoom block above). CASTLE_SELECT has
   *  no phase default; its deferred zoom is handled by
   *  handleSelectionZoom (via setSelectionViewport's pending target). */
  function handlePhaseChangeZoom(
    state: GameState,
    _frameCtx: FrameContext,
    notTransition: boolean,
  ): void {
    if (state.phase === lastAutoZoomPhase || !notTransition) return;
    // A real phase entry invalidates any overlay-parked pan — the phase
    // default (applyPhaseCameraOnEnter) owns the new phase's anchor.
    overlayParked = undefined;
    applyPhaseCameraOnEnter(state);
    lastAutoZoomPhase = state.phase;
  }

  /** Maps a Phase to its auto-anchor slot, or null when the phase has no
   *  camera auto-anchor (selection / modifier-reveal / upgrade-pick). */
  function phaseSlot(phase: Phase): "build" | "cannon" | "battle" | null {
    if (phase === Phase.WALL_BUILD) return "build";
    if (phase === Phase.CANNON_PLACE) return "cannon";
    if (phase === Phase.BATTLE) return "battle";
    return null;
  }

  /** Default zone target for a gameplay phase: home zone for BUILD /
   *  CANNON_PLACE, the battle crosshair-target zone for BATTLE (restored
   *  last-aimed enemy, else best enemy — kept in lockstep with the crosshair
   *  so it can't land off-screen). Returns null for phases with no auto-anchor
   *  (selection / modifier-reveal / upgrade-pick) or when the chosen zone
   *  can't be resolved (no live human / no enemy). */
  function defaultTargetForPhase(phase: Phase): UserTarget | null {
    const slot = phaseSlot(phase);
    if (!slot) return null;
    const zoneId =
      slot === "battle"
        ? battleTargetZone()
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

  /** Restore the camera exactly as it was before an overlay (pause / quit /
   *  life-lost dialog) cleared the target via unzoomForOverlays. Silent
   *  (no event) because the overlay close is not a user-intent change.
   *  No-op while the overlay is still up, when some target other than
   *  fullMap is already set, when nothing was parked (deliberate
   *  pinch-out fullMap, which the user wants to keep), or when the parked
   *  target belongs to a different phase (one-way unzoom — the phase
   *  entry re-anchors via applyPhaseCameraOnEnter instead). */
  function restoreCameraAfterOverlay(
    state: GameState,
    frameCtx: FrameContext,
  ): void {
    if (frameCtx.shouldUnzoom || frameCtx.isTransition) return;
    if (target.kind !== "fullMap") return;
    if (!overlayParked || overlayParked.phase !== state.phase) return;
    if (!mobileAutoZoomActive()) return;
    const { target: parked } = overlayParked;
    overlayParked = undefined;
    setTargetSilent(parked);
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

  /** Resolve the active viewport: castle-frame override (during SELECTION)
   *  wins, otherwise the user `target` union resolves to a
   *  viewport (fullMap / zone / pinch). Auto-zoom is gated on
   *  `mobileAutoZoomActive()` — all-AI / spectator / lobby-demo sessions
   *  stay at fullMapVp regardless of latched state, since the touch input
   *  writers intentionally mutate state without checking the predicate. */
  function resolveViewport(mode: Mode): Viewport {
    if (!mobileAutoZoomActive()) return fullMapVp;
    if (castleFrameVp && mode === Mode.SELECTION) {
      return castleFrameVp;
    }
    if (target.kind === "pinch") return target.viewport;
    if (target.kind === "zone") return computeZoneViewport(target.zone);
    return fullMapVp;
  }

  /** Advance the displayed viewport toward the resolved target. Runs in
   *  `tickCamera` — once per fixed sim substep — so the lerp is paced by
   *  sim time. (It used to advance inside the render path's viewport
   *  read, which scaled the zoom speed with the display's render rate:
   *  2× on a 120Hz screen, slower under dropped frames.) Cosmetic only:
   *  the displayed viewport never feeds the sim.
   *
   *  Edge-pan (per-frame, in tickCamera) and tap-nudge (animation, in
   *  tickTapNudge) mutate the pinch viewport directly, so this just
   *  lerps currentVp toward the resolved target — no extra
   *  focus-tracking pass. */
  function tickViewportLerp(): void {
    const frameCtx = deps.getCtx();
    const resolved = resolveViewport(frameCtx.mode);

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
  }

  function getViewport(): Viewport | undefined {
    return lastVp;
  }

  // --- Coordinate conversion ---

  function screenToWorld(x: number, y: number): WorldPos {
    const viewport = getViewport();
    if (!viewport) return { wx: x / SCALE, wy: y / SCALE };
    const state = cameraStateFromViewport(viewport, CANVAS_SIZE, pitch.current);
    const { x: wx, y: wy } = projectScreenToWorld(state, CANVAS_SIZE, x, y);
    return { wx, wy };
  }

  /** Inverse of screenToWorld: world-pixel → canvas backing-store pixel. */
  function worldToScreen(wx: number, wy: number): { sx: number; sy: number } {
    const viewport = getViewport();
    if (!viewport) return { sx: wx * SCALE, sy: wy * SCALE };
    const state = cameraStateFromViewport(viewport, CANVAS_SIZE, pitch.current);
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
    if (pitch.current <= 0 || !deps.pickElevatedHit) return ground;
    const state = deps.getState();
    if (!state) return ground;
    const overlay = deps.getOverlay?.();
    const hit = deps.pickElevatedHit(
      ground.wx,
      ground.wy,
      pitch.current,
      overlay,
      state.map,
    );
    return { wx: hit.wx, wy: hit.wy };
  }

  // --- Pinch-to-zoom ---

  function onPinchStart(midX: number, midY: number): void {
    const { mode } = deps.getCtx();
    if (!isInteractiveMode(mode)) return;
    // While the engine's castle-frame override owns the viewport
    // (tower-frame zoom during CASTLE_SELECT), reject the gesture —
    // accepted pinch writes would tug-of-war against the per-frame lerp
    // back to `castleFrameVp`. Same guard as `centerCameraOnTap`.
    if (castleFrameVp) return;
    activePinch = {
      startVp: { ...currentVp },
      startMidX: midX,
      startMidY: midY,
    };
  }

  function onPinchUpdate(midX: number, midY: number, scale: number): void {
    const { mode } = deps.getCtx();
    if (!activePinch || !isInteractiveMode(mode)) return;
    // The override can also engage mid-gesture (selection zoom consuming
    // its deferred target) — stop updating rather than fight it.
    if (castleFrameVp) return;
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
      // User-intended fullMap — not overlay residue, so the per-frame
      // restore must leave it (otherwise the snap survives one frame).
      overlayParked = undefined;
    }
    // Emit the settled target on gesture end (intermediate per-frame
    // updates during pinch are continuous motion and intentionally not
    // emitted — see emitCameraTarget JSDoc).
    emitCameraTarget("userPinch");
  }

  /** Tap-nudge: when a single-finger tap lands in the outer
   *  12.5%-per-edge ring of the current viewport, smoothly pan (preserving
   *  zoom) so the tap point enters the inner 75% comfort zone. Tap inside
   *  the comfort zone → no-op.
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
    const pulled = pullPointIntoInset(seed, wx, wy, w * 0.125, h * 0.125);
    const toX = Math.max(0, Math.min(MAP_PX_W - w, pulled.x));
    const toY = Math.max(0, Math.min(MAP_PX_H - h, pulled.y));
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

  /** See `RuntimeCamera.snapToFullMapForTransition`. The target-parking
   *  block mirrors `unzoomForOverlays` (which early-returns afterward —
   *  the target is already fullMap — so the park stays once-per-episode);
   *  the snap additionally pins the rendered viewport so the first
   *  banner frame doesn't show a mid-lerp crop. */
  function snapToFullMapForTransition(): void {
    // Only callable from `runTransition`, where a session is always
    // installed — the null check is for the type, not a reachable state.
    const state = deps.getState();
    if (target.kind !== "fullMap" && state) {
      overlayParked = { target, phase: state.phase };
    }
    setTargetSilent(FULL_MAP_TARGET);
    castleFrameVp = undefined;
    currentVp.x = fullMapVp.x;
    currentVp.y = fullMapVp.y;
    currentVp.w = fullMapVp.w;
    currentVp.h = fullMapVp.h;
    lastVp = undefined;
  }

  /** Run `cb` once the in-flight pitch animation completes (in either
   *  direction — `flat` or `tilted` both count as settled). Fires
   *  synchronously when the pitch is already settled, so a caller that
   *  registers while nothing is animating still runs this frame instead of
   *  hanging on a callback that `tickPitch` would never invoke.
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
    if (isPitchSettled(pitch)) {
      callback();
      return;
    }
    pendingPitchSettled = callback;
  }

  /** Clear every camera-target / tracking field. Used by both `teardownSession`
   *  (game-over / quit-to-lobby) and `resetCamera` (rematch bootstrap). The
   *  goal is "no field can leak across game boundaries". The platform flag
   *  (`mobileZoomEnabled`) survives because it reflects the device, not the
   *  session. The rendered-frame viewport (`currentVp`) survives: its
   *  target is reset to full-map below, lobby substeps lerp it home, and
   *  rematch snaps it explicitly in `resetCamera`. The pitch must SNAP
   *  flat instead — the lobby and game-over screens render `getPitch()`
   *  unconditionally and nothing ever eases it back (Mode.STOPPED never
   *  ticks the anim; the lobby has no untilt owner), so a mid-battle
   *  quit/game-over otherwise draws them at the 30° battle tilt forever.
   *  No jump-cut concern: both paths replace the canvas content
   *  wholesale. */
  function clearAllZoomState(): void {
    setTargetSilent(FULL_MAP_TARGET);
    tapNudge = undefined;
    castleFrameVp = undefined;
    userZoomRatio = undefined;
    lastBattleCrosshairZone = undefined;
    lastAutoZoomPhase = undefined;
    selectionTargetVp = undefined;
    // This teardown fullMap is neither overlay-driven nor user-intended; a
    // stale parked target could spuriously restore on the next game's
    // first frame.
    overlayParked = undefined;
    // Drop any parked transition continuation (`awaitPitchSettled`). It
    // captures the dying session's transition ctx and GameState; left in
    // place, the next session's first pitch-settle frame would fire it
    // and replay a dead match's phase transition.
    pendingPitchSettled = undefined;
    resetPitchAnim(pitch);
  }

  function resetCamera(): void {
    clearAllZoomState();
    // Snap viewport to full map so there's no lerp animation on game start
    currentVp.x = fullMapVp.x;
    currentVp.y = fullMapVp.y;
    currentVp.w = fullMapVp.w;
    currentVp.h = fullMapVp.h;
    // `lastVp` aliases `currentVp` while zoomed; without this,
    // `getViewport()` reports a fullmap-equal viewport (instead of the
    // "at full map" undefined) until the first tickViewportLerp.
    lastVp = undefined;
  }

  /** Request an immediate untilt. Idempotent. Standalone path for the
   *  rare "flatten pitch but keep zoom" case — battle-done's pre-dispatch
   *  untilt gate (phase-ticks) is the sole flatten owner;
   *  `unzoomForOverlays` clears the viewport but never touches pitch. */
  function beginUntilt(): void {
    setPitchAnimTarget(pitch, 0);
  }

  /** Start the build→battle tilt. Called explicitly from the phase
   *  machine at battle-banner end (inside `proceedToBattleFromCtx`) so the
   *  tilt animation plays with the camera already at fullMapVp,
   *  BEFORE balloons / "ready" / auto-zoom into the battle zone. */
  function beginTilt(): void {
    setPitchAnimTarget(pitch, TILT_BATTLE_PITCH);
  }

  /** Current pitch state machine value. Sites that need the settle edge as a
   *  one-shot continuation use `awaitPitchSettled` instead — this getter is
   *  for call sites that already poll per tick. */
  function getPitchState(): PitchState {
    return pitch.state;
  }

  /** See `RuntimeCamera.snapPitchSettled`. The parked continuation is
   *  dropped, not fired: on the adoption path the snapshot apply itself
   *  sets the mode/flights the continuation would have set, so firing
   *  it would replay a superseded transition step. */
  function snapPitchSettled(settled: "flat" | "tilted"): void {
    pendingPitchSettled = undefined;
    snapPitchAnim(pitch, settled === "tilted" ? TILT_BATTLE_PITCH : 0);
  }

  function setCameraZone(zone: ZoneId): void {
    setCameraZoneInternal(zone, "userZone");
  }

  /** Internal setter that lets sub-systems (holdLifeLostZoom, follow-crosshair)
   *  attribute the source on the emitted CAMERA_TARGET event. The public
   *  `setCameraZone` is reserved for the zone-cycle button path.
   *
   *  Does NOT clear `castleFrameVp` — during SELECTION the
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
   *  Does NOT gate on `mobileAutoZoomActive()` here — the park is
   *  unconditional and cheap, and gating at consume time decides against
   *  the frame that actually applies the zoom rather than the
   *  between-frames moment `enterTowerSelection` parks it. */
  function setSelectionViewport(towerRow: number, towerCol: number): void {
    selectionTargetVp = { row: towerRow, col: towerCol };
  }

  function enableMobileZoom(): void {
    mobileZoomEnabled = true;
  }

  /** Zone the battle-start crosshair will occupy — the restored last-aimed
   *  enemy (if still alive) or, failing that, the best enemy. The camera
   *  frames THIS zone on battle entry so it always agrees with where the
   *  composition root's battle-aim seeding drops the crosshair. Framing
   *  `bestEnemyZone` independently let the two disagree: fight enemy B
   *  last round → the crosshair restores onto B, but the camera framed
   *  best-enemy A, so the crosshair sat off-screen. Read-only — does NOT
   *  consume `lastBattleCrosshair`. Null when there's no enemy or the
   *  target is off-grid. */
  function battleTargetZone(): ZoneId | null {
    const state = deps.getState();
    if (!state) return null;
    const target = battleTargetPosition(
      state.players,
      state.playerZones,
      state.map,
      povPlayerId(),
      deps.getLastBattleCrosshair(),
    );
    if (!target) return null;
    return zoneAtPixel(state.map, target.x, target.y) ?? null;
  }

  // --- Return public API ---

  return {
    tickCamera,
    getViewport,
    getPitch: () => pitch.current,
    getPitchMax: () => TILT_BATTLE_PITCH,
    beginUntilt,
    beginTilt,
    getPitchState,
    snapPitchSettled,
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
    snapToFullMapForTransition,
    awaitPitchSettled,
    getCameraZone: getZoneTarget,
    getViewedZone,
    setCameraZone,
    clearAllZoomState,
    resetCamera,
    setSelectionViewport,
    enableMobileZoom,
    isMobileAutoZoom: mobileAutoZoomActive,
  };
}

/** Map a world-pixel point to its zone id, or undefined when the tile is
 *  off-grid. Callers that treat "no zone" as null append `?? null` —
 *  `zoneAt` already returns undefined over river / letterbox tiles
 *  (zone 0 is `floodFillZones`' water sentinel; player zones start at 1). */
function zoneAtPixel(map: GameMap, px: number, py: number): ZoneId | undefined {
  const row = pxToTile(py);
  const col = pxToTile(px);
  if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) {
    return undefined;
  }
  return zoneAt(map, row, col);
}

/** Pull a world point inside a viewport's inset comfort rect: returns the
 *  viewport origin shifted the minimal amount so the point sits at least
 *  `insetX`/`insetY` from every edge (origin unchanged when the point is
 *  already inside). Shared by the crosshair edge-follow and the tap-nudge. */
function pullPointIntoInset(
  viewport: Viewport,
  px: number,
  py: number,
  insetX: number,
  insetY: number,
): { x: number; y: number } {
  let x = viewport.x;
  let y = viewport.y;
  if (px < viewport.x + insetX) x = px - insetX;
  else if (px > viewport.x + viewport.w - insetX) x = px - viewport.w + insetX;
  if (py < viewport.y + insetY) y = py - insetY;
  else if (py > viewport.y + viewport.h - insetY) y = py - viewport.h + insetY;
  return { x, y };
}
