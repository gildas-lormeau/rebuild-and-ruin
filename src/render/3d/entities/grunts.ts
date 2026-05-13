/**
 * 3D grunt meshes. 1×1 tile neutral hazards (30+ at once → InstancedMesh
 * per sub-part). Two buckets — regular grunts (turret + barrel) and
 * catapults (launcher arm). Each extracts sub-parts from its `_n`
 * variant and instances them; per-instance Y rotation = `-facing`.
 * Per-bucket `col:row:facing` fingerprint skips matrix writes when
 * nothing moved; capacity grows by rebuild when slice size exceeds cap.
 */

import * as THREE from "three";
import type { Grunt } from "../../../shared/core/battle-types.ts";
import { GRID_COLS, TILE_SIZE } from "../../../shared/core/grid.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import { buildGrunt, getGruntVariant } from "../sprites/grunt-scene.ts";
import {
  type BucketSubPart,
  fillBucket,
  nextPowerOfTwo,
} from "./instance-bucket.ts";
import { attachInstanceTint } from "./instance-modulation.ts";

export interface GruntsManager {
  /** Reconcile grunt instance matrices with the overlay. Cheap no-op
   *  when the composite fingerprint hasn't changed since the last call. */
  update(ctx: FrameCtx): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

interface GruntBucket {
  subParts: BucketSubPart[];
  /** Per-instance grunt-surge tint attribute (one per sub-part).
   *  Defaults to 0 (no tint) — written each frame the surge ramp is in
   *  flight, with surge intensity at slot indices whose grunt occupies
   *  a tile in `gruntSurgeSpawnTiles`. */
  surgeTintAttrs: THREE.InstancedBufferAttribute[];
  capacity: number;
  lastSignature: string | undefined;
  lastSurgeTilesSig: string;
  lastSurgeIntensity: number;
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
/** Canonical north-facing variant per kind — every other facing comes
 *  from per-instance Y rotation, not a variant swap. */
const REGULAR_VARIANT_NAME = "grunt_n";
const CATAPULT_VARIANT_NAME = "catapult_n";
/** Initial InstancedMesh capacity per bucket. Battles top out at ~30
 *  grunts per docs; spawn ratio is ~75% regular / 25% catapult, so 64
 *  per bucket covers the common case for both without churn. Each slot
 *  is a 4×4 float matrix = 64 bytes per sub-part — ~1 KB per sub-part. */
const INITIAL_CAPACITY = 64;
/** Pale-cyan ice tint applied to grunt materials when the Frostbite
 *  modifier is active for the round. Multiplied into each owned
 *  material's authored base color so all sub-parts read as ice cubes.
 *  Lerped against the original color by `applyFrostbiteTint` — the
 *  intensity multiplier in `[0, 1]` drives the modifier-reveal
 *  progressive freeze (`overlay.battle.frostbiteRevealProgress`). */
const FROSTBITE_TINT_HEX = 0x88d0f0;
const FROSTBITE_COLOR = /* @__PURE__ */ new THREE.Color(FROSTBITE_TINT_HEX);
/** Red tint applied per-instance to fresh surge grunts during the
 *  `grunt_surge` modifier reveal. Lerped against the (possibly
 *  frostbite-tinted) base color via the per-instance tint shader patch
 *  in `attachInstanceTint`. */
const GRUNT_SURGE_TINT_HEX = 0xdc3232;
const EMPTY_KEY_SET: ReadonlySet<number> = new Set();

/** 3-step gradient texture for `MeshToonMaterial`. Pixel 0 = shadow,
 *  pixel 1 = mid, pixel 2 = lit. NearestFilter so steps are hard. The
 *  texture is 1D (3×1 RGBA). Lazy-built and cached at module scope so
 *  every grunt bucket shares the same one. */
let cachedToonGradient: THREE.DataTexture | undefined;

export function createGruntsManager(scene: THREE.Scene): GruntsManager {
  const root = new THREE.Group();
  root.name = "grunts";
  scene.add(root);

  // Owned materials — populated by buildBucket. Kept around so the
  // dispose path can free them and so per-frame tinting (Frostbite ice
  // cube) can mutate `.color` against a stashed `userData` baseline.
  // Shared across both buckets — frostbite tints every grunt material
  // regardless of kind in one pass.
  const ownedMaterials: THREE.Material[] = [];
  const regularBucket = createEmptyBucket();
  const catapultBucket = createEmptyBucket();
  let lastFrostbiteIntensity = 0;

  // Scratch objects re-used inside `update` to avoid per-frame
  // allocations. Not shared across managers — each closure owns its
  // own set.
  const hostMatrix = new THREE.Matrix4();
  const instanceMatrix = new THREE.Matrix4();
  const hostTranslation = new THREE.Vector3();
  const hostScale = new THREE.Vector3(GRUNT_SCALE, GRUNT_SCALE, GRUNT_SCALE);
  const hostQuaternion = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);

  function ensureBucketCapacity(
    bucket: GruntBucket,
    variantName: string,
    required: number,
  ): void {
    if (required <= bucket.capacity && bucket.subParts.length > 0) return;
    // Grow to the next power-of-two step above `required`, starting at
    // INITIAL_CAPACITY. Rebuilds discard + recreate InstancedMeshes
    // because `InstancedMesh.count` is fixed at construction.
    const next = Math.max(INITIAL_CAPACITY, nextPowerOfTwo(required));
    disposeBucket(bucket);
    bucket.subParts = buildBucket(variantName, next, root, ownedMaterials);
    bucket.surgeTintAttrs = bucket.subParts.map(
      (part) =>
        attachInstanceTint(part.instanced, next, GRUNT_SURGE_TINT_HEX, {
          keepOpaque: true,
        }).tint,
    );
    bucket.capacity = next;
  }

  function disposeBucket(bucket: GruntBucket): void {
    for (const part of bucket.subParts) {
      root.remove(part.instanced);
      part.instanced.geometry.dispose();
      part.instanced.dispose();
    }
    bucket.subParts = [];
    bucket.surgeTintAttrs = [];
    bucket.capacity = 0;
    bucket.lastSignature = undefined;
    bucket.lastSurgeIntensity = 0;
    bucket.lastSurgeTilesSig = "";
  }

  function update(ctx: FrameCtx): void {
    const { overlay } = ctx;
    const grunts = overlay?.entities?.grunts;
    // Reveal-window override (`frostbiteRevealProgress` in [0, 1]) wins
    // when present; outside the reveal window, fall back to the binary
    // active flag (1 when frostbite is on, 0 otherwise).
    const frostbiteIntensity =
      overlay?.battle?.frostbiteRevealProgress ??
      (overlay?.battle?.frostbite === true ? 1 : 0);

    if (frostbiteIntensity !== lastFrostbiteIntensity) {
      applyFrostbiteTint(ownedMaterials, frostbiteIntensity);
      lastFrostbiteIntensity = frostbiteIntensity;
    }

    const surgeIntensity = overlay?.battle?.gruntSurgeRevealIntensity ?? 0;
    const spawnTilesRaw = overlay?.battle?.gruntSurgeSpawnTiles;
    const spawnTiles: ReadonlySet<number> =
      spawnTilesRaw && surgeIntensity > 0
        ? new Set(spawnTilesRaw)
        : EMPTY_KEY_SET;
    const surgeTilesSig =
      spawnTiles.size === 0 ? "" : [...spawnTiles].join(",");

    const { regular, catapults } = partitionByKind(grunts);
    updateBucket(
      regularBucket,
      REGULAR_VARIANT_NAME,
      regular,
      frostbiteIntensity,
      surgeIntensity,
      spawnTiles,
      surgeTilesSig,
    );
    updateBucket(
      catapultBucket,
      CATAPULT_VARIANT_NAME,
      catapults,
      frostbiteIntensity,
      surgeIntensity,
      spawnTiles,
      surgeTilesSig,
    );
  }

  function updateBucket(
    bucket: GruntBucket,
    variantName: string,
    grunts: readonly Grunt[],
    frostbiteIntensity: number,
    surgeIntensity: number,
    spawnTiles: ReadonlySet<number>,
    surgeTilesSig: string,
  ): void {
    const count = grunts.length;
    const surgeChanged =
      surgeIntensity !== bucket.lastSurgeIntensity ||
      surgeTilesSig !== bucket.lastSurgeTilesSig;

    const signature = computeSignature(grunts);
    if (signature === bucket.lastSignature && !surgeChanged) return;
    bucket.lastSignature = signature;

    if (count === 0) {
      // Hide all instances by clamping count to zero — keep the
      // InstancedMeshes around so we don't churn GPU buffers on the
      // common "grunts come and go" path.
      for (const part of bucket.subParts) part.instanced.count = 0;
      bucket.lastSurgeIntensity = surgeIntensity;
      bucket.lastSurgeTilesSig = surgeTilesSig;
      return;
    }

    const grewCapacity =
      count > bucket.capacity || bucket.subParts.length === 0;
    ensureBucketCapacity(bucket, variantName, count);
    // Capacity growth rebuilds materials from scratch — reapply any
    // active frostbite tint so the fresh materials don't render at
    // their authored color for one frame.
    if (grewCapacity && frostbiteIntensity > 0) {
      applyFrostbiteTint(ownedMaterials, frostbiteIntensity);
    }

    // Delegate the host×local compose + setMatrixAt loop to the shared
    // bucket helper so every bucket-based manager shares one code path.
    // The per-grunt compose writes translation (tile centre) + Y-yaw
    // (from `-facing`, game CW vs three.js CCW) + uniform scale.
    fillBucket(
      { subParts: bucket.subParts },
      grunts,
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

    // Per-instance grunt-surge tint: fresh-spawn grunts at tiles in
    // `gruntSurgeSpawnTiles` lerp toward red by `surgeIntensity`.
    // Stable across MODIFIER_REVEAL (grunts don't move pre-battle).
    if (surgeChanged || grewCapacity) {
      for (const attr of bucket.surgeTintAttrs) {
        const data = attr.array as Float32Array;
        for (let i = 0; i < count; i++) {
          const grunt = grunts[i]!;
          const tileKey = grunt.row * GRID_COLS + grunt.col;
          data[i] = spawnTiles.has(tileKey) ? surgeIntensity : 0;
        }
        attr.needsUpdate = true;
      }
      bucket.lastSurgeIntensity = surgeIntensity;
      bucket.lastSurgeTilesSig = surgeTilesSig;
    }
  }

  function dispose(): void {
    disposeBucket(regularBucket);
    disposeBucket(catapultBucket);
    for (const mat of ownedMaterials) mat.dispose();
    ownedMaterials.length = 0;
    scene.remove(root);
  }

  return { update, dispose };
}

function createEmptyBucket(): GruntBucket {
  return {
    subParts: [],
    surgeTintAttrs: [],
    capacity: 0,
    lastSignature: undefined,
    lastSurgeTilesSig: "",
    lastSurgeIntensity: 0,
  };
}

/** Split overlay grunts into the two render buckets in a single pass.
 *  Empty arrays are reused per call (cheap GC) — callers immediately
 *  consume them, no need to pool. */
function partitionByKind(grunts: readonly Grunt[] | undefined): {
  regular: Grunt[];
  catapults: Grunt[];
} {
  const regular: Grunt[] = [];
  const catapults: Grunt[] = [];
  if (!grunts) return { regular, catapults };
  for (const grunt of grunts) {
    if (grunt.kind === "catapult") catapults.push(grunt);
    else regular.push(grunt);
  }
  return { regular, catapults };
}

/** Run `buildGrunt` once into a throwaway Group for the given variant,
 *  walk the result, and create one `InstancedMesh` per sub-mesh. Returns
 *  the set of sub-parts (geometry + material are handed to the
 *  InstancedMesh; the throwaway Group is discarded and garbage-collected). */
function buildBucket(
  variantName: string,
  capacity: number,
  root: THREE.Group,
  ownedMaterials: THREE.Material[],
): BucketSubPart[] {
  const variant = getGruntVariant(variantName);
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
    parts.push({ instanced, localMatrix, tags: [] });
  });
  return parts;
}

/** InstancedMesh takes a single material; pick the first entry if the
 *  source mesh uses a material array (none of the grunt meshes do, but
 *  be defensive). Lit MeshStandardMaterial sources are converted to
 *  MeshToonMaterial with a 3-step gradient map for a Nintendo-style
 *  cel-shaded look — hard lit/mid/shadow bands instead of smooth PBR
 *  gradients. Already-unlit materials (e.g. MeshBasicMaterial for
 *  TURRET_AO contact shadows) are passed through unchanged. */
function resolveMaterial(
  source: THREE.Material | THREE.Material[],
): THREE.Material {
  const raw = Array.isArray(source) ? source[0]! : source;
  if (raw instanceof THREE.MeshStandardMaterial) {
    return new THREE.MeshToonMaterial({
      color: raw.color,
      gradientMap: getToonGradient(),
      transparent: raw.transparent,
      opacity: raw.opacity,
      side: raw.side,
    });
  }
  return raw;
}

function getToonGradient(): THREE.DataTexture {
  if (cachedToonGradient) return cachedToonGradient;
  const data = new Uint8Array([
    80,
    80,
    80,
    255, // shadow band
    180,
    180,
    180,
    255, // mid band
    255,
    255,
    255,
    255, // lit band
  ]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  cachedToonGradient = tex;
  return tex;
}

/** Lerp grunt materials between their authored color and the
 *  Frostbite tint by `intensity` in `[0, 1]`. Called when the
 *  frostbite-tint intensity changes (modifier toggle, reveal-window
 *  ramp, or capacity-growth re-apply). Materials that have never seen
 *  frostbite cache their original color as a `Color` clone the first
 *  time `intensity > 0`; subsequent calls (including back to 0) lerp
 *  cleanly off the cached original without re-reading the mutated
 *  `material.color`. */
function applyFrostbiteTint(
  materials: readonly THREE.Material[],
  intensity: number,
): void {
  for (const material of materials) {
    if (!hasColor(material)) continue;
    let original = material.userData.frostbiteOriginal as
      | THREE.Color
      | undefined;
    if (original === undefined) {
      // Skip caching for materials that haven't seen frostbite yet —
      // saves a clone per material on every game without the modifier.
      if (intensity === 0) continue;
      original = material.color.clone();
      material.userData.frostbiteOriginal = original;
    }
    material.color.lerpColors(original, FROSTBITE_COLOR, intensity);
  }
}

/** Type guard — InstancedMesh-bound materials may be unlit (no `.color`)
 *  in the case of TURRET_AO contact shadows; skip those so we don't crash. */
function hasColor(
  material: THREE.Material,
): material is THREE.Material & { color: THREE.Color } {
  return (material as { color?: unknown }).color instanceof THREE.Color;
}

/** Composite signature across every grunt in a bucket. Rebuilds only
 *  when one of the watched fields changes (position or facing). Kind is
 *  not included — each bucket already holds a single kind, so a swap
 *  would manifest as a removal in one bucket + an add in the other. */
function computeSignature(grunts: readonly Grunt[]): string {
  if (grunts.length === 0) return "";
  const parts: string[] = [];
  for (const grunt of grunts) {
    parts.push(`${grunt.col}:${grunt.row}:${grunt.facing ?? 0}`);
  }
  return parts.join("|");
}
