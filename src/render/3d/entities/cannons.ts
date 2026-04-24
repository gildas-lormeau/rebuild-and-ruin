/**
 * 3D live-cannon meshes — Phase 4 of the 3D renderer migration, with
 * Phase 8c instancing on top.
 *
 * Renders every alive cannon across all castles. Dead cannons are owned
 * by `./debris.ts`; balloon-mode cannons are owned by `./balloons.ts`
 * (they have their own base/flight sprites that don't map onto the
 * regular cannon-scene variants).
 *
 * Variant selection by `CannonMode` + flags (mirrors the 2D picker in
 * `drawCastleCannons` — render-map.ts):
 *
 *   • RAMPART  → `rampart_cannon` (built by `buildRampart`). Static,
 *     never rotated. Ships with a shield-aura translucent ground plane
 *     as part of the sprite.
 *   • SUPER    → `super_gun`. 3×3 footprint so the anchor offset is
 *     1.5 tiles (vs the 2×2 offset of 1 tile).
 *   • default  → `mortar` when `cannon.mortar === true`, else `tier_1`.
 *     The live game doesn't carry a cannon "tier" in state — every
 *     regular cannon lands on `tier_1` (parity with the 2D sprites
 *     which also use a single "cannon" sprite regardless of tier).
 *
 * Rotation: the scene builder authors the barrel pointing toward −Z
 * (facing=0 in the game is "up"/north; terrain maps north to decreasing
 * row, which is −Z in world space). The game's `cannon.facing` is in
 * radians with 0 = up and positive = clockwise (atan2(dx, -dy)), so the
 * host matrix's Y rotation is `-facing`. Rampart cannons are not rotated.
 *
 * Player-color tinting: deferred (see towers.ts for the pattern used
 * elsewhere). The authored cannon scene has no tint-tagged mesh, so we
 * render one bucket per variant without per-player sub-buckets. If
 * tinting lands later the bucket key becomes `(variant, ownerId)`.
 *
 * Instancing approach — "extract-and-instance" (same pattern as walls.ts
 * and grunts.ts):
 *
 *   1. Lazily per variant: run `buildCannon` or `buildRampart` once
 *      into a throwaway Group. Extract each Mesh as
 *      `{ geometry, material, localMatrix }` via `extractSubParts`.
 *   2. For each sub-part of that variant, create one `InstancedMesh`
 *      attached to the manager's root group.
 *   3. Per fingerprint change: bucket cannons by variant, compute each
 *      cannon's host matrix (translate + rotate + scale), and write
 *      `hostMatrix * subPart.localMatrix` via `setMatrixAt`. Clamp
 *      `.count` to the live bucket size so unused slots don't render.
 *
 * Rampart shield aura: `buildRampart` authors the shield as a plain
 * `THREE.PlaneGeometry` with a basic opacity=0.32 material and
 * `renderOrder = -1`. The extracted mesh keeps the same geometry and
 * material, and `InstancedMesh` copies the source `renderOrder` through
 * its own `.renderOrder` field if we set it explicitly — `extractSubParts`
 * only captures geometry/material/matrix, so we preserve the authored
 * ordering when the extracted part is named "aura"/is the plane. The
 * transparent material is shared across instances by design; three.js
 * sorts transparent InstancedMesh draws as a single unit, which is
 * fine because every rampart aura lies on the same ground plane — no
 * intra-bucket depth to resolve. Verified visually against the 2D
 * shield tint — no z-fighting or ordering regressions.
 *
 * Update cadence: cannon set changes on placement, firing (facing
 * changes), destruction, and battle start (mortar flag). A composite
 * fingerprint (per cannon: playerId/col/row/mode/facing/mortar/shielded)
 * lets steady-state frames early-out.
 */

import * as THREE from "three";
import type { CannonMode } from "../../../shared/core/battle-types.ts";
import { NORMAL_CANNON_SIZE } from "../../../shared/core/game-constants.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import {
  cannonSize,
  isBalloonCannon,
  isCannonAlive,
} from "../../../shared/core/spatial.ts";
import type { RenderOverlay } from "../../../shared/ui/overlay-types.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import {
  barrelWorldPoints,
  buildCannon,
  getCannonVariant,
} from "../sprites/cannon-scene.ts";
import { buildRampart, getRampartVariant } from "../sprites/rampart-scene.ts";
import {
  cannonKind,
  subPartHasTag,
  TILE_2X2_CENTER_OFFSET,
  TILE_3X3_CENTER_OFFSET,
} from "./entity-helpers.ts";
import {
  type BucketSubPart,
  buildVariantBucket,
  disposeAllBuckets,
  ensureBucketCapacity,
  fillBucket,
  hideSubParts,
} from "./instance-bucket.ts";

export interface CannonsManager {
  /** Reconcile live cannon meshes across every castle. Cheap no-op when
   *  the composite fingerprint hasn't changed since the last call. */
  update(ctx: FrameCtx): void;
  /** True when any cannon's displayed facing hasn't yet caught up to its
   *  target — i.e. the facing ease is in progress. The runtime's
   *  battle-end transition polls this (via `RendererInterface`) so it
   *  can wait until the post-battle `resetCannonFacings` rotation has
   *  settled before starting the camera untilt, instead of relying on
   *  a wall-clock duration that a paused tab would skip past. */
  isEasing(): boolean;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

interface VariantBucket {
  readonly variant: VariantName;
  /** One InstancedMesh per sub-part of the authored variant. Shape is
   *  constant for the bucket's lifetime; capacity grows by replacement. */
  subParts: BucketSubPart[];
  capacity: number;
  /** Trunnion pivot in cannon-authored local space — the same point the
   *  scene builder uses as `barrelGroup.position` when applying the
   *  authored elevation. Set only for variants whose barrel recoils
   *  (every cannon except rampart). `undefined` signals "no barrel" to
   *  the per-instance adjustLocal hook, which skips the transform
   *  computation entirely. */
  readonly barrelPivot: THREE.Vector3 | undefined;
}

type VariantName =
  | "tier_1"
  | "tier_2"
  | "tier_3"
  | "super_gun"
  | "mortar"
  | "rampart_cannon";

interface Cannon {
  readonly col: number;
  readonly row: number;
  readonly mode: CannonMode;
  readonly facing?: number;
  readonly mortar?: boolean;
  readonly hp?: number;
  readonly shielded?: boolean;
}

interface BarrelState {
  currentPitch: number;
  targetPitch: number;
}

interface FacingState {
  displayed: number;
  target: number;
}

/** Cannon scenes are authored in a ±1 frustum covering a NORMAL_CANNON_SIZE
 *  tile span, so to make 1 authored unit = 1 game tile a 2×2 cannon uses
 *  scale = TILE_SIZE. Larger footprints (super_gun = 3×3) scale
 *  proportionally so the rendered model fills its actual tile footprint
 *  instead of sitting inside a 2×2 subset of it. */
const cannonScaleForSize = (size: number): number =>
  (size * TILE_SIZE) / NORMAL_CANNON_SIZE;
/** Initial InstancedMesh capacity per variant bucket. A peak battle can
 *  field ~20-30 cannons per territory × 2-3 territories = 60-100 total
 *  live cannons, but the total is split across 6 variants (rampart,
 *  super, mortar, tier_1 and tier_2/tier_3 aren't selected by runtime
 *  today) — so 16 per bucket covers the common case with headroom.
 *  Grows power-of-two via `ensureBucket`. */
const INITIAL_CAPACITY = 16;
/** Recoil pitch (radians) that the barrel rotates up to while a shot is
 *  in flight from that cannon. 22.5° reads as a visible kick without
 *  scraping the authored elevation angle. Kept fixed across variants so
 *  every cannon has the same firing "language" — the visual differentiation
 *  comes from the authored elevations + muzzle positions, not the recoil. */
const BARREL_RECOIL_PITCH = Math.PI / 8;
/** Ease rate per second for the barrel snap-up (ball spawns). Faster than
 *  the settle so the kick reads as a punch, the return reads as a drift. */
const BARREL_EASE_UP_PER_SEC = 12;
/** Ease rate per second for the return to rest (ball lands / despawns). */
const BARREL_EASE_DOWN_PER_SEC = 4;
/** Below this magnitude (radians) a resting barrel is considered "at 0"
 *  and its state entry is pruned from the map. Prevents infinite
 *  asymptotic easing from keeping the map populated forever. */
const BARREL_REST_EPSILON = 1e-4;
/** Ease rate per second for the yaw/facing animation. Tuned so a 180°
 *  flip settles in ~300 ms. The battle-end transition in
 *  `runtime-phase-ticks.ts` polls `CannonsManager.isEasing()` (via
 *  `RendererInterface.isCannonRotationEasing`) and waits frame-by-frame
 *  for this ease to finish before starting the camera untilt. */
const FACING_EASE_PER_SEC = 12;
/** Below this absolute delta (radians) between displayed and target the
 *  facing is considered settled; the state entry is pruned. Matches the
 *  barrel epsilon for the same reason. */
const FACING_REST_EPSILON = 1e-4;

export function createCannonsManager(scene: THREE.Scene): CannonsManager {
  const root = new THREE.Group();
  root.name = "cannons";
  scene.add(root);

  // One bucket per variant, allocated lazily on first use. Typical
  // battles only visit `tier_1` + one or two of `mortar`/`super_gun`/
  // `rampart_cannon`, so we don't pay for unused buckets.
  const buckets = new Map<VariantName, VariantBucket>();
  const ownedMaterials: THREE.Material[] = [];
  let lastSignature: string | undefined;
  /** Per-cannon barrel pitch state, keyed by `${col}:${row}` (cannons
   *  never overlap, so no playerId needed in the key). Entries are
   *  created on the first frame a ball spawns from the cannon and
   *  pruned when the pitch has decayed back to ~0. Map is live across
   *  frames so the ease progresses continuously. */
  const barrelStates = new Map<string, BarrelState>();
  let lastBarrelFrameTime: number | undefined;
  /** Per-cannon displayed facing state, keyed by `${col}:${row}`. Created
   *  lazily on the first frame we see a cannon, and eased toward the
   *  current `cannon.facing` each frame so abrupt facing changes (e.g.
   *  the battle-end reset to `defaultFacing`) render as a smooth rotation
   *  rather than a snap. Entries are pruned once settled. */
  const facingStates = new Map<string, FacingState>();

  // Scratch objects reused inside `update`.
  const hostMatrix = new THREE.Matrix4();
  const instanceMatrix = new THREE.Matrix4();
  const hostTranslation = new THREE.Vector3();
  const hostScale = new THREE.Vector3();
  const hostQuaternion = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);
  /** Scratch matrices for the per-instance barrel adjustment. Composed
   *  as `T(pivot) · R_x(recoil) · T(-pivot) · localMatrix`, then the
   *  outer `hostMatrix · adjusted` multiply writes the instance slot. */
  const barrelAdjust = new THREE.Matrix4();
  const barrelRotation = new THREE.Matrix4();
  const negPivot = new THREE.Vector3();

  function ensureBucket(
    variant: VariantName,
    required: number,
  ): VariantBucket | undefined {
    // Grow or create: `ensureBucketCapacity` tears down any existing
    // InstancedMeshes (InstancedMesh.count is fixed at construction) and
    // rebuilds at the new capacity.
    return ensureBucketCapacity(
      buckets,
      variant,
      required,
      INITIAL_CAPACITY,
      (capacity) => buildBucket(variant, capacity, root, ownedMaterials),
    );
  }

  function update(ctx: FrameCtx): void {
    const { overlay, now } = ctx;
    // Ease barrel states first so `hasAnimatingBarrels` below reflects
    // the updated state. `ctx.now` is the frame's wall-clock timestamp —
    // we derive a real dt from it so the ease rate is independent of
    // the sim tick cadence (the ease is pure presentation, not gameplay).
    const easeDt =
      lastBarrelFrameTime === undefined
        ? 0
        : Math.max(0, Math.min(0.1, (now - lastBarrelFrameTime) / 1000));
    lastBarrelFrameTime = now;
    applyFiringTargets(overlay);
    easeBarrelStates(easeDt);
    applyFacingTargets(overlay);
    easeFacingStates(easeDt);

    const signature = computeSignature(overlay);
    const hasAnimatingBarrels = barrelStates.size > 0;
    const hasAnimatingFacings = anyFacingEasing();
    if (
      signature === lastSignature &&
      !hasAnimatingBarrels &&
      !hasAnimatingFacings
    )
      return;
    lastSignature = signature;

    if (!overlay?.castles || signature === "") {
      // Hide all instances; keep buckets alive so common "cannons come
      // and go" churn doesn't thrash GPU buffers.
      for (const bucket of buckets.values()) hideSubParts(bucket.subParts);
      return;
    }

    // Pre-bucket cannons by variant so we know capacity up front.
    const byVariant = new Map<VariantName, Cannon[]>();
    for (const castle of overlay.castles) {
      for (const cannon of castle.cannons) {
        if (!isCannonAlive(cannon)) continue;
        if (isBalloonCannon(cannon)) continue;
        const variant = selectVariant(cannon, castle.cannonTier);
        let list = byVariant.get(variant);
        if (!list) {
          list = [];
          byVariant.set(variant, list);
        }
        list.push(cannon);
      }
    }

    // Variants that have a bucket but no live cannons this frame —
    // zero their count so stale instances don't ghost-render.
    for (const [variant, bucket] of buckets) {
      if (!byVariant.has(variant)) hideSubParts(bucket.subParts);
    }

    const inBattle = !!overlay?.battle?.inBattle;

    // Write matrices for each live variant.
    for (const [variant, list] of byVariant) {
      const bucket = ensureBucket(variant, list.length);
      if (!bucket) continue;
      const isSuper = variant === "super_gun";
      const isRampart = variant === "rampart_cannon";
      const offset = isSuper ? TILE_3X3_CENTER_OFFSET : TILE_2X2_CENTER_OFFSET;
      const size = cannonSize(list[0]!.mode);
      const scale = cannonScaleForSize(size);
      hostScale.set(scale, scale, scale);
      const pivot = bucket.barrelPivot;
      fillBucket(
        bucket,
        list,
        hostMatrix,
        instanceMatrix,
        (cannon, matrix) => {
          hostTranslation.set(
            cannon.col * TILE_SIZE + offset,
            0,
            cannon.row * TILE_SIZE + offset,
          );
          // Rampart has no barrel and never rotates; every other variant
          // rotates by `-facing` on Y (game's CW convention vs three.js's
          // CCW-from-+Y). Non-rampart cannons use the eased displayed
          // facing so abrupt state changes (battle-end reset, post-fire
          // aim shifts) render as a rotation rather than a snap.
          const facing = isRampart ? 0 : getDisplayedFacing(cannon);
          hostQuaternion.setFromAxisAngle(yAxis, -facing);
          matrix.compose(hostTranslation, hostQuaternion, hostScale);
        },
        // Per-instance local-matrix override: barrel sub-parts of a
        // recoiling cannon get a pivoted R_x(recoil) pre-multiplied onto
        // their authored local matrix. Static parts (base, cheeks,
        // decorations) return undefined and keep their authored local.
        pivot === undefined
          ? undefined
          : (cannon, part) => {
              if (!subPartHasTag(part, "barrel")) return undefined;
              const pitch = getBarrelPitch(cannon);
              if (pitch === 0) return undefined;
              // T(pivot) · R_x(pitch) · T(-pivot) · localMatrix
              barrelAdjust.makeTranslation(pivot.x, pivot.y, pivot.z);
              barrelRotation.makeRotationX(pitch);
              barrelAdjust.multiply(barrelRotation);
              negPivot.set(-pivot.x, -pivot.y, -pivot.z);
              barrelRotation.makeTranslation(
                negPivot.x,
                negPivot.y,
                negPivot.z,
              );
              barrelAdjust.multiply(barrelRotation);
              barrelAdjust.multiply(part.localMatrix);
              return barrelAdjust;
            },
      );
      // Ground discs (the swivel base + the authored shadow/AO halos)
      // stay hidden during battle so the cannon reads as planted on the
      // terrain itself. Authored-side tag drives the hide — no name
      // coupling to "base" / "groundShadow" / "groundAO".
      for (const subPart of bucket.subParts) {
        if (subPartHasTag(subPart, "battle-hidden")) {
          subPart.instanced.visible = !inBattle;
        }
      }
    }
  }

  /** Set `targetPitch = BARREL_RECOIL_PITCH` for every cannon that
   *  currently has a ball in flight; clear the target on all others.
   *  Matching is positional — `ball.startX/startY` equals the cannon
   *  center by construction (see `cannonCenter` in spatial.ts), so we
   *  key on the cannon's (col, row) derived from the ball start. */
  function applyFiringTargets(overlay: RenderOverlay | undefined): void {
    // Default every existing state back to 0; balls in flight below
    // will override this to the recoil angle.
    for (const state of barrelStates.values()) state.targetPitch = 0;
    const balls = overlay?.battle?.cannonballs;
    if (!balls || balls.length === 0) return;
    for (const ball of balls) {
      // Spent balls are at their landing point — the firing cannon's
      // recoil should ease back, not hold the kicked-up pose for an
      // extra frame.
      if (ball.spent) continue;
      // `startX = (col + size/2) * TILE_SIZE`. We don't know `size`
      // here without searching the castles, but the key just needs to
      // be stable per-cannon across frames. Using the raw startX /
      // startY pair as the key — two cannons cannot share a center
      // (footprints don't overlap) so the identity holds.
      const key = cannonKeyFromCenter(ball.startX, ball.startY);
      let state = barrelStates.get(key);
      if (!state) {
        state = { currentPitch: 0, targetPitch: 0 };
        barrelStates.set(key, state);
      }
      state.targetPitch = BARREL_RECOIL_PITCH;
    }
  }

  /** Linear ease toward target with direction-dependent rate; drop
   *  entries that have settled at ~0. */
  function easeBarrelStates(dt: number): void {
    if (dt === 0) {
      // Still prune settled entries so the map doesn't grow unbounded
      // on the very first frame after initialization.
      for (const [key, state] of barrelStates) {
        if (isSettledAtZero(state)) barrelStates.delete(key);
      }
      return;
    }
    for (const [key, state] of barrelStates) {
      const rising = state.targetPitch > state.currentPitch;
      const rate = rising ? BARREL_EASE_UP_PER_SEC : BARREL_EASE_DOWN_PER_SEC;
      const step = Math.min(1, rate * dt);
      state.currentPitch += (state.targetPitch - state.currentPitch) * step;
      if (isSettledAtZero(state)) barrelStates.delete(key);
    }
  }

  /** Ensure every live cannon has a facing-state entry and set its target
   *  to the current `cannon.facing`. A fresh entry snaps displayed to
   *  target (first-frame appearances shouldn't animate in from 0). Keys
   *  for cannons that no longer exist (destroyed, zone reset) are pruned
   *  so the map stays bounded; settled entries are retained so an
   *  abrupt target flip (e.g. battle-end reset) still eases from the
   *  previous facing rather than snapping to a freshly-created entry. */
  function applyFacingTargets(overlay: RenderOverlay | undefined): void {
    const seen = new Set<string>();
    if (overlay?.castles) {
      for (const castle of overlay.castles) {
        for (const cannon of castle.cannons) {
          if (!isCannonAlive(cannon)) continue;
          if (isBalloonCannon(cannon)) continue;
          const key = cannonKeyFromPosition(cannon);
          seen.add(key);
          const target = cannon.facing ?? 0;
          const state = facingStates.get(key);
          if (state === undefined) {
            facingStates.set(key, { displayed: target, target });
          } else {
            state.target = target;
          }
        }
      }
    }
    for (const key of facingStates.keys()) {
      if (!seen.has(key)) facingStates.delete(key);
    }
  }

  /** Linear ease toward target, via the shortest angular path so a
   *  ±π flip rotates the short way. Entries are retained even once
   *  settled — see `applyFacingTargets` for why. */
  function easeFacingStates(dt: number): void {
    if (dt === 0) return;
    const step = Math.min(1, FACING_EASE_PER_SEC * dt);
    for (const state of facingStates.values()) {
      const delta = shortestAngleDelta(state.displayed, state.target);
      if (Math.abs(delta) < FACING_REST_EPSILON) {
        state.displayed = state.target;
      } else {
        state.displayed += delta * step;
      }
    }
  }

  function getDisplayedFacing(cannon: Cannon): number {
    const key = cannonKeyFromPosition(cannon);
    return facingStates.get(key)?.displayed ?? cannon.facing ?? 0;
  }

  /** True if any cannon's displayed facing hasn't converged to its
   *  target — i.e. an ease is in progress. The map always contains an
   *  entry per live cannon (see `applyFacingTargets`), so `.size > 0`
   *  would fail the steady-state early-out. */
  function anyFacingEasing(): boolean {
    for (const state of facingStates.values()) {
      if (state.displayed !== state.target) return true;
    }
    return false;
  }

  function getBarrelPitch(cannon: Cannon): number {
    const half = cannonSize(cannon.mode) / 2;
    const centerX = (cannon.col + half) * TILE_SIZE;
    const centerY = (cannon.row + half) * TILE_SIZE;
    return (
      barrelStates.get(cannonKeyFromCenter(centerX, centerY))?.currentPitch ?? 0
    );
  }

  function dispose(): void {
    disposeAllBuckets(buckets, ownedMaterials);
    scene.remove(root);
  }

  return { update, isEasing: anyFacingEasing, dispose };
}

/** Pick a bucket key for the cannon. Mirrors the 2D path's switch. The
 *  caller guarantees non-balloon cannons (balloons are filtered out
 *  before this is reached), so the "balloon" kind is unreachable.
 *
 *  `tier` applies only to regular cannons — super/mortar/rampart have
 *  their own authored sprites and keep them at every tier (speed boost
 *  still applies via ballSpeedMult in the simulation). */
function selectVariant(cannon: Cannon, tier: 1 | 2 | 3): VariantName {
  const kind = cannonKind(cannon);
  switch (kind) {
    case "rampart":
      return "rampart_cannon";
    case "super":
      return "super_gun";
    case "mortar":
      return "mortar";
    case "tier_1":
      return tier === 1 ? "tier_1" : tier === 2 ? "tier_2" : "tier_3";
    case "balloon":
      throw new Error("selectVariant: balloon cannons are filtered upstream");
  }
}

/** Composite signature across every live cannon. Rebuilds only when one
 *  of the watched fields changes. `inBattle` is included because the
 *  base disc hides during battle; `cannonTier` so regular cannons swap
 *  to the matching tier sprite when the owning player loses a life. */
function computeSignature(overlay: RenderOverlay | undefined): string {
  if (!overlay?.castles) return "";
  const parts: string[] = [overlay.battle?.inBattle ? "b" : "p"];
  for (const castle of overlay.castles) {
    for (const cannon of castle.cannons) {
      if (!isCannonAlive(cannon)) continue;
      if (isBalloonCannon(cannon)) continue;
      parts.push(
        `${castle.playerId}:${cannon.col}:${cannon.row}:${cannon.mode}:${
          cannon.facing ?? 0
        }:${cannon.mortar ? 1 : 0}:${cannon.shielded ? 1 : 0}:${castle.cannonTier}`,
      );
    }
  }
  return parts.join("|");
}

/** Build a bucket for one variant: run the matching scene builder once
 *  into a scratch group, extract every sub-mesh, and wrap each as an
 *  `InstancedMesh` under `root`. Returns `undefined` if the variant is
 *  unknown to its registry. */
function buildBucket(
  variant: VariantName,
  capacity: number,
  root: THREE.Group,
  ownedMaterials: THREE.Material[],
): VariantBucket | undefined {
  let scratchBuilder: ((scratch: THREE.Group) => void) | undefined;
  let barrelPivot: THREE.Vector3 | undefined;
  if (variant === "rampart_cannon") {
    const entry = getRampartVariant(variant);
    if (!entry) return undefined;
    scratchBuilder = (scratch) => buildRampart(THREE, scratch, entry.params);
  } else {
    const entry = getCannonVariant(variant);
    if (!entry) return undefined;
    scratchBuilder = (scratch) => buildCannon(THREE, scratch, entry.params);
    // Trunnion pivot in cannon-local (authored) space. Matches the
    // `barrelGroup.position` buildCannon uses when applying the authored
    // elevation — recoil rotation pivots around this same point at
    // render time so the recoil composes on top of the authored tilt.
    const pivot = barrelWorldPoints(entry.params.barrel).center;
    barrelPivot = new THREE.Vector3(pivot[0], pivot[1], pivot[2]);
  }
  const subParts = buildVariantBucket({
    capacity,
    root,
    ownedMaterials,
    scratchBuilder,
    namePrefix: `cannon-${variant}`,
  });
  // Shield-aura render-behind hint now comes from the authored
  // `render-behind` tag (see rampart-scene.ts); `buildVariantBucket`
  // applies it generically.
  return { variant, subParts, capacity, barrelPivot };
}

/** Stable per-cannon key derived from its world-pixel center. Cannons
 *  never share a footprint, so distinct cannons produce distinct keys.
 *  Rounded to integer pixels so float precision doesn't drift the key
 *  across frames when `ball.startX/Y` vs a freshly recomputed cannon
 *  center may differ in the last bit. */
function cannonKeyFromCenter(centerX: number, centerY: number): string {
  return `${Math.round(centerX)}:${Math.round(centerY)}`;
}

/** True when the barrel state has eased back to rest and its target is 0
 *  — the entry can be removed from the map. */
function isSettledAtZero(state: BarrelState): boolean {
  return (
    state.targetPitch === 0 &&
    Math.abs(state.currentPitch) < BARREL_REST_EPSILON
  );
}

/** Stable key for a cannon's facing-state entry. Cannons never share a
 *  footprint so (col, row) is unique per cannon. */
function cannonKeyFromPosition(cannon: Cannon): string {
  return `${cannon.col}:${cannon.row}`;
}

/** Signed shortest angular delta `target - from`, wrapped to `(-π, π]`
 *  so a flip across ±π rotates the short way. */
function shortestAngleDelta(from: number, target: number): number {
  const TAU = Math.PI * 2;
  let delta = (((target - from) % TAU) + TAU) % TAU;
  if (delta > Math.PI) delta -= TAU;
  return delta;
}
