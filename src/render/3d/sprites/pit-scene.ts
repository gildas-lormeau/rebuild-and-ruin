/**
 * pit-scene.ts — burning-pit sprite (1×1 tile, transparent bg).
 *
 * TypeScript conversion of the original `pit-scene.mjs`. A pit exists
 * for 3 battle rounds, fading each round: fresh flames → dim flames →
 * embers. The engine swaps the sprite based on the pit's remaining-
 * rounds counter. Rendered with a transparent background so the
 * underlying terrain (grass, interior, cobbles, frozen water…) shows
 * through the burned area.
 *
 * Shared hole geometry across all 3 states. Flames & embers differ.
 *
 * THREE is injected to `buildPit(THREE, scene, params)` so this module
 * stays free of three.js as a static dependency — matches the
 * convention of the other `*-scene.ts` files.
 */

import type * as THREE from "three";
import {
  BOUND_EPS,
  FRUSTUM_HALF,
  fmtBound,
  radialReach,
} from "./sprite-bounds.ts";
import {
  CELL,
  cells,
  createMaterial,
  type MaterialSpec,
} from "./sprite-kit.ts";

export interface HoleParams {
  outerRadius: number;
  innerRadius: number;
  /** Offset of the inner hole from the outer-disc center, breaking the
   *  concentric-circle symmetry. */
  innerOffset?: readonly [number, number];
  outerMaterial: MaterialSpec;
}

export interface LavaParams {
  radius: number;
  material: MaterialSpec;
}

export interface LavaSplatterParams {
  radius: number;
  pos: readonly [number, number];
}

export interface RimDebrisParams {
  size: number;
  pos: readonly [number, number, number];
}

export interface FlameSpec {
  /** Cone base radius. */
  radius: number;
  /** Cone height. */
  height: number;
  /** Horizontal offset (x, z) from pit center. */
  xz: readonly [number, number];
  material: MaterialSpec;
}

export interface EmberSpec {
  /** Box edge length. */
  size: number;
  pos: readonly [number, number, number];
}

export interface PitParams {
  hole: HoleParams;
  lava?: LavaParams;
  lavaSplatters?: readonly LavaSplatterParams[];
  rimDebris?: readonly RimDebrisParams[];
  flames: readonly FlameSpec[];
  embers: readonly EmberSpec[];
}

export interface PitVariant {
  name: string;
  label: string;
  canvasPx: number;
  params: PitParams;
}

export interface PitVariantReport {
  name: string;
  warnings: string[];
}

// Charred soil around the rim — three shades, one per state.
const HOLE_OUTER_FRESH: MaterialSpec = {
  kind: "basic",
  color: 0x2a1610,
  side: "double",
};
const HOLE_OUTER_DIM: MaterialSpec = {
  kind: "basic",
  color: 0x1e0e08,
  side: "double",
};
const HOLE_OUTER_EMBERS: MaterialSpec = {
  kind: "basic",
  color: 0x180808,
  side: "double",
};
// Deeper inner hole — near-black so it reads as a depression on both
// light (grass) and dark (interior) backgrounds.
const HOLE_INNER: MaterialSpec = {
  kind: "basic",
  color: 0x0c0604,
  side: "double",
};
// Lava — bright emissive disc filling the inner hole. Different
// brightnesses per state so the pit visibly cools over time.
const LAVA_HOT: MaterialSpec = {
  kind: "standard",
  color: 0xff9030,
  emissive: 0xe05018,
  roughness: 0.4,
  metalness: 0.0,
};
const LAVA_WARM: MaterialSpec = {
  kind: "standard",
  color: 0xc04018,
  emissive: 0x801810,
  roughness: 0.5,
  metalness: 0.0,
};
const LAVA_COOL: MaterialSpec = {
  kind: "standard",
  color: 0x801810,
  emissive: 0x400804,
  roughness: 0.6,
  metalness: 0.0,
};
// Flame palette. Emissive slightly above base color so flames read
// as glowing regardless of scene lighting.
const FLAME_YELLOW: MaterialSpec = {
  kind: "standard",
  color: 0xffc030,
  emissive: 0xe08010,
  roughness: 0.4,
  metalness: 0.0,
};
const FLAME_ORANGE: MaterialSpec = {
  kind: "standard",
  color: 0xe05018,
  emissive: 0xa03008,
  roughness: 0.5,
  metalness: 0.0,
};
const FLAME_RED: MaterialSpec = {
  kind: "standard",
  color: 0xa02010,
  emissive: 0x601008,
  roughness: 0.6,
  metalness: 0.0,
};
const EMBER_BRIGHT: MaterialSpec = {
  kind: "standard",
  color: 0xff9040,
  emissive: 0xe05018,
  roughness: 0.5,
  metalness: 0.0,
};
export const VARIANTS: PitVariant[] = [
  {
    name: "pit_fresh",
    label: "pit — fresh (round 1)",
    canvasPx: 32,
    params: {
      // 1-tile sprite frustum is ±1 (= 16 cells = 16 px at game-1×).
      // House walls are 14 cells wide — pit matches that footprint.
      hole: {
        outerRadius: 0.875, // 7 cells radius, 14 px diameter at game-1×
        innerRadius: 0.625, // 5 cells, 10 px diameter
        innerOffset: [cells(0.5), -cells(0.5)], // break concentric symmetry
        outerMaterial: HOLE_OUTER_FRESH,
      },
      lava: { radius: 0.5, material: LAVA_HOT }, // 4 cells, 8 px
      lavaSplatters: [
        { radius: 0.125, pos: [cells(5), cells(1)] },
        { radius: 0.09, pos: [-cells(4.5), cells(3.5)] },
        { radius: 0.11, pos: [-cells(5), -cells(3)] },
      ],
      rimDebris: [
        // Dark chunks scattered on the outer rim, irregular sizes.
        { size: cells(1), pos: [cells(6.5), cells(0.005 / CELL), -cells(2)] },
        { size: cells(1.5), pos: [-cells(5.5), cells(0.005 / CELL), cells(4)] },
        { size: cells(1), pos: [cells(2), cells(0.005 / CELL), cells(6.5)] },
        {
          size: cells(0.5),
          pos: [-cells(6), cells(0.005 / CELL), -cells(1.5)],
        },
        { size: cells(1), pos: [cells(3), cells(0.005 / CELL), -cells(6)] },
        { size: cells(0.5), pos: [-cells(3), cells(0.005 / CELL), cells(6)] },
      ],
      flames: [
        // Tall yellow core — brightest flame, reads as active fire.
        { radius: 0.25, height: cells(8), xz: [0, 0], material: FLAME_YELLOW },
        // Wider orange body wrapping the core.
        { radius: 0.375, height: cells(6), xz: [0, 0], material: FLAME_ORANGE },
        // Outer red tufts filling the pit perimeter.
        { radius: 0.25, height: cells(5), xz: [0.375, 0], material: FLAME_RED },
        {
          radius: 0.25,
          height: cells(5),
          xz: [-0.25, 0.25],
          material: FLAME_RED,
        },
        {
          radius: 0.25,
          height: cells(5),
          xz: [-0.125, -0.375],
          material: FLAME_RED,
        },
      ],
      embers: [
        { size: cells(1), pos: [0.375, cells(0.5), 0.125] },
        { size: cells(1), pos: [-0.375, cells(0.5), -0.25] },
      ],
    },
  },
  {
    name: "pit_dim",
    label: "pit — dim (round 2)",
    canvasPx: 32,
    params: {
      hole: {
        outerRadius: 0.75, // 6 cells, 12 px — shrunk from fresh
        innerRadius: 0.5, // 4 cells, 8 px
        innerOffset: [-cells(0.5), cells(0.5)],
        outerMaterial: HOLE_OUTER_DIM,
      },
      lava: { radius: 0.375, material: LAVA_WARM }, // 3 cells, 6 px
      lavaSplatters: [
        { radius: 0.08, pos: [cells(3.5), -cells(1)] },
        { radius: 0.09, pos: [-cells(3), cells(3)] },
      ],
      rimDebris: [
        { size: cells(1), pos: [cells(5), cells(0.005 / CELL), cells(3)] },
        {
          size: cells(0.5),
          pos: [-cells(5.5), cells(0.005 / CELL), -cells(1)],
        },
        { size: cells(1), pos: [-cells(2), cells(0.005 / CELL), -cells(5.5)] },
        { size: cells(0.5), pos: [cells(2), cells(0.005 / CELL), cells(5.5)] },
      ],
      flames: [
        // Shorter orange core, no yellow peak — fire is weaker.
        { radius: 0.25, height: cells(4), xz: [0, 0], material: FLAME_ORANGE },
        // Two low red tufts.
        {
          radius: 0.125,
          height: cells(3),
          xz: [0.25, 0.125],
          material: FLAME_RED,
        },
        {
          radius: 0.125,
          height: cells(3),
          xz: [-0.25, -0.25],
          material: FLAME_RED,
        },
      ],
      embers: [
        { size: cells(1), pos: [0.375, cells(0.5), 0.125] },
        { size: cells(1), pos: [-0.25, cells(0.5), -0.375] },
        { size: cells(1), pos: [0.125, cells(0.5), 0.375] },
      ],
    },
  },
  {
    name: "pit_embers",
    label: "pit — embers (round 3)",
    canvasPx: 32,
    params: {
      hole: {
        outerRadius: 0.625, // 5 cells, 10 px — smallest
        innerRadius: 0.375, // 3 cells, 6 px
        innerOffset: [cells(0.5), cells(0.5)],
        outerMaterial: HOLE_OUTER_EMBERS,
      },
      lava: { radius: 0.3125, material: LAVA_COOL }, // 2.5 cells, 5 px
      lavaSplatters: [
        { radius: 0.08, pos: [-cells(2), cells(1)] },
        { radius: 0.07, pos: [cells(1.5), cells(2)] },
        { radius: 0.06, pos: [cells(2), -cells(2)] },
      ],
      rimDebris: [
        { size: cells(0.5), pos: [cells(4.5), cells(0.005 / CELL), cells(1)] },
        { size: cells(1), pos: [-cells(4), cells(0.005 / CELL), -cells(3)] },
        { size: cells(0.5), pos: [cells(1), cells(0.005 / CELL), cells(4.5)] },
      ],
      flames: [],
      embers: [
        { size: cells(1), pos: [0.0, cells(0.5), 0.0] },
        { size: cells(1), pos: [0.25, cells(0.5), -0.125] },
        { size: cells(1), pos: [-0.125, cells(0.5), -0.25] },
        { size: cells(1), pos: [-0.25, cells(0.5), 0.25] },
      ],
    },
  },
];
export const PALETTE: [number, number, number][] = [
  // hole / charred soil
  [0x0c, 0x06, 0x04],
  [0x2a, 0x16, 0x10],
  [0x40, 0x38, 0x30],
  // flame reds/oranges/yellows
  [0xa0, 0x20, 0x10],
  [0xe0, 0x50, 0x18],
  [0xff, 0x90, 0x40],
  [0xff, 0xc0, 0x30],
  // dark accent
  [0x0a, 0x0a, 0x0a],
];

/** Look up a pit variant by name (pit_fresh / pit_dim / pit_embers). */
export function getPitVariant(name: string): PitVariant | undefined {
  return VARIANTS.find((variant) => variant.name === name);
}

export function variantReport(variant: PitVariant): PitVariantReport {
  const warnings: string[] = [];
  const p = variant.params;
  if (p.hole.innerRadius >= p.hole.outerRadius) {
    warnings.push("inner hole radius must be smaller than outer");
  }
  if (p.hole.outerRadius > FRUSTUM_HALF + BOUND_EPS) {
    warnings.push(fmtBound("outer radius", p.hole.outerRadius));
  }
  for (const flame of p.flames) {
    const reach = radialReach(flame.xz[0], flame.xz[1], flame.radius);
    if (reach > FRUSTUM_HALF + BOUND_EPS)
      warnings.push(fmtBound("flame", reach));
  }
  return { name: variant.name, warnings };
}

export function buildPit(
  three: typeof THREE,
  scene: THREE.Scene | THREE.Group,
  params: PitParams,
): void {
  // Outer charred disc — the burned ground footprint. Per-state color
  // (fresh=warm brown, dim=darker, embers=near-black ash).
  const outer = new three.Mesh(
    new three.CircleGeometry(params.hole.outerRadius, 32),
    createMaterial(params.hole.outerMaterial),
  );
  outer.rotation.x = -Math.PI / 2;
  outer.position.set(0, 0.003, 0);
  scene.add(outer);

  // Deeper inner hole — reads as the depression. Slightly offset
  // from center to break the concentric-circle symmetry.
  const innerOff = params.hole.innerOffset ?? [0, 0];
  const inner = new three.Mesh(
    new three.CircleGeometry(params.hole.innerRadius, 24),
    createMaterial(HOLE_INNER),
  );
  inner.rotation.x = -Math.PI / 2;
  inner.position.set(innerOff[0], 0.005, innerOff[1]);
  scene.add(inner);

  // Lava disc — bright emissive layer sitting at the bottom of the
  // hole, visible through the inner opening. Shrinks/cools with state.
  if (params.lava) {
    const lava = new three.Mesh(
      new three.CircleGeometry(params.lava.radius, 24),
      createMaterial(params.lava.material),
    );
    lava.rotation.x = -Math.PI / 2;
    lava.position.set(innerOff[0], 0.007, innerOff[1]);
    scene.add(lava);
  }

  // Lava splatters — small extra bright dots breaking the disc outline.
  if (params.lavaSplatters && params.lava) {
    const lavaMat = createMaterial(params.lava.material);
    for (const splatter of params.lavaSplatters) {
      const splat = new three.Mesh(
        new three.CircleGeometry(splatter.radius, 12),
        lavaMat,
      );
      splat.rotation.x = -Math.PI / 2;
      splat.position.set(splatter.pos[0], 0.008, splatter.pos[1]);
      scene.add(splat);
    }
  }

  // Rim debris — small dark chunks scattered on the outer rim,
  // breaking the perfect circle of the outer disc.
  if (params.rimDebris) {
    const debrisMat = createMaterial(params.hole.outerMaterial);
    for (const chunkSpec of params.rimDebris) {
      const chunk = new three.Mesh(
        new three.BoxGeometry(chunkSpec.size, chunkSpec.size, chunkSpec.size),
        debrisMat,
      );
      chunk.position.set(chunkSpec.pos[0], chunkSpec.pos[1], chunkSpec.pos[2]);
      // Deterministic pseudo-random yaw from position so debris doesn't
      // look grid-aligned.
      chunk.rotation.y = chunkSpec.pos[0] + chunkSpec.pos[2];
      scene.add(chunk);
    }
  }

  // Flames — cones with tip up, rendered in the order given so later
  // flames draw on top. Typically core-last so the yellow peak is on top.
  for (const flame of params.flames) {
    const cone = new three.Mesh(
      new three.ConeGeometry(flame.radius, flame.height, 10),
      createMaterial(flame.material),
    );
    cone.position.set(flame.xz[0], flame.height / 2, flame.xz[1]);
    scene.add(cone);
  }

  // Embers — small glowing cubes sitting on/inside the hole.
  for (const ember of params.embers) {
    const mesh = new three.Mesh(
      new three.BoxGeometry(ember.size, ember.size, ember.size),
      createMaterial(EMBER_BRIGHT),
    );
    mesh.position.set(ember.pos[0], ember.pos[1], ember.pos[2]);
    scene.add(mesh);
  }
}
