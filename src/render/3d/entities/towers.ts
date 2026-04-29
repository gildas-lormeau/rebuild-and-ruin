/**
 * 3D tower meshes — Phase 3 of the 3D renderer migration, with
 * per-variant InstancedMesh on top.
 *
 * Towers live on the `GameMap` (stable list, one entry per selectable
 * keep) and the overlay attaches per-frame ownership data:
 *
 *   • `overlay.entities.ownedTowers` — Map<towerIdx, playerId> for every
 *     tower a player has claimed (their original home tower + any
 *     secondary towers they've enclosed). Drives per-bucket tinting of
 *     flag, body, parapet, and pole-base sub-parts.
 *   • `overlay.entities.homeTowerIndices` — set of tower indices that
 *     are a player's *original* home tower. Selects `home_tower`
 *     geometry; other towers use `secondary_tower`.
 *   • `overlay.entities.towerAlive` — boolean[] indexed by towerIdx.
 *     Dead towers are skipped here — the 3D `debris` entity manager
 *     renders their rubble piles under a separate layer flag.
 *
 * Instancing approach: same `extract-and-instance` pattern as walls /
 * cannons / houses, but the bucket key is `(variantName, ownerId)`
 * — tinting is baked into the scratch (via `tintNamedMeshes`) before
 * extraction, so each unique (variant, owner) pair has its own bucket
 * with already-tinted materials. No per-instance color, no shader
 * tricks: the cost of distinguishing tints is one extra bucket per
 * (variant, owner) pair, materializing only when that pair is actually
 * present this frame.
 *
 * Worst case: 2 variants × (4 player tints + 1 unowned) = 10 buckets ×
 * ~15 sub-parts/bucket = ~150 InstancedMeshes. Practically ~4-6 buckets
 * are active at once = ~60-90 InstancedMeshes. Down from ~180 unique
 * meshes pre-refactor (one Group per tower, each with its own mesh
 * tree).
 */

import * as THREE from "three";
import type { Tower } from "../../../shared/core/geometry-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import type { ValidPlayerSlot } from "../../../shared/core/player-slot.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import { buildTower, getTowerVariant } from "../sprites/tower-scene.ts";
import { tintNamedMeshes } from "./entity-helpers.ts";
import {
  type BucketSubPart,
  buildVariantBucket,
  disposeAllBuckets,
  ensureBucketCapacity,
  fillBucket,
  hideSubParts,
} from "./instance-bucket.ts";

export interface TowersManager {
  /** Reconcile tower meshes with the current overlay. Cheap no-op when
   *  the overlay's tower set hasn't changed since the last update. */
  update(ctx: FrameCtx): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

interface TowerBucket {
  subParts: BucketSubPart[];
  capacity: number;
}

/** Tower-scene authors each turret in a ±1 frustum (2 world units wide)
 *  covering a 2-tile span. We want 2 cells = 2 game tiles, so we scale
 *  by TILE_SIZE — each authored 1 world unit becomes TILE_SIZE pixels. */
const TOWER_SCALE = TILE_SIZE;
/** Tower footprint in tiles. Towers are 2×2 — anchor is the top-left
 *  tile, center sits one full tile inward on both axes. */
const TOWER_CENTER_OFFSET = TILE_SIZE;
/** Initial bucket capacity. Most player slots own 1-3 towers; pow-2
 *  growth handles outliers. */
const INITIAL_CAPACITY = 4;

export function createTowersManager(scene: THREE.Scene): TowersManager {
  const root = new THREE.Group();
  root.name = "towers";
  scene.add(root);

  // One bucket per (variantName, ownerId) pair. Allocated lazily on
  // first occurrence; the bucket map persists across signature changes
  // so an owner who re-enters the field doesn't pay a fresh build.
  const buckets = new Map<string, TowerBucket>();
  const ownedMaterials: THREE.Material[] = [];
  let lastSignature: string | undefined;

  const hostMatrix = new THREE.Matrix4();
  const instanceMatrix = new THREE.Matrix4();
  const hostTranslation = new THREE.Vector3();
  const hostScale = new THREE.Vector3(TOWER_SCALE, TOWER_SCALE, TOWER_SCALE);
  const identityQuat = new THREE.Quaternion();

  function ensureBucket(
    bucketKey: string,
    variantName: string,
    ownerId: ValidPlayerSlot | undefined,
    required: number,
  ): TowerBucket | undefined {
    return ensureBucketCapacity(
      buckets,
      bucketKey,
      required,
      INITIAL_CAPACITY,
      (capacity) =>
        buildBucket(variantName, ownerId, capacity, root, ownedMaterials),
    );
  }

  function update(ctx: FrameCtx): void {
    const towers = ctx.map?.towers;
    const overlay = ctx.overlay;
    if (!towers || towers.length === 0) {
      if (lastSignature !== "") {
        for (const bucket of buckets.values()) hideSubParts(bucket.subParts);
        lastSignature = "";
      }
      return;
    }
    const ownedTowers = overlay?.entities?.ownedTowers;
    const homeTowerIndices = overlay?.entities?.homeTowerIndices;
    const aliveMask = overlay?.entities?.towerAlive;

    // Pre-bucket live towers by (variantName, ownerId).
    const byBucket = new Map<string, Tower[]>();
    const sigParts: string[] = [];
    for (let i = 0; i < towers.length; i++) {
      const alive = aliveMask ? aliveMask[i] !== false : true;
      if (!alive) continue;
      const tower = towers[i]!;
      const ownerIdRaw = ownedTowers?.get(i);
      const ownerId =
        ownerIdRaw !== undefined ? (ownerIdRaw as ValidPlayerSlot) : undefined;
      const isHome = homeTowerIndices?.has(i) ?? false;
      const variantName = isHome ? "home_tower" : "secondary_tower";
      const bucketKey = `${variantName}:${ownerId ?? "-"}`;
      let list = byBucket.get(bucketKey);
      if (!list) {
        list = [];
        byBucket.set(bucketKey, list);
      }
      list.push(tower);
      sigParts.push(`${i}:${variantName}:${ownerId ?? "-"}`);
    }
    const signature = sigParts.join(",");
    if (signature === lastSignature) return;
    lastSignature = signature;

    // Hide buckets with no live towers this frame.
    for (const [bucketKey, bucket] of buckets) {
      if (!byBucket.has(bucketKey)) hideSubParts(bucket.subParts);
    }

    for (const [bucketKey, list] of byBucket) {
      const colonIdx = bucketKey.indexOf(":");
      const variantName = bucketKey.slice(0, colonIdx);
      const ownerToken = bucketKey.slice(colonIdx + 1);
      const ownerId =
        ownerToken === "-"
          ? undefined
          : (Number(ownerToken) as ValidPlayerSlot);

      const bucket = ensureBucket(bucketKey, variantName, ownerId, list.length);
      if (!bucket) continue;

      fillBucket(bucket, list, hostMatrix, instanceMatrix, (tower, matrix) => {
        hostTranslation.set(
          tower.col * TILE_SIZE + TOWER_CENTER_OFFSET,
          0,
          tower.row * TILE_SIZE + TOWER_CENTER_OFFSET,
        );
        matrix.compose(hostTranslation, identityQuat, hostScale);
      });
    }
  }

  function dispose(): void {
    disposeAllBuckets(buckets, ownedMaterials);
    scene.remove(root);
  }

  return { update, dispose };
}

/** Build one bucket for the given (variantName, ownerId) pair. Tinting
 *  is baked into the scratch group (via `tintNamedMeshes`) before
 *  extraction, so the resulting `InstancedMesh`es already carry the
 *  player-tinted materials — no per-instance color writes needed. */
function buildBucket(
  variantName: string,
  ownerId: ValidPlayerSlot | undefined,
  capacity: number,
  root: THREE.Group,
  ownedMaterials: THREE.Material[],
): TowerBucket | undefined {
  const variant = getTowerVariant(variantName);
  if (!variant) return undefined;
  const subParts = buildVariantBucket({
    capacity,
    root,
    ownedMaterials,
    scratchBuilder: (scratch) => {
      buildTower(THREE, scratch, variant.params);
      if (ownerId !== undefined) {
        // Same name+colorVariant pairs as the pre-refactor inline code.
        // Materials cloned by tintNamedMeshes are pushed onto the shared
        // ownedMaterials list, so dispose() reaches them.
        tintNamedMeshes(scratch, "flag", ownerId, ownedMaterials);
        tintNamedMeshes(scratch, "body", ownerId, ownedMaterials, "wall");
        tintNamedMeshes(scratch, "parapet", ownerId, ownedMaterials, "wall");
        tintNamedMeshes(scratch, "pole_base", ownerId, ownedMaterials, "wall");
      }
    },
    namePrefix: `tower-${variantName}-${ownerId ?? "x"}`,
  });
  return { subParts, capacity };
}
