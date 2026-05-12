/**
 * 3D wall meshes — `RenderOverlay.castles[].walls` via the extract-and-
 * instance pattern, one `InstancedMesh` per (mask, sub-part). A union-set
 * hash skips rebuilds; the set only changes in WALL_BUILD and the battle
 * wall-sweep. One shared `uvOffset = [0,0]` per mask loses cross-tile
 * texture continuity but avoids `onBeforeCompile`-patching every wall
 * material.
 */

import * as THREE from "three";
import {
  GRID_COLS,
  TILE_SIZE,
  type TileKey,
} from "../../../shared/core/grid.ts";
import { wallDestroyAnimAt } from "../../../shared/core/wall-destroy-anim.ts";
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
import { attachInstanceTintAndSink } from "./instance-modulation.ts";

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
  /** Per-sub-part instance-sink attribute (parallel to `subParts`).
   *  Object-space Y offset subtracted from the vertex (multiply by
   *  `WALL_SCALE` for world-space sink amount). Drives the held-mesh
   *  sink for impact destructions without recomposing matrices. */
  sinkAttrs: THREE.InstancedBufferAttribute[];
  capacity: number;
}

interface WallEntry {
  readonly col: number;
  readonly row: number;
  readonly tileKey: TileKey;
  /** True for impact-destroyed walls held during the post-destruction
   *  animation; false for live walls. Drives the per-frame
   *  anim-attribute writes in the cheap path — only held entries get
   *  sink + tail-fade. */
  readonly held: boolean;
  /** Per-instance alpha multiplier in [0, 1]. Live walls = 1; held
   *  entries = `wallDestroyAnimAt(age).wallOpacity`. */
  readonly opacity: number;
  /** Per-instance tint mix in [0, 1]. 0 for non-targeted walls;
   *  sapper-targeted walls = the runtime-derived pulse intensity. */
  readonly tint: number;
  /** Per-instance object-space Y sink. 0 for live walls; held entries
   *  carry `wallDestroyAnimAt(age).sinkOffset / WALL_SCALE`. */
  readonly sinkY: number;
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
  // rebuild + matrix recompose; per-tile anim values for held entries
  // (sinkOffset + wallOpacity from `wallDestroyAnimAt(age)`) get
  // refreshed every frame any held entries exist (cheap per-attribute
  // rewrites — no mask compute, no ensureBucket, no fillBucket).
  // `lastByBucket` retains the per-bucket entry lists from the most
  // recent structural rebuild — anim-only frames walk these.
  let lastStructuralSignature: string | undefined;
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
    // Held walls = `impact`-cause (cannonball / grunt destructions),
    // multipliers from per-tile age via the shared `wallDestroyAnimAt`
    // helper. Drives the sink + tail-fade visual. Mask computation uses
    // two sets: live neighbours compute against `liveSet` only, so
    // merlons appear on the destroyed side AT animation start (no pop
    // when the held entry finally purges); held walls themselves
    // compute against the union, so their own appearance during the
    // sink stays consistent (no pop at the start either). Post-anim the
    // debris manager carries the rubble.
    const destroyedWalls = overlay?.battle?.destroyedWalls;
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

    const liveKeys: TileKey[] = [];
    const damagedKeys = new Set<TileKey>();
    if (overlay?.castles) {
      for (const castle of overlay.castles) {
        for (const key of castle.walls) liveKeys.push(key as TileKey);
        if (castle.damagedWalls) {
          for (const key of castle.damagedWalls)
            damagedKeys.add(key as TileKey);
        }
      }
    }

    // Held entries: per-tile multipliers (sinkY in object-space, divided
    // by WALL_SCALE so the shader's `transformed.y -= instanceSinkY`
    // produces a world-space sink in pre-scale units).
    const heldKeys: TileKey[] = [];
    const heldDamagedKeys = new Set<TileKey>();
    const heldByKey = new Map<
      number,
      { sinkY: number; opacity: number; damaged: boolean }
    >();
    if (destroyedWalls) {
      for (const wall of destroyedWalls) {
        const multipliers = wallDestroyAnimAt(wall.age * 1000);
        const tileKey = wall.row * GRID_COLS + wall.col;
        heldKeys.push(tileKey as TileKey);
        if (wall.damaged) heldDamagedKeys.add(tileKey as TileKey);
        heldByKey.set(tileKey, {
          sinkY: multipliers.sinkOffset / WALL_SCALE,
          opacity: multipliers.wallOpacity,
          damaged: wall.damaged,
        });
      }
    }

    liveKeys.sort((a, b) => a - b);
    heldKeys.sort((a, b) => a - b);
    const damagedList = [...damagedKeys].sort((a, b) => a - b);
    const heldDamagedList = [...heldDamagedKeys].sort((a, b) => a - b);
    const structuralSignature = `${liveKeys.join(",")}|${damagedList.join(",")}|${heldKeys.join(",")}|${heldDamagedList.join(",")}`;
    const structuralChanged = structuralSignature !== lastStructuralSignature;
    const sapperTargetedChanged = sapperTargetedSig !== lastSapperTargetedSig;
    const sapperIntensityChanged = sapperIntensity !== lastSapperIntensity;
    // Per-frame refresh runs whenever any held entries exist (their
    // multipliers advance every frame for impact-cause; for decay-cause
    // the global anim usually advances too while reveal is in flight).
    const hasHeld = heldByKey.size > 0;
    if (
      !structuralChanged &&
      !sapperTargetedChanged &&
      !sapperIntensityChanged &&
      !hasHeld
    )
      return;
    lastSapperIntensity = sapperIntensity;
    lastSapperTargetedSig = sapperTargetedSig;

    if (structuralChanged || sapperTargetedChanged) {
      lastStructuralSignature = structuralSignature;

      if (liveKeys.length === 0 && heldKeys.length === 0) {
        for (const bucket of buckets.values()) hideSubParts(bucket.subParts);
        lastByBucket.clear();
        return;
      }

      const liveSet = new Set<TileKey>(liveKeys);
      const unionSet = new Set<TileKey>(liveKeys);
      for (const key of heldKeys) unionSet.add(key);

      const byBucket = new Map<number, WallEntry[]>();
      const sources: ReadonlyArray<{
        readonly keys: readonly TileKey[];
        readonly damagedSet: ReadonlySet<TileKey>;
        readonly held: boolean;
      }> = [
        { keys: liveKeys, damagedSet: damagedKeys, held: false },
        { keys: heldKeys, damagedSet: heldDamagedKeys, held: true },
      ];
      for (const source of sources) {
        const maskSet = source.held ? unionSet : liveSet;
        for (const key of source.keys) {
          const { row, col } = unpackTileKey(key);
          const mask = computeMask(maskSet, col, row);
          const bucketKey =
            mask | (source.damagedSet.has(key) ? DAMAGED_BIT : 0);
          let list = byBucket.get(bucketKey);
          if (!list) {
            list = [];
            byBucket.set(bucketKey, list);
          }
          const tint = sapperTargeted.has(key) ? sapperIntensity : 0;
          const heldData = source.held ? heldByKey.get(key) : undefined;
          list.push({
            col,
            row,
            tileKey: key as TileKey,
            held: source.held,
            opacity: heldData?.opacity ?? 1,
            tint,
            sinkY: heldData?.sinkY ?? 0,
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
      // Anim-only / sapper-intensity-only change: refresh per-entry
      // opacity + tint + sinkY in place; structural buckets unchanged.
      // Held entries pick up their fresh multipliers from heldByKey.
      for (const list of lastByBucket.values()) {
        for (let i = 0; i < list.length; i++) {
          const entry = list[i]!;
          const heldData = entry.held
            ? heldByKey.get(entry.tileKey)
            : undefined;
          const opacity = heldData?.opacity ?? 1;
          const tint = sapperTargeted.has(entry.tileKey) ? sapperIntensity : 0;
          const entrySinkY = heldData?.sinkY ?? 0;
          if (
            opacity !== entry.opacity ||
            tint !== entry.tint ||
            entrySinkY !== entry.sinkY
          ) {
            list[i] = { ...entry, opacity, tint, sinkY: entrySinkY };
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
    writeBucketAttribute(
      buckets,
      lastByBucket,
      (bucket) => bucket.sinkAttrs,
      (entry) => entry.sinkY,
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
  // Per-instance opacity (impact held-mesh tail-fade) + tint (sapper
  // threat pulse) + sinkY (impact held-mesh descent). All default to
  // no-op (opacity=1, tint=0, sinkY=0); the manager writes per slot
  // when a multiplier is in flight.
  const opacityAttrs: THREE.InstancedBufferAttribute[] = [];
  const tintAttrs: THREE.InstancedBufferAttribute[] = [];
  const sinkAttrs: THREE.InstancedBufferAttribute[] = [];
  for (const part of subParts) {
    const { opacity, tint, sinkY } = attachInstanceTintAndSink(
      part.instanced,
      capacity,
      SAPPER_TINT_HEX,
    );
    opacityAttrs.push(opacity);
    tintAttrs.push(tint);
    sinkAttrs.push(sinkY);
  }
  return {
    mask,
    damaged,
    subParts,
    opacityAttrs,
    tintAttrs,
    sinkAttrs,
    capacity,
  };
}
