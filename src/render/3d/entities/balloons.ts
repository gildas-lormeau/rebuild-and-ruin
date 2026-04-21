/**
 * 3D balloon meshes — Phase 4 of the 3D renderer migration.
 *
 * Balloons are a special kind of cannon (`CannonMode.BALLOON`) with two
 * visual states:
 *
 *   • `balloon_base`  — grounded mooring (2×2 tile). Rendered for every
 *     live balloon cannon that is NOT currently in flight. Anchored on
 *     the cannon's tile the same way regular 2×2 cannons are (top-left
 *     tile + 1-tile inward offset on both axes).
 *
 *   • `balloon_flight` — deployed envelope + basket (2×2 tile wide ×
 *     3 tiles tall). Rendered once per active flight in
 *     `overlay.battle.balloons`. The flight's basket is interpolated
 *     from the balloon's base position toward the target cannon along
 *     a parabolic arc (matches the 2D `drawBalloons` formula).
 *
 * Dispatch rule: a balloon cannon and a flight are NEVER rendered
 * together — during a flight the balloon is "taking off" and the 2D
 * path hides the base sprite. The cannons entity manager already
 * skips BALLOON cannons, so it's this manager's job to show the base
 * when grounded. Because flights only exist briefly between battles
 * and reference their own source position (overlay `x, y`), the set of
 * grounded balloons during a flight is unaffected — both visuals can
 * safely render in parallel if the game state ever produces both.
 *
 * Flight interpolation (matches `drawBalloons` in render-effects.ts):
 *   basketX = b.x + (b.targetX − b.x) · progress
 *   basketZ = b.y + (b.targetY − b.y) · progress
 *   liftY   = sin(progress · π) · ARC_MAX
 * Basket Y is driven by `liftY`; the rest of the envelope rides along
 * with the host group because the authored basket sits at
 * `yCenter=-1.375` and the host's world Y places that basket at ground
 * + liftY. The 2D path interpolates the envelope center with a basket
 * offset baked in; in 3D the authored scene already contains the
 * envelope/basket offset so we only need to lift the whole host.
 *
 * Cadence: we rebuild the mesh set only when the combined base/flight
 * fingerprint changes (count + per-entry position/flight-state). For
 * flights, `progress` is NOT part of the fingerprint — we rewrite the
 * host position per-frame (same pattern as `cannonballs.ts`). Balloon
 * counts are tiny (≤ a handful per round) so a teardown-and-rebuild on
 * set changes is fine.
 *
 * Tinting: balloons are neutral across owners (the 2D path uses one
 * sprite for all players). Future owner-tinting is deferred — same
 * reason as cannons.
 */

import * as THREE from "three";
import type { Cannon } from "../../../shared/core/battle-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import {
  isBalloonCannon,
  isCannonAlive,
} from "../../../shared/core/spatial.ts";
import type { RenderOverlay } from "../../../shared/ui/overlay-types.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import { buildBalloon, getBalloonVariant } from "../sprites/balloon-scene.ts";
import {
  disposeGroupSubtree,
  TILE_2X2_CENTER_OFFSET,
} from "./entity-helpers.ts";

export interface BalloonsManager {
  /** Reconcile balloon meshes (grounded bases + in-flight envelopes)
   *  with the overlay. Cheap no-op when the set fingerprint is
   *  unchanged; flight host positions are still rewritten per frame. */
  update(ctx: FrameCtx): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

type FlightOverlay = {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  progress: number;
};

/** Balloon scenes are authored in a ±1 frustum covering a 2-tile span
 *  (same authoring convention as the cannon scenes), so scaling by
 *  TILE_SIZE makes 1 authored unit = 1 game tile. `balloon_flight` is
 *  tall (3 tiles in canvas) but the XZ frustum is still ±1, so the
 *  same scale applies — the sprite extends Y-upward by construction. */
const BALLOON_SCALE = TILE_SIZE;
/** Apex lift for the flight arc, in world units. */
const FLIGHT_ARC_MAX = 200;
/** XZ progress curve edges — the balloon stays near its launch point
 *  for the first `XZ_HOLD_START` fraction of the flight (pure
 *  vertical rise), travels horizontally during the middle, then
 *  holds above the target for the last `1 - XZ_HOLD_END` fraction
 *  (pure vertical descent). `smoothstep` between those edges gives a
 *  gentle ease-in/ease-out. */
const XZ_HOLD_START = 0.2;
const XZ_HOLD_END = 0.8;
/** Envelope "breathing" bob amplitude — ±2% of its authored radius,
 *  applied uniformly on the envelope group's scale so the load ring
 *  rides along with the sphere. */
const ENVELOPE_BOB_AMPLITUDE = 0.02;
/** Bob period (seconds). Slow enough to read as a lazy drift under
 *  wind, not a pulsing throb. */
const ENVELOPE_BOB_PERIOD_SEC = 1.5;
/** Basket forward-tilt amplitude (radians). 3° ≈ 0.052. The tilt
 *  happens on the Z axis so the basket leans "forward/back" along the
 *  flight path's horizontal plane; at 3° the ropes drift by <0.5 px at
 *  display scale, which stays below the visual-change threshold. */
const BASKET_TILT_AMPLITUDE = (3 * Math.PI) / 180;
/** Basket tilt period (seconds). Co-prime with the envelope bob so the
 *  two animations stay visually out of phase instead of locking into
 *  a compound wobble. */
const BASKET_TILT_PERIOD_SEC = 1.2;
/** Gores rotation speed (radians per second). Slow — one full turn
 *  every ~20s reads as a subtle "balloon rolls with the current". */
const GORE_SPIN_RAD_PER_SEC = (2 * Math.PI) / 20;

export function createBalloonsManager(scene: THREE.Scene): BalloonsManager {
  const root = new THREE.Group();
  root.name = "balloons";
  scene.add(root);

  // No owner-tinted materials (balloons are neutral); keep the array so
  // the disposeGroupSubtree signature matches the other managers.
  const ownedMaterials: THREE.Material[] = [];

  /** Fingerprint of the current base/flight set — rebuilt only when
   *  this changes. Flight progress is NOT part of this; positions get
   *  rewritten every frame regardless when flights are present. */
  let lastSignature: string | undefined;
  /** Flight group references in the order they were added, so the
   *  per-frame position pass can walk them without filtering by name. */
  let flightHosts: THREE.Group[] = [];
  /** Flight overlays aligned 1:1 with `flightHosts`. */
  let flightOverlays: readonly FlightOverlay[] = [];

  function clear(): void {
    disposeGroupSubtree(root, ownedMaterials);
    flightHosts = [];
    flightOverlays = [];
  }

  function buildAllBalloons(
    bases: readonly Cannon[],
    flights: readonly FlightOverlay[],
  ): void {
    const baseVariant = getBalloonVariant("balloon_base");
    if (baseVariant) {
      for (const cannon of bases) {
        const host = new THREE.Group();
        buildBalloon(THREE, host, baseVariant);
        host.position.set(
          cannon.col * TILE_SIZE + TILE_2X2_CENTER_OFFSET,
          0,
          cannon.row * TILE_SIZE + TILE_2X2_CENTER_OFFSET,
        );
        host.scale.setScalar(BALLOON_SCALE);
        root.add(host);
      }
    }

    const flightVariant = getBalloonVariant("balloon_flight");
    if (flightVariant) {
      for (const _ of flights) {
        const host = new THREE.Group();
        buildBalloon(THREE, host, flightVariant);
        host.scale.setScalar(BALLOON_SCALE);
        root.add(host);
        flightHosts.push(host);
      }
    }
    flightOverlays = flights;
  }

  function positionFlights(nowMs: number): void {
    const nowSec = nowMs / 1000;
    const envelopeBob =
      1 +
      ENVELOPE_BOB_AMPLITUDE *
        Math.sin((nowSec / ENVELOPE_BOB_PERIOD_SEC) * 2 * Math.PI);
    const basketTilt =
      BASKET_TILT_AMPLITUDE *
      Math.sin((nowSec / BASKET_TILT_PERIOD_SEC) * 2 * Math.PI);
    const gorePhase = (nowSec * GORE_SPIN_RAD_PER_SEC) % (2 * Math.PI);
    for (let i = 0; i < flightHosts.length; i++) {
      const host = flightHosts[i]!;
      const overlay = flightOverlays[i];
      if (!overlay) continue;
      // Real-balloon trajectory: vertical rise first, then cross, then
      // vertical descent. Y uses a sine arc (symmetric rise/fall with
      // apex at progress=0.5); XZ uses smoothstep delayed to progress
      // ∈ [XZ_HOLD_START, XZ_HOLD_END] so the first and last ~20% of
      // the flight reads as pure vertical motion. Deliberately diverges
      // from the 2D `drawBalloons` path, which ran linear XZ; the new
      // curve only affects the 3D visual.
      const progress = overlay.progress;
      const xzProgress = smoothstep(XZ_HOLD_START, XZ_HOLD_END, progress);
      const worldX = overlay.x + (overlay.targetX - overlay.x) * xzProgress;
      const worldZ = overlay.y + (overlay.targetY - overlay.y) * xzProgress;
      const lift = Math.sin(progress * Math.PI) * FLIGHT_ARC_MAX;
      host.position.set(worldX, lift, worldZ);
      // C2 polish — envelope breathes, basket rocks, gores drift. All
      // derived from `now` so every in-flight balloon shares phase
      // (they all feel the same "wind"). `getObjectByName` is a
      // recursive search over a ~15-node subtree; for the typical 1-2
      // active flights that's negligible per frame.
      const envelopeGroup = host.getObjectByName("envelope");
      if (envelopeGroup) envelopeGroup.scale.setScalar(envelopeBob);
      const basketGroup = host.getObjectByName("basket");
      if (basketGroup) basketGroup.rotation.z = basketTilt;
      const goresGroup = host.getObjectByName("gores");
      if (goresGroup) goresGroup.rotation.y = gorePhase;
    }
  }

  function update(ctx: FrameCtx): void {
    const { overlay, now } = ctx;
    const bases = collectGroundedBalloons(overlay);
    const flights = overlay?.battle?.balloons ?? [];
    const signature = computeSignature(bases, flights);
    if (signature !== lastSignature) {
      clear();
      lastSignature = signature;
      if (bases.length === 0 && flights.length === 0) return;
      buildAllBalloons(bases, flights);
    }
    // Per-frame: refresh overlay refs so `progress` is current. The
    // signature intentionally excludes progress (to avoid rebuilds), so
    // without this rebind `positionFlights` would read the stale array
    // captured at rebuild time and the balloon would sit at progress=0.
    flightOverlays = flights;
    if (flightHosts.length > 0) positionFlights(now);
  }

  function dispose(): void {
    clear();
    scene.remove(root);
    lastSignature = undefined;
  }

  return { update, dispose };
}

/** Smoothstep: clamped-and-eased remap of `t` from [edge0, edge1] to
 *  [0, 1] using the canonical `3t² − 2t³` Hermite curve. Returns 0
 *  below `edge0`, 1 above `edge1`, ease-in/ease-out between. */
function smoothstep(edge0: number, edge1: number, t: number): number {
  const x = Math.max(0, Math.min(1, (t - edge0) / (edge1 - edge0)));
  return x * x * (3 - 2 * x);
}

/** Collect every live balloon cannon across every castle. Dead
 *  balloons are owned by the debris manager (via the shared cannon-
 *  debris path), not here. */
function collectGroundedBalloons(overlay: RenderOverlay | undefined): Cannon[] {
  const out: Cannon[] = [];
  if (!overlay?.castles) return out;
  for (const castle of overlay.castles) {
    for (const cannon of castle.cannons) {
      if (!isCannonAlive(cannon)) continue;
      if (!isBalloonCannon(cannon)) continue;
      out.push(cannon);
    }
  }
  return out;
}

/** Composite fingerprint: grounded-base positions + flight count with
 *  each flight's source/target (NOT progress — progress drives per-frame
 *  position rewrites without a full rebuild). */
function computeSignature(
  bases: readonly Cannon[],
  flights: readonly FlightOverlay[],
): string {
  const parts: string[] = [];
  for (const cannon of bases) {
    parts.push(`b:${cannon.col}:${cannon.row}`);
  }
  for (const flight of flights) {
    parts.push(`f:${flight.x}:${flight.y}:${flight.targetX}:${flight.targetY}`);
  }
  return parts.join("|");
}
