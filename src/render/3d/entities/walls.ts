/**
 * 3D wall meshes — Phase 3 of the 3D renderer migration, with Phase 8b
 * instancing on top.
 *
 * Walls live in `RenderOverlay.castles[].walls` (one `Set<packedTileKey>`
 * per player). The 2D renderer draws them inside `drawCastleWalls`. This
 * manager mirrors that placement using `THREE.InstancedMesh` — one bucket
 * per (mask, sub-part) pair — so ~80-120 walls × ~5 sub-parts each fold
 * down to ~16 masks × ~5 sub-parts = ≤80 draw calls worst-case, regardless
 * of wall count. Practically a battle visits only a handful of masks, so
 * the live bucket count is usually well below 20.
 *
 * Update cadence: the set of wall tiles only changes inside
 * `WALL_BUILD` (tiles added) and the battle wall-sweep phase (tiles
 * removed). To avoid per-frame rebuilds we hash the union of all
 * players' wall sets once per call; when the hash matches the last
 * build we skip the rebuild entirely.
 *
 * Instancing approach — "extract-and-instance" (same pattern as grunts.ts):
 *
 *   1. Lazily per unique mask value: run `buildWall` once with
 *      `uvOffset: [0, 0]` into a throwaway Group. The Group contains
 *      body + N merlons + corner merlons + per-merlon AO planes. Extract
 *      each Mesh as `{geometry, material, localMatrix}` via
 *      `extractSubParts`.
 *   2. For each sub-part of that mask, create an `InstancedMesh(geom,
 *      mat, capacity)` attached to the manager's root group.
 *   3. Per fingerprint change: bucket walls by mask, ensure capacity,
 *      compute each wall's host matrix (translate to tile centre ×
 *      uniform `TILE_SIZE / 2` scale) and write
 *      `hostMatrix * subPart.localMatrix` via `setMatrixAt`. Clamp
 *      `.count` to the live bucket size so unused slots don't render.
 *
 * UV-offset trade-off: the 2D renderer varies `uvOffset` per tile so the
 * brick/flagstone pattern flows continuously across adjacent walls. That
 * offset is baked into the `ExtrudeGeometry`'s UV attribute by
 * `stoneWallUVGenerator`, and into each merlon's `BoxGeometry.uv`
 * attribute by `applyBoxWallUV` — both at construction time. Piping a
 * per-instance UV offset through every wall material (standard lit
 * materials with procedural `map` textures) would require injecting an
 * `InstancedBufferAttribute` + `onBeforeCompile` shader patching for
 * each, which is a sizeable refactor. We instead share one
 * `uvOffset = [0, 0]` geometry per mask across all instances: texture
 * continuity ACROSS adjacent tiles is lost, but each tile still shows
 * the full brick/flagstone pattern within its own footprint. Given
 * walls are viewed from mid-distance and the 64 px texture tiles twice
 * per tile, the difference is subtle. Revisit if the seam becomes
 * visually obvious during playtesting.
 */

import * as THREE from "three";
import { GRID_COLS, TILE_SIZE } from "../../../shared/core/grid.ts";
import type { RenderOverlay } from "../../../shared/ui/overlay-types.ts";
import { buildWall } from "../sprites/wall-scene.ts";
import {
  type BucketSubPart,
  buildVariantBucket,
  disposeAllBuckets,
  ensureBucketCapacity,
  fillBucket,
  hideSubParts,
} from "./instance-bucket.ts";

export interface WallsManager {
  /** Reconcile wall meshes with the current overlay. Cheap no-op when
   *  the overlay's wall set hasn't changed since the last update. */
  update(overlay: RenderOverlay | undefined): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

interface MaskBucket {
  readonly mask: number;
  /** One InstancedMesh per sub-part of the authored wall cell. Shape is
   *  constant for the bucket's lifetime; capacity grows by replacement. */
  subParts: BucketSubPart[];
  capacity: number;
}

/** Wall-scene authors each cell in a ±1 frustum (2 world units wide).
 *  We want 1 cell = 1 game tile, so we scale by TILE_SIZE / 2. */
const WALL_SCALE = TILE_SIZE / 2;
/** Neighbour-mask bits — MUST match wall-scene.ts (N=1, E=2, S=4, W=8). */
const MASK_N = 1 << 0;
const MASK_E = 1 << 1;
const MASK_S = 1 << 2;
const MASK_W = 1 << 3;
/** Initial InstancedMesh capacity per mask bucket. Grows power-of-two
 *  as needed. A battle rarely puts >40 walls on any single mask value;
 *  16 covers the common case with headroom. */
const INITIAL_CAPACITY = 16;

export function createWallsManager(scene: THREE.Scene): WallsManager {
  const root = new THREE.Group();
  root.name = "walls";
  scene.add(root);

  // One bucket per distinct mask value (0-15). Allocated lazily on
  // first occurrence — a typical battle only touches ~6-10 distinct
  // masks, so we don't pay for unused buckets.
  const buckets = new Map<number, MaskBucket>();
  // All materials we own (cloned or owned from builder output) — freed
  // on dispose.
  const ownedMaterials: THREE.Material[] = [];
  let lastSignature: string | undefined;

  // Scratch objects reused inside `update`.
  const hostMatrix = new THREE.Matrix4();
  const instanceMatrix = new THREE.Matrix4();
  const hostTranslation = new THREE.Vector3();
  const hostScale = new THREE.Vector3(WALL_SCALE, WALL_SCALE, WALL_SCALE);
  const identityQuat = new THREE.Quaternion();

  function ensureBucket(mask: number, required: number): MaskBucket {
    // Grow or create: `ensureBucketCapacity` tears down any existing
    // InstancedMeshes (InstancedMesh.count is fixed at construction) and
    // rebuilds at the new capacity. We preserve the extracted geometry
    // via fresh `buildWall` calls — cheap compared to per-wall rebuilds.
    const built = ensureBucketCapacity(
      buckets,
      mask,
      required,
      INITIAL_CAPACITY,
      (capacity) => buildBucket(mask, capacity, root, ownedMaterials),
    );
    // walls always build (no variant lookup can fail), so the narrower
    // return type here is always defined.
    return built!;
  }

  function update(overlay: RenderOverlay | undefined): void {
    // Union all players' wall sets and compute a signature.
    const keys: number[] = [];
    if (overlay?.castles) {
      for (const castle of overlay.castles) {
        for (const key of castle.walls) keys.push(key);
      }
    }
    keys.sort((a, b) => a - b);
    const signature = keys.join(",");

    if (signature === lastSignature) return;
    lastSignature = signature;

    if (keys.length === 0) {
      // Hide all instances; keep buckets alive so common "walls come
      // and go" churn doesn't thrash GPU buffers.
      for (const bucket of buckets.values()) hideSubParts(bucket.subParts);
      return;
    }

    // Collapse to Set for O(1) neighbour lookup when computing masks.
    const wallSet = new Set<number>(keys);
    // Pre-bucket walls by their 4-cardinal mask so we know capacity
    // requirements up front.
    const byMask = new Map<number, Array<{ col: number; row: number }>>();
    for (const key of wallSet) {
      const row = Math.floor(key / GRID_COLS);
      const col = key - row * GRID_COLS;
      const mask = computeMask(wallSet, col, row);
      let list = byMask.get(mask);
      if (!list) {
        list = [];
        byMask.set(mask, list);
      }
      list.push({ col, row });
    }

    // Masks that have a bucket but no live tiles this frame — zero
    // their count so stale instances don't ghost-render.
    for (const [mask, bucket] of buckets) {
      if (!byMask.has(mask)) hideSubParts(bucket.subParts);
    }

    // Write matrices for each live mask.
    for (const [mask, list] of byMask) {
      const bucket = ensureBucket(mask, list.length);
      fillBucket(bucket, list, hostMatrix, instanceMatrix, (tile, matrix) => {
        hostTranslation.set(
          (tile.col + 0.5) * TILE_SIZE,
          0,
          (tile.row + 0.5) * TILE_SIZE,
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

/** Compute the 4-cardinal neighbour mask for a given tile inside the
 *  shared wall set. Zones are river-isolated so "any wall tile" is
 *  equivalent to "same-castle wall tile" for cardinal adjacency — see
 *  the notes in the pre-instancing version of this file. */
function computeMask(
  walls: ReadonlySet<number>,
  col: number,
  row: number,
): number {
  let mask = 0;
  if (walls.has((row - 1) * GRID_COLS + col)) mask |= MASK_N;
  if (walls.has((row + 1) * GRID_COLS + col)) mask |= MASK_S;
  if (walls.has(row * GRID_COLS + (col + 1))) mask |= MASK_E;
  if (walls.has(row * GRID_COLS + (col - 1))) mask |= MASK_W;
  return mask;
}

/** Build a bucket for one mask value: run `buildWall` once into a
 *  scratch group with `uvOffset=[0,0]`, extract every sub-mesh, and
 *  wrap each as an `InstancedMesh` under `root`. */
function buildBucket(
  mask: number,
  capacity: number,
  root: THREE.Group,
  ownedMaterials: THREE.Material[],
): MaskBucket {
  const subParts = buildVariantBucket({
    capacity,
    root,
    ownedMaterials,
    scratchBuilder: (scratch) => {
      buildWall(THREE, scratch, { mask, uvOffset: [0, 0] });
    },
    namePrefix: `wall-mask-${mask}`,
  });
  return { mask, subParts, capacity };
}
