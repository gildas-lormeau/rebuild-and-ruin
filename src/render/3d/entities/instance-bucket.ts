/**
 * Shared plumbing for the "extract-and-instance" bucket pattern used by
 * every entity manager (walls / cannons / debris / grunts). Each manager
 * builds one `InstancedMesh` per authored sub-part of a variant, bucketed
 * by a key (mask / variant name / cannon mode), and reconciles per-frame
 * against a fresh entity list.
 *
 * Exported surface:
 *   • `buildVariantBucket` — run a scratch builder, extract its sub-parts,
 *     optionally transform each, and wrap every one as an `InstancedMesh`
 *     under `root`. Replaces the identical per-manager buildBucket bodies.
 *   • `ensureBucketCapacity` — grow-or-create helper around a bucket map.
 *   • `fillBucket` — per-frame host-matrix composition + count commit.
 *   • `hideSubParts` — zero the live count of a bucket's sub-parts.
 *   • `disposeAllBuckets` — teardown path used by every manager's `dispose`.
 *
 * Anything variant-specific (rotation, scale, ordering tweaks like the
 * rampart shield plane) stays in the per-manager call site — only the
 * shape-agnostic pieces live here.
 */

import * as THREE from "three";
import {
  type ExtractedSubPart,
  extractSubParts,
  subPartHasTag,
} from "./entity-helpers.ts";

export interface BucketSubPart {
  readonly instanced: THREE.InstancedMesh;
  readonly localMatrix: THREE.Matrix4;
  /** Behavior tags propagated from the extracted source part so managers
   *  can make visibility / render-order decisions without a userData
   *  round-trip or a `.name` string match. */
  readonly tags: readonly string[];
}

interface CapacityBucket {
  subParts: BucketSubPart[];
  capacity: number;
}

/** Zero the live count of every sub-part so stale matrices don't render. */
export function hideSubParts(subParts: readonly BucketSubPart[]): void {
  for (const part of subParts) part.instanced.count = 0;
}

/** Look up a bucket and ensure it has room for `required` instances. If
 *  the bucket is missing or undersized, `build(next)` is called with a
 *  power-of-two capacity and the result replaces any previous bucket
 *  (which is disposed). `build` may return `undefined` to signal the
 *  variant/key is unknown — in which case we return `undefined` without
 *  storing anything. */
export function ensureBucketCapacity<Key, Bucket extends CapacityBucket>(
  buckets: Map<Key, Bucket>,
  key: Key,
  required: number,
  initialCapacity: number,
  build: (capacity: number) => Bucket | undefined,
): Bucket | undefined {
  const existing = buckets.get(key);
  if (
    existing &&
    required <= existing.capacity &&
    existing.subParts.length > 0
  ) {
    return existing;
  }
  // Capacity must always satisfy `required` — power-of-two for clean
  // grow steps, with `initialCapacity` as the floor so very small first
  // allocations don't churn through 1→2→4→8 grows. New and grow paths
  // share this so the first allocation can't end up under-sized.
  const next = Math.max(initialCapacity, nextPowerOfTwo(required));
  if (existing) disposeSubParts(existing.subParts);
  const built = build(next);
  if (!built) return undefined;
  buckets.set(key, built);
  return built;
}

/** Tear down every bucket, then dispose and empty `ownedMaterials`. */
export function disposeAllBuckets<Bucket extends CapacityBucket>(
  buckets: Map<unknown, Bucket>,
  ownedMaterials: THREE.Material[],
): void {
  for (const bucket of buckets.values()) disposeSubParts(bucket.subParts);
  buckets.clear();
  for (const mat of ownedMaterials) mat.dispose();
  ownedMaterials.length = 0;
}

/** Build a set of `BucketSubPart`s by running a variant-specific scene
 *  builder into a scratch group, extracting every sub-mesh, optionally
 *  applying a per-part transform (e.g. debris' per-owner flag tint), and
 *  wrapping each as an `InstancedMesh` under `root`. Factors out the
 *  common "scratch → extract → (transform) → wrap" pipeline shared by
 *  walls, cannons, and debris. Callers wrap the returned array in their
 *  own bucket object shape (VariantBucket / MaskBucket / etc.). */
export function buildVariantBucket(opts: {
  readonly capacity: number;
  readonly root: THREE.Group;
  readonly ownedMaterials: THREE.Material[];
  readonly scratchBuilder: (scratch: THREE.Group) => void;
  readonly namePrefix: string;
  readonly transformPart?: (
    part: ExtractedSubPart,
    index: number,
  ) => ExtractedSubPart;
}): BucketSubPart[] {
  const scratch = new THREE.Group();
  opts.scratchBuilder(scratch);
  const extracted = extractSubParts(scratch);
  const subParts: BucketSubPart[] = [];
  for (let i = 0; i < extracted.length; i++) {
    const part = extracted[i]!;
    const transformed = opts.transformPart ? opts.transformPart(part, i) : part;
    const wrapped = wrapSubPartAsInstancedMesh(
      transformed,
      opts.capacity,
      opts.root,
      opts.ownedMaterials,
      opts.namePrefix,
    );
    // Generic authoring-driven render-order hint: any sub-part tagged
    // "render-behind" (e.g. the rampart shield aura plane) draws before
    // opaque peers so translucent materials sit underneath without
    // z-fight. Replaces per-variant index-based patches in the entity
    // managers.
    if (subPartHasTag(transformed, "render-behind")) {
      wrapped.instanced.renderOrder = -1;
    }
    subParts.push(wrapped);
  }
  return subParts;
}

/** Fill a bucket's instance slots by running `composeHost` for each
 *  entry, writing `hostMatrix * subPart.localMatrix` into every
 *  sub-part, then committing `count = entries.length`. `hostMatrix` and
 *  `scratch` are reusable Matrix4s owned by the caller so the hot loop
 *  allocates nothing.
 *
 *  `adjustLocal`, when provided, is called for every (entry, sub-part)
 *  pair. Returning a `Matrix4` replaces `subPart.localMatrix` for that
 *  pair — the caller owns the returned matrix (typically a scratch
 *  pre-mul) and may mutate it across calls. Returning `undefined` (or
 *  omitting the hook entirely) keeps the authored local matrix. Used
 *  by managers that need per-instance sub-part transforms — the cannon
 *  barrel pitch animation rotates barrel-tagged sub-parts around the
 *  breech pivot while leaving the base, cheeks, and decorations static. */
export function fillBucket<Entry>(
  bucket: { readonly subParts: readonly BucketSubPart[] },
  entries: readonly Entry[],
  hostMatrix: THREE.Matrix4,
  scratch: THREE.Matrix4,
  composeHost: (entry: Entry, hostMatrix: THREE.Matrix4) => void,
  adjustLocal?: (
    entry: Entry,
    subPart: BucketSubPart,
  ) => THREE.Matrix4 | undefined,
): void {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    composeHost(entry, hostMatrix);
    for (const part of bucket.subParts) {
      const local = adjustLocal?.(entry, part) ?? part.localMatrix;
      scratch.multiplyMatrices(hostMatrix, local);
      part.instanced.setMatrixAt(i, scratch);
    }
  }
  for (const part of bucket.subParts) {
    part.instanced.count = entries.length;
    part.instanced.instanceMatrix.needsUpdate = true;
  }
}

/** Smallest power of two >= value. Grows InstancedMesh capacity so
 *  buckets don't thrash when an entity set gains a few members. */
export function nextPowerOfTwo(value: number): number {
  let power = 1;
  while (power < value) power <<= 1;
  return power;
}

/** Build one `InstancedMesh` around an extracted sub-part, attach it to
 *  `root`, and register its materials for later disposal. Returns the
 *  wrapped sub-part so callers can assemble a bucket. Private — only
 *  `buildVariantBucket` needs it now that every manager goes through
 *  the generic pipeline. */
function wrapSubPartAsInstancedMesh(
  part: ExtractedSubPart,
  capacity: number,
  root: THREE.Group,
  ownedMaterials: THREE.Material[],
  fallbackName: string,
): BucketSubPart {
  const instanced = new THREE.InstancedMesh(
    part.geometry,
    part.material,
    capacity,
  );
  instanced.count = 0;
  instanced.frustumCulled = false;
  instanced.name = part.name || fallbackName;
  root.add(instanced);
  if (Array.isArray(part.material)) {
    for (const mat of part.material) ownedMaterials.push(mat);
  } else {
    ownedMaterials.push(part.material);
  }
  return { instanced, localMatrix: part.localMatrix, tags: part.tags };
}

/** Detach and dispose every `InstancedMesh` in `subParts`. The mutable
 *  array is emptied so callers can reset their bucket in place. */
function disposeSubParts(subParts: BucketSubPart[]): void {
  for (const part of subParts) {
    const parent = part.instanced.parent;
    if (parent) parent.remove(part.instanced);
    part.instanced.geometry.dispose();
    part.instanced.dispose();
  }
  subParts.length = 0;
}
