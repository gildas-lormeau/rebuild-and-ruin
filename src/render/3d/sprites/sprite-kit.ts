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

export type MaterialSide = keyof typeof SIDE_MAP_KEYS;

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
  /** standard only; enables flatShading */
  flat?: boolean;
  /** default 'front' */
  side?: MaterialSide;
}

// World authoring scale: 1 cell = 0.125 world units. Sprite grids,
// tower/house layouts and cannon bounds are all authored in cells so
// downsampling to the target canvas size stays pixel-aligned.
export const CELL = 0.125;
export const cells = (n: number): number => n * CELL;
// THREE side constants keyed by authoring alias. The factory below
// resolves `spec.side: 'front'|'back'|'double'` to THREE.FrontSide etc.
export const SIDE_MAP_KEYS = {
  front: "FrontSide",
  back: "BackSide",
  double: "DoubleSide",
} as const;

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
  if (spec.flat) stdOpts.flatShading = true;
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
