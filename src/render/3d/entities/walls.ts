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
import type { RenderOverlay } from "../../../shared/ui/overlay-types.ts";
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
/** Pack (mask, damaged, held) into a single 6-bit key — 4 bits for the
 *  mask (0-15), one bit for the reinforced-wall absorbed-hit state, and
 *  one bit separating live walls from held (sinking) ones. Used as the
 *  bucket map key so damaged walls get their own geometry (the scene
 *  builder needs to know up front whether to remove a merlon), AND so
 *  held buckets can opt out of depth-write without affecting live ones. */
const DAMAGED_BIT = 1 << 4;
const HELD_BIT = 1 << 5;
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
    const held = (bucketKey & HELD_BIT) !== 0;
    const built = ensureBucketCapacity(
      buckets,
      bucketKey,
      required,
      INITIAL_CAPACITY,
      (capacity) =>
        buildBucket(mask, damaged, held, capacity, root, ownedMaterials),
    );
    // walls always build (no variant lookup can fail), so the narrower
    // return type here is always defined.
    return built!;
  }

  function update(ctx: FrameCtx): void {
    const { overlay } = ctx;
    const sapper = collectSapperState(overlay);
    const { liveKeys, damagedKeys } = collectLiveWallKeys(overlay);
    const { heldKeys, heldDamagedKeys, heldByKey } = collectHeldWallEntries(
      overlay?.battle?.destroyedWalls,
    );

    liveKeys.sort((a, b) => a - b);
    heldKeys.sort((a, b) => a - b);
    const structuralSignature = makeStructuralSignature(
      liveKeys,
      damagedKeys,
      heldKeys,
      heldDamagedKeys,
    );
    const structuralChanged = structuralSignature !== lastStructuralSignature;
    const sapperTargetedChanged = sapper.targetedSig !== lastSapperTargetedSig;
    const sapperIntensityChanged = sapper.intensity !== lastSapperIntensity;
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
    lastSapperIntensity = sapper.intensity;
    lastSapperTargetedSig = sapper.targetedSig;

    if (structuralChanged || sapperTargetedChanged) {
      lastStructuralSignature = structuralSignature;

      if (liveKeys.length === 0 && heldKeys.length === 0) {
        for (const bucket of buckets.values()) hideSubParts(bucket.subParts);
        lastByBucket.clear();
        return;
      }

      const byBucket = rebuildBuckets(
        liveKeys,
        damagedKeys,
        heldKeys,
        heldDamagedKeys,
        heldByKey,
        sapper.targeted,
        sapper.intensity,
      );

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
      refreshAnimAttrs(
        lastByBucket,
        heldByKey,
        sapper.targeted,
        sapper.intensity,
      );
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

/** Sapper threat-pulse state derived from the current overlay. Targeted
 *  signature is the sorted-comma-joined key list so per-frame parity can
 *  short-circuit when nothing changes. */
function collectSapperState(overlay: RenderOverlay | undefined): {
  intensity: number;
  targeted: ReadonlySet<number>;
  targetedSig: string;
} {
  const intensity = overlay?.battle?.sapperRevealIntensity ?? 0;
  const rawTargeted = overlay?.battle?.sapperTargetedWalls;
  const targeted: ReadonlySet<number> =
    rawTargeted && intensity > 0 ? new Set(rawTargeted) : EMPTY_KEY_SET;
  const targetedSig =
    targeted.size === 0 ? "" : [...targeted].sort((a, b) => a - b).join(",");
  return { intensity, targeted, targetedSig };
}

/** Live wall tiles + per-castle damaged subsets, flattened across every
 *  castle in the overlay. */
function collectLiveWallKeys(overlay: RenderOverlay | undefined): {
  liveKeys: TileKey[];
  damagedKeys: Set<TileKey>;
} {
  const liveKeys: TileKey[] = [];
  const damagedKeys = new Set<TileKey>();
  if (!overlay?.castles) return { liveKeys, damagedKeys };
  for (const castle of overlay.castles) {
    for (const key of castle.walls) liveKeys.push(key as TileKey);
    if (castle.damagedWalls) {
      for (const key of castle.damagedWalls) damagedKeys.add(key as TileKey);
    }
  }
  return { liveKeys, damagedKeys };
}

/** Held wall entries: `impact`-cause destructions whose per-tile age drives
 *  the sink + tail-fade visual. Mask computation uses liveSet for "live
 *  neighbours" (merlons appear on the destroyed side at anim start) and
 *  the union for held walls themselves (consistent appearance during
 *  the sink, no pop at start or end). */
function collectHeldWallEntries(
  destroyedWalls:
    | ReadonlyArray<{
        row: number;
        col: number;
        age: number;
        damaged: boolean;
      }>
    | undefined,
): {
  heldKeys: TileKey[];
  heldDamagedKeys: Set<TileKey>;
  heldByKey: Map<number, { sinkY: number; opacity: number; damaged: boolean }>;
} {
  const heldKeys: TileKey[] = [];
  const heldDamagedKeys = new Set<TileKey>();
  const heldByKey = new Map<
    number,
    { sinkY: number; opacity: number; damaged: boolean }
  >();
  if (!destroyedWalls) return { heldKeys, heldDamagedKeys, heldByKey };
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
  return { heldKeys, heldDamagedKeys, heldByKey };
}

/** Combined fingerprint of every structural input (live + damaged + held +
 *  held-damaged). Used to short-circuit the rebuild path when nothing
 *  structurally changed between frames. */
function makeStructuralSignature(
  liveKeys: readonly TileKey[],
  damagedKeys: ReadonlySet<TileKey>,
  heldKeys: readonly TileKey[],
  heldDamagedKeys: ReadonlySet<TileKey>,
): string {
  const damagedList = [...damagedKeys].sort((a, b) => a - b);
  const heldDamagedList = [...heldDamagedKeys].sort((a, b) => a - b);
  return `${liveKeys.join(",")}|${damagedList.join(",")}|${heldKeys.join(",")}|${heldDamagedList.join(",")}`;
}

/** Bucket every live + held wall tile by (mask | damaged-bit | held-bit).
 *  Per-source config bundles the held/non-held differences up-front so
 *  the inner loop reads keys/mask-set/bit/data-lookup without re-branching
 *  on `held` each iteration. */
function rebuildBuckets(
  liveKeys: readonly TileKey[],
  damagedKeys: ReadonlySet<TileKey>,
  heldKeys: readonly TileKey[],
  heldDamagedKeys: ReadonlySet<TileKey>,
  heldByKey: ReadonlyMap<
    number,
    { sinkY: number; opacity: number; damaged: boolean }
  >,
  sapperTargeted: ReadonlySet<number>,
  sapperIntensity: number,
): Map<number, WallEntry[]> {
  const liveSet = new Set<TileKey>(liveKeys);
  const unionSet = new Set<TileKey>(liveKeys);
  for (const key of heldKeys) unionSet.add(key);

  const byBucket = new Map<number, WallEntry[]>();
  const sources: ReadonlyArray<{
    readonly keys: readonly TileKey[];
    readonly damagedSet: ReadonlySet<TileKey>;
    readonly held: boolean;
    readonly maskSet: ReadonlySet<TileKey>;
    readonly heldBit: number;
    readonly heldData: (
      key: TileKey,
    ) => { sinkY: number; opacity: number; damaged: boolean } | undefined;
  }> = [
    {
      keys: liveKeys,
      damagedSet: damagedKeys,
      held: false,
      maskSet: liveSet,
      heldBit: 0,
      heldData: () => undefined,
    },
    {
      keys: heldKeys,
      damagedSet: heldDamagedKeys,
      held: true,
      maskSet: unionSet,
      heldBit: HELD_BIT,
      heldData: (key) => heldByKey.get(key),
    },
  ];
  for (const source of sources) {
    for (const key of source.keys) {
      const { row, col } = unpackTileKey(key);
      const mask = computeMask(source.maskSet, col, row);
      const bucketKey =
        mask | (source.damagedSet.has(key) ? DAMAGED_BIT : 0) | source.heldBit;
      let list = byBucket.get(bucketKey);
      if (!list) {
        list = [];
        byBucket.set(bucketKey, list);
      }
      const tint = sapperTargeted.has(key) ? sapperIntensity : 0;
      const heldData = source.heldData(key);
      list.push({
        col,
        row,
        tileKey: key,
        held: source.held,
        opacity: heldData?.opacity ?? 1,
        tint,
        sinkY: heldData?.sinkY ?? 0,
      });
    }
  }
  return byBucket;
}

/** Anim-only / sapper-intensity-only refresh: each held entry picks up a
 *  fresh per-tile multiplier from heldByKey; sapper-targeted entries pick
 *  up the new tint scalar. Structural buckets are unchanged — only the
 *  per-entry attributes get rewritten in place. */
function refreshAnimAttrs(
  lastByBucket: Map<number, WallEntry[]>,
  heldByKey: ReadonlyMap<
    number,
    { sinkY: number; opacity: number; damaged: boolean }
  >,
  sapperTargeted: ReadonlySet<number>,
  sapperIntensity: number,
): void {
  for (const list of lastByBucket.values()) {
    for (let i = 0; i < list.length; i++) {
      const entry = list[i]!;
      const heldData = entry.held ? heldByKey.get(entry.tileKey) : undefined;
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
  held: boolean,
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
    namePrefix: `wall-mask-${mask}${damaged ? "-dmg" : ""}${held ? "-held" : ""}`,
  });
  // Per-instance opacity (impact held-mesh tail-fade) + tint (sapper
  // threat pulse) + sinkY (impact held-mesh descent). All default to
  // no-op (opacity=1, tint=0, sinkY=0); the manager writes per slot
  // when a multiplier is in flight. Held buckets disable depth-write so
  // the fading wall doesn't leave a depth stamp that hides the debris
  // base-plate rendered behind it.
  const opacityAttrs: THREE.InstancedBufferAttribute[] = [];
  const tintAttrs: THREE.InstancedBufferAttribute[] = [];
  const sinkAttrs: THREE.InstancedBufferAttribute[] = [];
  for (const part of subParts) {
    const { opacity, tint, sinkY } = attachInstanceTintAndSink(
      part.instanced,
      capacity,
      SAPPER_TINT_HEX,
      held ? { depthWrite: false } : undefined,
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
