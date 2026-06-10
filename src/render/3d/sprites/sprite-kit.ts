// sprite-kit.ts — shared helpers for *-scene.ts sprite builders.
//
// Each scene file (tower, wall, cannon, …) previously declared its own
// copies of `CELL`, `cells`, `SIDE_MAP_KEYS`, a `MaterialSpec` JSDoc
// typedef, and a `createMaterial` factory. Those definitions had drifted
// slightly between files (some handled `emissive`, some `opacity`, some
// `flat`). This module is the single source of truth: a superset
// implementation that covers every field any scene previously used.
//
// Scope intentionally kept narrow — palettes, procedural textures, and
// scene-specific material constants stay where they are. Files that
// need a procedural texture map should call `createMaterial` for the
// base material and then assign `.map` on the returned material.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

type MaterialSide = keyof typeof SIDE_MAP_KEYS;

export interface MaterialSpec {
  kind: "standard" | "basic";
  color: number;
  /** standard only; default 0.6 */
  roughness?: number;
  /** standard only; default 0.3 */
  metalness?: number;
  /** optional emissive color */
  emissive?: number;
  /** <1 auto-enables transparent */
  opacity?: number;
  /** default 'front' */
  side?: MaterialSide;
}

/** Shared shape for the box-shaped primitive that grunt hulls, house bodies,
 *  and rampart cores all use. Generic over the material spec because house
 *  bodies use the textured variant. */
export interface BoxShapeParams<M extends MaterialSpec = MaterialSpec> {
  width: number;
  depth: number;
  height: number;
  yBase: number;
  material: M;
}

// THREE side constants keyed by authoring alias. The factory below
// resolves `spec.side: 'front'|'back'|'double'` to THREE.FrontSide etc.
const SIDE_MAP_KEYS = {
  front: "FrontSide",
  back: "BackSide",
  double: "DoubleSide",
} as const;
// World authoring scale: 1 cell = 0.125 world units. Sprite grids,
// tower/house layouts and cannon bounds are all authored in cells so
// downsampling to the target canvas size stays pixel-aligned.
export const CELL = 0.125;
export const cells = (n: number): number => n * CELL;

/**
 * Build a THREE material from a MaterialSpec. Superset of every
 * per-scene `createMaterial` / `makeMaterial` that existed before —
 * any field below is ignored if the spec omits it, so passing a spec
 * authored for one scene into another never changes rendering.
 *
 * Procedural texture maps are NOT handled here; scenes that need a
 * `.map` should attach it to the returned material after the call.
 */
export function createMaterial(
  spec: MaterialSpec,
): THREE.MeshBasicMaterial | THREE.MeshStandardMaterial {
  const sideValue =
    spec.side !== undefined ? THREE[SIDE_MAP_KEYS[spec.side]] : undefined;
  if (spec.kind === "basic") {
    const basicOpts: THREE.MeshBasicMaterialParameters = { color: spec.color };
    if (sideValue !== undefined) basicOpts.side = sideValue;
    if (spec.opacity !== undefined && spec.opacity < 1) {
      basicOpts.transparent = true;
      basicOpts.opacity = spec.opacity;
    }
    return new THREE.MeshBasicMaterial(basicOpts);
  }
  const stdOpts: THREE.MeshStandardMaterialParameters = { color: spec.color };
  if (sideValue !== undefined) stdOpts.side = sideValue;
  if (spec.emissive !== undefined) stdOpts.emissive = spec.emissive;
  if (spec.opacity !== undefined && spec.opacity < 1) {
    stdOpts.transparent = true;
    stdOpts.opacity = spec.opacity;
  }
  stdOpts.roughness = spec.roughness ?? 0.6;
  stdOpts.metalness = spec.metalness ?? 0.3;
  return new THREE.MeshStandardMaterial(stdOpts);
}

/** Look up a variant by its `name` field. Factors out the identical
 *  `VARIANTS.find((v) => v.name === name)` each scene module used to
 *  ship. Returns undefined for unknown names. */
export function findVariant<V extends { name: string }>(
  variants: readonly V[],
  name: string,
): V | undefined {
  return variants.find((variant) => variant.name === name);
}

/**
 * Run a variant builder into a scratch Group, walk every mesh, and
 * return the bounding-box Y range of the authored geometry. The returned
 * values are in authored world units (±1 frustum) — callers that scale
 * their scenes (walls/entities use `TILE_SIZE` or `TILE_SIZE / 2` as a
 * uniform multiplier) must multiply by their scene scale.
 *
 * `Box3.setFromObject` walks children recursively and respects any
 * inner transforms (e.g. the tower-scene's internal TOWER_Y_SCALE group),
 * so the returned max-Y reflects the full authored silhouette in the
 * scratch Group's local frame.
 */
// lint:allow-callback-inversion -- builder injection: build() populates the
// scratch group with caller-owned geometry; receiver only measures bounds.
export function measureVariantBoundsY(build: (scratch: THREE.Group) => void): {
  minY: number;
  maxY: number;
} {
  const scratch = new THREE.Group();
  build(scratch);
  scratch.updateMatrixWorld(true);
  const bbox = new THREE.Box3().setFromObject(scratch);
  return { minY: bbox.min.y, maxY: bbox.max.y };
}

/**
 * Bucket every descendant mesh under `group` by material identity
 * (reference equality on the `material` property — so all merlon bodies
 * share one bucket, all merlon caps share another, all AO planes a third,
 * etc.) and merge each bucket's geometries into a single mesh. Each
 * source mesh's `matrixWorld` is baked into the merged vertex positions
 * so parented sub-meshes (e.g. caps that are children of merlons,
 * inheriting any tilt applyWallDamage applied to the parent) merge with
 * their effective world placement intact. Because the merged mesh is
 * re-added directly under `group` with an identity local matrix, callers
 * must invoke this while `group`'s own world transform is identity —
 * detached scratch groups (the wall/debris builders) qualify.
 *
 * Single-mesh buckets are left untouched (e.g. the wall body has its own
 * unique multi-material array — kept as-is). All other buckets use
 * `useGroups = false`: every input mesh has a single Material, so
 * three.js skips group iteration when rendering the merged mesh and the
 * merge is one drawElements per bucket.
 */
export function mergeByMaterial(three: typeof THREE, group: THREE.Group): void {
  group.updateMatrixWorld(true);
  type Material = THREE.Material | THREE.Material[];
  interface Bucket {
    material: Material;
    meshes: THREE.Mesh[];
  }
  const buckets: Bucket[] = [];
  group.traverse((obj) => {
    if (!(obj instanceof three.Mesh)) return;
    const bucket = buckets.find((entry) => entry.material === obj.material);
    if (bucket) bucket.meshes.push(obj);
    else buckets.push({ material: obj.material, meshes: [obj] });
  });

  for (const bucket of buckets) {
    if (bucket.meshes.length < 2) continue;
    const baked = bucket.meshes.map((mesh) =>
      mesh.geometry.clone().applyMatrix4(mesh.matrixWorld),
    );
    // `mergeGeometries` requires the index attribute to exist in all
    // inputs or in none. Debris buckets mix indexed primitives (box /
    // cylinder / sphere) with non-indexed icosahedra — de-index the
    // indexed ones when a bucket is mixed. Homogeneous buckets (all of
    // wall-scene's) skip this branch entirely.
    if (baked.some((geom) => geom.index === null)) {
      for (let i = 0; i < baked.length; i++) {
        const geom = baked[i]!;
        if (geom.index !== null) {
          baked[i] = geom.toNonIndexed();
          geom.dispose();
        }
      }
    }
    const merged = mergeGeometries(baked, false);
    for (const geom of baked) geom.dispose();
    const mergedMesh = new three.Mesh(merged, bucket.material);
    for (const mesh of bucket.meshes) {
      mesh.parent?.remove(mesh);
      mesh.geometry.dispose();
    }
    group.add(mergedMesh);
  }
}

/**
 * Apply box-side UV scaling so a repeating texture tiles uniformly across
 * the four vertical faces (+X, -X, +Z, -Z) of a `BoxGeometry`. Top/bottom
 * faces receive width×depth scaling (they usually carry a plain material
 * where the UV is ignored). `uvDensity` is texture wraps per world unit;
 * `uOff` / `vOff` let callers stitch adjacent boxes into a continuous
 * tiling. Factored out of tower-scene + wall-scene where the two bodies
 * had drifted only in the presence of those offsets.
 */
export function applyBoxWallUV(
  geom: THREE.BoxGeometry,
  width: number,
  height: number,
  depth: number,
  uvDensity: number,
  uOff = 0,
  vOff = 0,
): void {
  const uv = geom.attributes["uv"] as THREE.BufferAttribute;
  const array = uv.array as Float32Array;
  const scales: [number, number][] = [
    [depth, height], // +X
    [depth, height], // -X
    [width, depth], // +Y (plain mat — UVs don't render)
    [width, depth], // -Y
    [width, height], // +Z
    [width, height], // -Z
  ];
  for (let face = 0; face < 6; face++) {
    const [su, sv] = scales[face]!;
    for (let vertex = 0; vertex < 4; vertex++) {
      const index = (face * 4 + vertex) * 2;
      array[index] = array[index]! * su * uvDensity + uOff;
      array[index + 1] = array[index + 1]! * sv * uvDensity + vOff;
    }
  }
  uv.needsUpdate = true;
}
