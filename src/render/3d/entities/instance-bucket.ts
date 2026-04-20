/**
 * Shared plumbing for the "extract-and-instance" bucket pattern used by
 * every entity manager (walls / cannons / debris / grunts). Each manager
 * builds one `InstancedMesh` per authored sub-part of a variant, bucketed
 * by a key (mask / variant name / cannon mode), and reconciles per-frame
 * against a fresh entity list.
 *
 * Exported surface:
 *   • `wrapSubPartAsInstancedMesh` — build one `InstancedMesh` from an
 *     extracted sub-part with the common defaults (count=0, no frustum
 *     cull, fallback name, materials tracked for disposal).
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

export interface BucketSubPart {
  readonly instanced: THREE.InstancedMesh;
  readonly localMatrix: THREE.Matrix4;
}

interface CapacityBucket {
  subParts: BucketSubPart[];
  capacity: number;
}

/** Build one `InstancedMesh` around an extracted sub-part, attach it to
 *  `root`, and register its materials for later disposal. Returns the
 *  wrapped sub-part so callers can assemble a bucket. */
export function wrapSubPartAsInstancedMesh(
  part: {
    readonly geometry: THREE.BufferGeometry;
    readonly material: THREE.Material | THREE.Material[];
    readonly localMatrix: THREE.Matrix4;
    readonly name: string;
  },
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
  return { instanced, localMatrix: part.localMatrix };
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
  const next = Math.max(
    initialCapacity,
    existing ? nextPowerOfTwo(required) : initialCapacity,
  );
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

/** Fill a bucket's instance slots by running `composeHost` for each
 *  entry, writing `hostMatrix * subPart.localMatrix` into every
 *  sub-part, then committing `count = entries.length`. `hostMatrix` and
 *  `scratch` are reusable Matrix4s owned by the caller so the hot loop
 *  allocates nothing. */
export function fillBucket<Entry>(
  bucket: { readonly subParts: readonly BucketSubPart[] },
  entries: readonly Entry[],
  hostMatrix: THREE.Matrix4,
  scratch: THREE.Matrix4,
  composeHost: (entry: Entry, hostMatrix: THREE.Matrix4) => void,
): void {
  for (let i = 0; i < entries.length; i++) {
    composeHost(entries[i]!, hostMatrix);
    for (const part of bucket.subParts) {
      scratch.multiplyMatrices(hostMatrix, part.localMatrix);
      part.instanced.setMatrixAt(i, scratch);
    }
  }
  for (const part of bucket.subParts) {
    part.instanced.count = entries.length;
    part.instanced.instanceMatrix.needsUpdate = true;
  }
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

/** Smallest power of two >= value. Grows InstancedMesh capacity so
 *  buckets don't thrash when an entity set gains a few members. */
function nextPowerOfTwo(value: number): number {
  let power = 1;
  while (power < value) power <<= 1;
  return power;
}
