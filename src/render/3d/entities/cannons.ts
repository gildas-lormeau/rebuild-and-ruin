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
import type { GameMap } from "../../../shared/core/geometry-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import {
  isBalloonCannon,
  isCannonAlive,
  isRampartCannon,
  isSuperCannon,
} from "../../../shared/core/spatial.ts";
import type { RenderOverlay } from "../../../shared/ui/overlay-types.ts";
import { buildCannon, getCannonVariant } from "../sprites/cannon-scene.ts";
import { buildRampart, getRampartVariant } from "../sprites/rampart-scene.ts";
import {
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
  update(overlay: RenderOverlay | undefined, map: GameMap | undefined): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

interface VariantBucket {
  readonly variant: VariantName;
  /** One InstancedMesh per sub-part of the authored variant. Shape is
   *  constant for the bucket's lifetime; capacity grows by replacement. */
  subParts: BucketSubPart[];
  capacity: number;
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

/** Cannon scenes are authored in a ±1 frustum covering a 2-tile span, so
 *  scaling by TILE_SIZE makes 1 authored unit = 1 game tile. Super-gun
 *  uses the same scale — its canvasPx is bigger but the frustum is still
 *  ±1, so the model is 2 world units wide and the 3×3 footprint is
 *  handled by positioning, not by a different scale. */
const CANNON_SCALE = TILE_SIZE;
/** Initial InstancedMesh capacity per variant bucket. A peak battle can
 *  field ~20-30 cannons per territory × 2-3 territories = 60-100 total
 *  live cannons, but the total is split across 6 variants (rampart,
 *  super, mortar, tier_1 and tier_2/tier_3 aren't selected by runtime
 *  today) — so 16 per bucket covers the common case with headroom.
 *  Grows power-of-two via `ensureBucket`. */
const INITIAL_CAPACITY = 16;

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

  // Scratch objects reused inside `update`.
  const hostMatrix = new THREE.Matrix4();
  const instanceMatrix = new THREE.Matrix4();
  const hostTranslation = new THREE.Vector3();
  const hostScale = new THREE.Vector3(CANNON_SCALE, CANNON_SCALE, CANNON_SCALE);
  const hostQuaternion = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);

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

  function update(
    overlay: RenderOverlay | undefined,
    _map: GameMap | undefined,
  ): void {
    const signature = computeSignature(overlay);
    if (signature === lastSignature) return;
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
        const variant = selectVariant(cannon);
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
      fillBucket(bucket, list, hostMatrix, instanceMatrix, (cannon, matrix) => {
        hostTranslation.set(
          cannon.col * TILE_SIZE + offset,
          0,
          cannon.row * TILE_SIZE + offset,
        );
        // Rampart has no barrel and never rotates; every other variant
        // rotates by `-facing` on Y (game's CW convention vs three.js's
        // CCW-from-+Y).
        const facing = isRampart ? 0 : (cannon.facing ?? 0);
        hostQuaternion.setFromAxisAngle(yAxis, -facing);
        matrix.compose(hostTranslation, hostQuaternion, hostScale);
      });
      // Ground discs (the swivel base + the authored shadow/AO halos)
      // stay hidden during battle so the cannon reads as planted on the
      // terrain itself.
      for (const subPart of bucket.subParts) {
        const partName = subPart.instanced.name;
        if (
          partName === "base" ||
          partName === "groundShadow" ||
          partName === "groundAO"
        ) {
          subPart.instanced.visible = !inBattle;
        }
      }
    }
  }

  function dispose(): void {
    disposeAllBuckets(buckets, ownedMaterials);
    scene.remove(root);
  }

  return { update, dispose };
}

/** Pick a bucket key for the cannon. Mirrors the 2D path's switch. */
function selectVariant(cannon: Cannon): VariantName {
  if (isRampartCannon(cannon)) return "rampart_cannon";
  if (isSuperCannon(cannon)) return "super_gun";
  if (cannon.mortar) return "mortar";
  return "tier_1";
}

/** Composite signature across every live cannon. Rebuilds only when one
 *  of the watched fields changes. `inBattle` is included because the
 *  base disc hides during battle. */
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
        }:${cannon.mortar ? 1 : 0}:${cannon.shielded ? 1 : 0}`,
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
  if (variant === "rampart_cannon") {
    const entry = getRampartVariant(variant);
    if (!entry) return undefined;
    scratchBuilder = (scratch) => buildRampart(THREE, scratch, entry.params);
  } else {
    const entry = getCannonVariant(variant);
    if (!entry) return undefined;
    scratchBuilder = (scratch) => buildCannon(THREE, scratch, entry.params);
  }
  const subParts = buildVariantBucket({
    capacity,
    root,
    ownedMaterials,
    scratchBuilder,
    namePrefix: `cannon-${variant}`,
  });
  // Preserve the shield-aura's draw-before-opaque hint from
  // rampart-scene: the authored plane sets `renderOrder = -1` so
  // opaque meshes render over it without z-fight. We replicate the
  // heuristic by authored ordering — the plane is the first sub-part
  // because `buildRampart` adds it first.
  if (variant === "rampart_cannon" && subParts.length > 0) {
    subParts[0]!.instanced.renderOrder = -1;
  }
  return { variant, subParts, capacity };
}
