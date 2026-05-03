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
import type { FrameCtx } from "../frame-ctx.ts";
import { buildWall } from "../sprites/wall-scene.ts";
import { unpackTileKey } from "./entity-helpers.ts";
import {
  type BucketSubPart,
  buildVariantBucket,
  disposeAllBuckets,
  ensureBucketCapacity,
  fillBucket,
  hideSubParts,
  writeBucketAttribute,
} from "./instance-bucket.ts";
import { attachInstanceTint } from "./instance-modulation.ts";

export interface WallsManager {
  /** Reconcile wall meshes with the current overlay. Cheap no-op when
   *  the overlay's wall set hasn't changed since the last update. */
  update(ctx: FrameCtx): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

interface MaskBucket {
  readonly mask: number;
  readonly damaged: boolean;
  /** One InstancedMesh per sub-part of the authored wall cell. Shape is
   *  constant for the bucket's lifetime; capacity grows by replacement. */
  subParts: BucketSubPart[];
  /** Per-sub-part instance-opacity attribute (parallel to `subParts`). */
  opacityAttrs: THREE.InstancedBufferAttribute[];
  /** Per-sub-part instance-tint attribute (parallel to `subParts`).
   *  Mix factor in [0, 1] toward the bucket's `instanceTintColor`
   *  uniform (copper for sapper-targeted walls). */
  tintAttrs: THREE.InstancedBufferAttribute[];
  capacity: number;
}

interface WallEntry {
  readonly col: number;
  readonly row: number;
  readonly tileKey: number;
  /** Per-instance alpha multiplier in [0, 1]. Live walls = 1; held
   *  crumbling-walls entries = the runtime-derived fade multiplier. */
  readonly opacity: number;
  /** Per-instance tint mix in [0, 1]. 0 for non-targeted walls;
   *  sapper-targeted walls = the runtime-derived pulse intensity. */
  readonly tint: number;
}

/** Copper-brown tint for sapper-targeted walls — matches the
 *  `sapper` palette pulseColor used by the reveal banner chrome. */
const SAPPER_TINT_HEX = 0xa07050;
const EMPTY_KEY_SET: ReadonlySet<number> = new Set();
/** Pack (mask, damaged) into a single 5-bit key — 4 bits for the mask
 *  (0-15) plus one bit for the reinforced-wall absorbed-hit state. Used
 *  as the bucket map key so damaged walls get their own geometry (the
 *  scene builder needs to know up front whether to remove a merlon). */
const DAMAGED_BIT = 1 << 4;
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
  // Two-tier cache: structural signature gates the expensive bucket
  // rebuild + matrix recompose; fade is tracked separately so the 1.1s
  // crumbling-walls ramp only triggers a per-slot opacity rewrite per
  // frame (skipping mask compute, ensureBucket, fillBucket).
  // `lastByBucket` retains the per-bucket entry lists from the most
  // recent structural rebuild — opacity-only frames walk these.
  let lastStructuralSignature: string | undefined;
  let lastFade = 1;
  let lastSapperIntensity = 0;
  let lastSapperTargetedSig = "";
  let lastByBucket: Map<number, WallEntry[]> = new Map();

  // Scratch objects reused inside `update`.
  const hostMatrix = new THREE.Matrix4();
  const instanceMatrix = new THREE.Matrix4();
  const hostTranslation = new THREE.Vector3();
  const hostScale = new THREE.Vector3(WALL_SCALE, WALL_SCALE, WALL_SCALE);
  const identityQuat = new THREE.Quaternion();

  function ensureBucket(bucketKey: number, required: number): MaskBucket {
    // Grow or create: `ensureBucketCapacity` tears down any existing
    // InstancedMeshes (InstancedMesh.count is fixed at construction) and
    // rebuilds at the new capacity. We preserve the extracted geometry
    // via fresh `buildWall` calls — cheap compared to per-wall rebuilds.
    const mask = bucketKey & 0x0f;
    const damaged = (bucketKey & DAMAGED_BIT) !== 0;
    const built = ensureBucketCapacity(
      buckets,
      bucketKey,
      required,
      INITIAL_CAPACITY,
      (capacity) => buildBucket(mask, damaged, capacity, root, ownedMaterials),
    );
    // walls always build (no variant lookup can fail), so the narrower
    // return type here is always defined.
    return built!;
  }

  function update(ctx: FrameCtx): void {
    const { overlay } = ctx;
    // Held walls union into the mask-compute set ONLY while the fade
    // is active, so live neighbours keep their merlons during the
    // fade. Post-fade the debris manager carries the rubble.
    const heldWalls = overlay?.battle?.heldDestroyedWalls;
    const crumblingFade = overlay?.battle?.crumblingWallsFade;
    const renderHeldWalls = heldWalls && crumblingFade !== undefined;
    const fade = crumblingFade ?? 1;
    const sapperIntensity = overlay?.battle?.sapperRevealIntensity ?? 0;
    const sapperTargetedRaw = overlay?.battle?.sapperTargetedWalls;
    const sapperTargeted: ReadonlySet<number> =
      sapperTargetedRaw && sapperIntensity > 0
        ? new Set(sapperTargetedRaw)
        : EMPTY_KEY_SET;
    const sapperTargetedSig =
      sapperTargeted.size === 0
        ? ""
        : [...sapperTargeted].sort((a, b) => a - b).join(",");

    const liveKeys: number[] = [];
    const damagedKeys = new Set<number>();
    if (overlay?.castles) {
      for (const castle of overlay.castles) {
        for (const key of castle.walls) liveKeys.push(key);
        if (castle.damagedWalls) {
          for (const key of castle.damagedWalls) damagedKeys.add(key);
        }
      }
    }
    const heldKeys: number[] = [];
    const heldDamagedKeys = new Set<number>();
    if (renderHeldWalls) {
      for (const held of heldWalls) {
        heldKeys.push(held.tileKey);
        if (held.damaged) heldDamagedKeys.add(held.tileKey);
      }
    }

    liveKeys.sort((a, b) => a - b);
    heldKeys.sort((a, b) => a - b);
    const damagedList = [...damagedKeys].sort((a, b) => a - b);
    const heldDamagedList = [...heldDamagedKeys].sort((a, b) => a - b);
    const structuralSignature = `${liveKeys.join(",")}|${damagedList.join(",")}|${heldKeys.join(",")}|${heldDamagedList.join(",")}`;
    const structuralChanged = structuralSignature !== lastStructuralSignature;
    const fadeChanged = fade !== lastFade;
    const sapperTargetedChanged = sapperTargetedSig !== lastSapperTargetedSig;
    const sapperIntensityChanged = sapperIntensity !== lastSapperIntensity;
    if (
      !structuralChanged &&
      !fadeChanged &&
      !sapperTargetedChanged &&
      !sapperIntensityChanged
    )
      return;
    lastFade = fade;
    lastSapperIntensity = sapperIntensity;
    lastSapperTargetedSig = sapperTargetedSig;

    if (structuralChanged || sapperTargetedChanged) {
      lastStructuralSignature = structuralSignature;

      if (liveKeys.length === 0 && heldKeys.length === 0) {
        for (const bucket of buckets.values()) hideSubParts(bucket.subParts);
        lastByBucket.clear();
        return;
      }

      const wallSet = new Set<number>(liveKeys);
      for (const key of heldKeys) wallSet.add(key);

      const byBucket = new Map<number, WallEntry[]>();
      const sources: ReadonlyArray<{
        readonly keys: readonly number[];
        readonly damagedSet: ReadonlySet<number>;
        readonly opacity: number;
      }> = [
        { keys: liveKeys, damagedSet: damagedKeys, opacity: 1 },
        { keys: heldKeys, damagedSet: heldDamagedKeys, opacity: fade },
      ];
      for (const source of sources) {
        for (const key of source.keys) {
          const { row, col } = unpackTileKey(key);
          const mask = computeMask(wallSet, col, row);
          const bucketKey =
            mask | (source.damagedSet.has(key) ? DAMAGED_BIT : 0);
          let list = byBucket.get(bucketKey);
          if (!list) {
            list = [];
            byBucket.set(bucketKey, list);
          }
          const tint = sapperTargeted.has(key) ? sapperIntensity : 0;
          list.push({
            col,
            row,
            tileKey: key,
            opacity: source.opacity,
            tint,
          });
        }
      }

      for (const [bucketKey, bucket] of buckets) {
        if (!byBucket.has(bucketKey)) hideSubParts(bucket.subParts);
      }

      for (const [bucketKey, list] of byBucket) {
        const bucket = ensureBucket(bucketKey, list.length);
        fillBucket(bucket, list, hostMatrix, instanceMatrix, (tile, matrix) => {
          hostTranslation.set(
            (tile.col + 0.5) * TILE_SIZE,
            0,
            (tile.row + 0.5) * TILE_SIZE,
          );
          matrix.compose(hostTranslation, identityQuat, hostScale);
        });
      }
      lastByBucket = byBucket;
    } else {
      // Fade-only / sapper-intensity-only change: refresh per-entry
      // opacity + tint in place; structural buckets unchanged.
      for (const list of lastByBucket.values()) {
        for (let i = 0; i < list.length; i++) {
          const entry = list[i]!;
          const opacity = entry.opacity !== 1 ? fade : 1;
          const tint = sapperTargeted.has(entry.tileKey) ? sapperIntensity : 0;
          if (opacity !== entry.opacity || tint !== entry.tint) {
            list[i] = { ...entry, opacity, tint };
          }
        }
      }
    }

    writeBucketAttribute(
      buckets,
      lastByBucket,
      (bucket) => bucket.opacityAttrs,
      (entry) => entry.opacity,
    );
    writeBucketAttribute(
      buckets,
      lastByBucket,
      (bucket) => bucket.tintAttrs,
      (entry) => entry.tint,
    );
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

/** Build a bucket for one (mask, damaged) pair: run `buildWall` once into
 *  a scratch group with `uvOffset=[0,0]`, extract every sub-mesh, and
 *  wrap each as an `InstancedMesh` under `root`. Damaged buckets request
 *  the merlon-removed + rubble variant of the same mask. */
function buildBucket(
  mask: number,
  damaged: boolean,
  capacity: number,
  root: THREE.Group,
  ownedMaterials: THREE.Material[],
): MaskBucket {
  const subParts = buildVariantBucket({
    capacity,
    root,
    ownedMaterials,
    scratchBuilder: (scratch) => {
      buildWall(THREE, scratch, { mask, uvOffset: [0, 0], damaged });
    },
    namePrefix: `wall-mask-${mask}${damaged ? "-dmg" : ""}`,
  });
  // Per-instance opacity (crumbling-walls fade) + tint (sapper threat
  // pulse). Both default to no-op (opacity=1, tint=0); the manager
  // writes per slot when a multiplier is in flight.
  const opacityAttrs: THREE.InstancedBufferAttribute[] = [];
  const tintAttrs: THREE.InstancedBufferAttribute[] = [];
  for (const part of subParts) {
    const { opacity, tint } = attachInstanceTint(
      part.instanced,
      capacity,
      SAPPER_TINT_HEX,
    );
    opacityAttrs.push(opacity);
    tintAttrs.push(tint);
  }
  return { mask, damaged, subParts, opacityAttrs, tintAttrs, capacity };
}
