/**
 * 3D grunt meshes — Phase 4 (initial) + Phase 8 (perf).
 *
 * Grunts are 1×1 tile, ownerless neutral hazards that pace toward
 * player castles during battle. A single battle can field 30+ grunts,
 * so this manager uses `THREE.InstancedMesh` to draw all grunts with
 * one draw call per sub-part, rather than a fresh `THREE.Group` per
 * grunt.
 *
 * Variant strategy: grunts author four cardinal variants in
 * `grunt-scene.ts` whose geometry is IDENTICAL — only `yawDegrees`
 * differs. We use the canonical `grunt_n` pose (barrel pointing −Z)
 * with `yawDegrees: 0` and rotate each instance by `-grunt.facing` on
 * Y. This matches the continuous-rotation convention cannons use.
 *
 * Rotation: the game's `grunt.facing` is in radians with 0 = up/north
 * and positive = clockwise (atan2-style). three.js Y rotations are
 * CCW viewed from +Y, so each instance's Y rotation is `-facing`.
 *
 * Instancing approach — "extract-and-instance" (Option A):
 *
 *   1. On first construction, run `buildGrunt` once into a throwaway
 *      Group. That Group contains one mesh per sub-part (hull, two
 *      track boxes, eight track end-caps, two accents, AO disc,
 *      turret, barrel). The scene builder sets `group.rotation.y =
 *      yawDegrees` on the outer Group — we zero yaw in the extraction
 *      call, so `updateMatrixWorld` gives each mesh its intrinsic
 *      local-space transform inside the grunt's ±1 frustum.
 *   2. Walk the throwaway Group, and for every `THREE.Mesh`, record
 *      `{ geometry, material, localMatrix }` where `localMatrix` is
 *      the mesh's resolved world matrix within the throwaway Group.
 *   3. For each sub-part, create one `InstancedMesh(geom, mat,
 *      maxCount)` under the manager's root group.
 *   4. Per-frame reconcile: compute each grunt's host matrix
 *      (translate to tile centre × Y-rotate by `-facing` × uniform
 *      scale `TILE_SIZE / 2`) and, for sub-part `s`, instance `i`,
 *      write `hostMatrix[i] * subPartLocalMatrix[s]` via
 *      `setMatrixAt(i, …)`. `instanceMatrix.needsUpdate = true` at
 *      the end of the update.
 *   5. `count` is set to `grunts.length` each update so unused slots
 *      don't render. When `grunts.length` exceeds current capacity
 *      we tear down and rebuild at a larger capacity.
 *
 * This keeps `buildGrunt`'s API untouched (sprite preview pages that
 * import it still work) and extracts purely via three.js runtime
 * inspection. The same pattern should generalise to any other entity
 * whose sub-part geometry is reused across instances — walls and
 * debris are candidates once profiled.
 *
 * Fingerprint: we retain the `col:row:facing` composite signature to
 * skip per-frame matrix writes when nothing has moved. Instance-count
 * changes implicitly invalidate the signature (different grunt array
 * → different fingerprint), so capacity growth is handled inside the
 * rebuild branch.
 */

import * as THREE from "three";
import type { Grunt } from "../../../shared/core/battle-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import type { RenderOverlay } from "../../../shared/ui/overlay-types.ts";
import { buildGrunt, getGruntVariant } from "../sprites/grunt-scene.ts";
import { type BucketSubPart, fillBucket } from "./instance-bucket.ts";

export interface GruntsManager {
  /** Reconcile grunt instance matrices with the overlay. Cheap no-op
   *  when the composite fingerprint hasn't changed since the last call. */
  update(overlay: RenderOverlay | undefined): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

/** Grunt scene is authored in the ±1 frustum spanning a 2-tile (canvasPx
 *  32, game 1× = 16 px, internal 4× = 128). Scaling by TILE_SIZE / 2
 *  makes 1 authored unit = half a tile so the full sprite (±1 world
 *  units) fits inside a 1×1 tile footprint. Matches the 2D path, which
 *  draws the sprite at its 1× pixel size inside a single tile cell. */
const GRUNT_SCALE = TILE_SIZE / 2;
/** 1×1 grunts anchor at their single tile; center sits half a tile
 *  inward. */
const TILE_1X1_CENTER_OFFSET = TILE_SIZE / 2;
/** The N-facing variant is the canonical pose (barrel pointing −Z); we
 *  rotate each instance for every other facing rather than switching
 *  variants. */
const BASE_VARIANT_NAME = "grunt_n";
/** Initial InstancedMesh capacity. Battles top out at ~30 grunts per
 *  docs; 64 gives headroom without noticeable overhead (each slot is a
 *  4×4 float matrix = 64 bytes per sub-part — ~1 KB per sub-part). */
const INITIAL_CAPACITY = 64;

export function createGruntsManager(scene: THREE.Scene): GruntsManager {
  const root = new THREE.Group();
  root.name = "grunts";
  scene.add(root);

  // Owned materials — we don't tint grunts per-player (they're
  // neutral) so this list is currently empty, but kept for the
  // dispose path symmetry with other managers.
  const ownedMaterials: THREE.Material[] = [];
  let subParts: BucketSubPart[] = [];
  let capacity = 0;
  let lastSignature: string | undefined;

  // Scratch objects re-used inside `update` to avoid per-frame
  // allocations. Not shared across managers — each closure owns its
  // own set.
  const hostMatrix = new THREE.Matrix4();
  const instanceMatrix = new THREE.Matrix4();
  const hostTranslation = new THREE.Vector3();
  const hostScale = new THREE.Vector3(GRUNT_SCALE, GRUNT_SCALE, GRUNT_SCALE);
  const hostQuaternion = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);

  function ensureCapacity(required: number): void {
    if (required <= capacity && subParts.length > 0) return;
    // Grow to the next power-of-two step above `required`, starting at
    // INITIAL_CAPACITY. Rebuilds discard + recreate InstancedMeshes
    // because `InstancedMesh.count` is fixed at construction.
    const next = Math.max(INITIAL_CAPACITY, nextPowerOfTwo(required));
    disposeSubParts();
    subParts = buildSubParts(next, root, ownedMaterials);
    capacity = next;
  }

  function disposeSubParts(): void {
    for (const part of subParts) {
      root.remove(part.instanced);
      part.instanced.geometry.dispose();
      part.instanced.dispose();
    }
    subParts = [];
    capacity = 0;
    for (const mat of ownedMaterials) mat.dispose();
    ownedMaterials.length = 0;
  }

  function update(overlay: RenderOverlay | undefined): void {
    const grunts = overlay?.entities?.grunts;
    const count = grunts?.length ?? 0;

    const signature = computeSignature(grunts);
    if (signature === lastSignature) return;
    lastSignature = signature;

    if (count === 0) {
      // Hide all instances by clamping count to zero — keep the
      // InstancedMeshes around so we don't churn GPU buffers on the
      // common "grunts come and go" path.
      for (const part of subParts) part.instanced.count = 0;
      return;
    }

    ensureCapacity(count);

    // Delegate the host×local compose + setMatrixAt loop to the shared
    // bucket helper so every bucket-based manager shares one code path.
    // The per-grunt compose writes translation (tile centre) + Y-yaw
    // (from `-facing`, game CW vs three.js CCW) + uniform scale.
    fillBucket(
      { subParts },
      grunts!,
      hostMatrix,
      instanceMatrix,
      (grunt, matrix) => {
        hostTranslation.set(
          grunt.col * TILE_SIZE + TILE_1X1_CENTER_OFFSET,
          0,
          grunt.row * TILE_SIZE + TILE_1X1_CENTER_OFFSET,
        );
        hostQuaternion.setFromAxisAngle(yAxis, -(grunt.facing ?? 0));
        matrix.compose(hostTranslation, hostQuaternion, hostScale);
      },
    );
  }

  function dispose(): void {
    disposeSubParts();
    scene.remove(root);
  }

  return { update, dispose };
}

/** Run `buildGrunt` once into a throwaway Group, walk the result, and
 *  create one `InstancedMesh` per sub-mesh. Returns the set of
 *  sub-parts (geometry + material are handed to the InstancedMesh;
 *  the throwaway Group is discarded and garbage-collected). */
function buildSubParts(
  capacity: number,
  root: THREE.Group,
  ownedMaterials: THREE.Material[],
): BucketSubPart[] {
  const variant = getGruntVariant(BASE_VARIANT_NAME);
  if (!variant) return [];
  // Strip authored yaw off the base variant — instance rotation is
  // handled at instance time, not at extraction time. N has
  // yawDegrees=0 already, but be explicit.
  const baseParams = { ...variant.params, yawDegrees: 0 };
  const scratch = new THREE.Group();
  buildGrunt(THREE, scratch, baseParams);
  scratch.updateMatrixWorld(true);

  const parts: BucketSubPart[] = [];
  // `buildGrunt` wraps everything in an inner Group (for yaw); that
  // Group's children are the actual meshes. Walk the whole subtree
  // so we're resilient to shape changes without needing to touch
  // grunt-scene.ts.
  scratch.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const material = resolveMaterial(obj.material);
    // InstancedMesh shares one material + geometry across all
    // instances; we take ownership of them here (the throwaway
    // scratch Group is about to be discarded).
    const instanced = new THREE.InstancedMesh(obj.geometry, material, capacity);
    instanced.count = 0;
    instanced.frustumCulled = false;
    instanced.name = obj.name || "grunt-part";
    // Capture the mesh's resolved transform inside the scratch group
    // (its authored placement relative to the grunt's local origin).
    const localMatrix = obj.matrixWorld.clone();
    root.add(instanced);
    ownedMaterials.push(material);
    parts.push({ instanced, localMatrix });
  });
  return parts;
}

/** InstancedMesh takes a single material; pick the first entry if the
 *  source mesh uses a material array (none of the grunt meshes do, but
 *  be defensive). The material is NOT cloned — geometry/material
 *  ownership is handed straight to the InstancedMesh. */
function resolveMaterial(
  source: THREE.Material | THREE.Material[],
): THREE.Material {
  return Array.isArray(source) ? source[0]! : source;
}

/** Composite signature across every grunt. Rebuilds only when one of
 *  the watched fields changes (position or facing). */
function computeSignature(grunts: readonly Grunt[] | undefined): string {
  if (!grunts || grunts.length === 0) return "";
  const parts: string[] = [];
  for (const grunt of grunts) {
    parts.push(`${grunt.col}:${grunt.row}:${grunt.facing ?? 0}`);
  }
  return parts.join("|");
}

function nextPowerOfTwo(value: number): number {
  let power = 1;
  while (power < value) power <<= 1;
  return power;
}
