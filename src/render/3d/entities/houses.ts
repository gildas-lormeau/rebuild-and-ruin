/**
 * 3D house meshes — Phase 3 of the 3D renderer migration, with
 * per-variant InstancedMesh on top.
 *
 * Houses live on `GameMap.houses[]` (stable list for the duration of a
 * match — houses can be destroyed in battle but are never added). Each
 * house is a single 1×1 tile civilian dwelling with no directional
 * orientation, no player color, and no variants.
 *
 * Instancing: same `extract-and-instance` pattern as walls/cannons —
 * one bucket per variant (today only "house"), one `InstancedMesh` per
 * authored sub-part, capacity grown power-of-two on demand. With ~5
 * houses per player × 4 players × ~6 sub-parts/house, this collapses
 * ~120 separate meshes (one Group per house, each with its own mesh
 * tree) down to ~6 InstancedMeshes — same draw-call count regardless
 * of how many houses are live.
 *
 * Update cadence: the set of living houses changes only when a house
 * is destroyed (wildfire, etc.). A signature over `(col, row)` of the
 * live houses skips the rebuild on steady-state frames.
 */

import * as THREE from "three";
import type { House } from "../../../shared/core/geometry-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import { buildHouse, getHouseVariant } from "../sprites/house-scene.ts";
import {
  type BucketSubPart,
  buildVariantBucket,
  disposeAllBuckets,
  ensureBucketCapacity,
  fillBucket,
  hideSubParts,
} from "./instance-bucket.ts";

export interface HousesManager {
  /** Reconcile house meshes with the current map. Cheap no-op when the
   *  living-house set hasn't changed since the last update. */
  update(ctx: FrameCtx): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

interface HouseBucket {
  subParts: BucketSubPart[];
  capacity: number;
}

/** House-scene authors each dwelling in a ±1 frustum (2 world units wide).
 *  We want 1 cell = 1 game tile, so we scale by TILE_SIZE / 2. */
const HOUSE_SCALE = TILE_SIZE / 2;
/** Initial bucket capacity. A typical battle has ~10-20 live houses;
 *  the bucket grows power-of-two if exceeded. */
const INITIAL_CAPACITY = 16;

export function createHousesManager(scene: THREE.Scene): HousesManager {
  const root = new THREE.Group();
  root.name = "houses";
  scene.add(root);

  // One bucket keyed by variant name (today only "house"). Allocated
  // lazily on first occurrence.
  const buckets = new Map<string, HouseBucket>();
  // Materials owned by the manager (extracted from buildHouse output);
  // freed on dispose via `disposeAllBuckets`.
  const ownedMaterials: THREE.Material[] = [];
  let lastSignature: string | undefined;

  // Scratch objects reused inside `update`.
  const hostMatrix = new THREE.Matrix4();
  const instanceMatrix = new THREE.Matrix4();
  const hostTranslation = new THREE.Vector3();
  const hostScale = new THREE.Vector3(HOUSE_SCALE, HOUSE_SCALE, HOUSE_SCALE);
  const identityQuat = new THREE.Quaternion();

  function ensureBucket(required: number): HouseBucket | undefined {
    return ensureBucketCapacity(
      buckets,
      "house",
      required,
      INITIAL_CAPACITY,
      (capacity) => {
        const variant = getHouseVariant("house");
        if (!variant) return undefined;
        const subParts = buildVariantBucket({
          capacity,
          root,
          ownedMaterials,
          scratchBuilder: (scratch) => {
            buildHouse(THREE, scratch, variant.params);
          },
          namePrefix: "house",
        });
        return { subParts, capacity };
      },
    );
  }

  function update(ctx: FrameCtx): void {
    const houses = ctx.map?.houses;
    if (!houses || houses.length === 0) {
      if (lastSignature !== "") {
        for (const bucket of buckets.values()) hideSubParts(bucket.subParts);
        lastSignature = "";
      }
      return;
    }

    // Filter to live houses, signature on (col, row) — alive flag flips
    // are the only mutation we care about.
    const live: House[] = [];
    const parts: string[] = [];
    for (const house of houses) {
      if (!house.alive) continue;
      live.push(house);
      parts.push(`${house.col}:${house.row}`);
    }
    parts.sort();
    const signature = parts.join(",");
    if (signature === lastSignature) return;
    lastSignature = signature;

    if (live.length === 0) {
      for (const bucket of buckets.values()) hideSubParts(bucket.subParts);
      return;
    }

    const bucket = ensureBucket(live.length);
    if (!bucket) return;

    fillBucket(bucket, live, hostMatrix, instanceMatrix, (house, matrix) => {
      hostTranslation.set(
        (house.col + 0.5) * TILE_SIZE,
        0,
        (house.row + 0.5) * TILE_SIZE,
      );
      matrix.compose(hostTranslation, identityQuat, hostScale);
    });
  }

  function dispose(): void {
    disposeAllBuckets(buckets, ownedMaterials);
    scene.remove(root);
  }

  return { update, dispose };
}
