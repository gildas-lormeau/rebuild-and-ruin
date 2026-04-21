/**
 * cannon-scene.ts — shared cannon scene description.
 *
 * TypeScript conversion of the original `cannon-scene.mjs`. Single
 * source of truth for:
 *   • VARIANTS — the per-cannon dimension registry
 *   • PALETTE  — the quantization palette
 *
 * Five variants: `tier_1` / `tier_2` / `tier_3` (escalating 2×2
 * cannons), `super_gun` (3×3 incendiary), `mortar` (2×2 ballistic).
 *
 * Each part of a cannon (base, barrel, bore, bands, supports) is
 * described by a MaterialSpec object plus optional texture identifier.
 * Decorations are authored per-variant as a flat list at
 * `params.decorations` (see DecorationSpec below). They are pure data:
 * the builder iterates the list and adds one Mesh per entry, so adding
 * cosmetic detail is a data-only change.
 *
 * THREE is injected to `buildCannon(THREE, scene, params)` so the
 * module stays free of three.js as a static dependency (matches the
 * convention of the other `*-scene.ts` files).
 */

import type * as THREE from "three";
import { FRUSTUM_HALF } from "./sprite-bounds.ts";
import {
  cells,
  createMaterial,
  findVariant,
  type MaterialSpec,
} from "./sprite-kit.ts";
import { BORE_DARK } from "./sprite-materials.ts";

/** MaterialSpec + optional procedural texture identifier. Texture maps
 *  are attached post-factory in `makeMaterial` below. */
export interface TexturedMaterialSpec extends MaterialSpec {
  texture?: "wood" | "metal_grip";
}

export interface BaseParams {
  radius: number;
  height: number;
  material: TexturedMaterialSpec;
}

export interface BarrelParams {
  length: number;
  radius: number;
  radiusBreech?: number;
  radiusMuzzle?: number;
  elevationDeg: number;
  zOffset: number;
  yPos: number;
  material: MaterialSpec;
}

export interface BoreParams {
  radius: number;
  material: MaterialSpec;
}

export interface BandsParams {
  positions: readonly number[];
  flare: number;
  height: number;
  material: MaterialSpec;
}

export type SupportsKind = "cheeks" | "stack";

export interface BevelSpec {
  size?: number;
  thickness?: number;
  segments?: number;
}

export interface CheeksSupportsParams {
  kind?: "cheeks";
  width: number;
  height: number;
  depth: number;
  xSpread?: number;
  yPos: number;
  zOffset: number;
  bevel?: number | BevelSpec;
  material: TexturedMaterialSpec;
}

export interface SlabParams {
  width: number;
  depth: number;
  height: number;
  /** Optional top-face taper — single factor (uniform) or [x, z] pair. */
  taperTop?: number | readonly [number, number];
  material?: MaterialSpec;
}

export interface StackSupportsParams {
  kind: "stack";
  zOffset: number;
  slabs: readonly SlabParams[];
  material: MaterialSpec;
}

export type SupportsParams = CheeksSupportsParams | StackSupportsParams;

export type DecorationShape = "box" | "cylinder" | "torus" | "sphere" | "disc";

export interface DecorationDims {
  width?: number;
  height?: number;
  depth?: number;
  bevel?: number | BevelSpec;
  radius?: number;
  radiusTop?: number;
  radiusBottom?: number;
  segments?: number;
  tube?: number;
  radialSegments?: number;
  tubularSegments?: number;
  widthSegments?: number;
  heightSegments?: number;
}

export interface DecorationSpec {
  name?: string;
  shape: DecorationShape;
  dims: DecorationDims;
  attachTo?: "scene" | "barrel";
  pos: readonly [number, number, number];
  rot?: readonly [number, number, number];
  scale?: readonly [number, number, number];
  material: MaterialSpec;
}

export interface CannonParams {
  base: BaseParams;
  barrel: BarrelParams;
  bore: BoreParams;
  bands?: BandsParams;
  supports: SupportsParams;
  decorations?: readonly DecorationSpec[];
}

export interface CannonVariant {
  name: string;
  label: string;
  canvasPx: number;
  params: CannonParams;
}

// ---------- variant registry -------------------------------------------
// Each variant fully describes a cannon. tier_1 is the v0 spec (matches
// the original single-cannon spike numbers exactly). tier_2 / tier_3 /
// super_gun / mortar are first-pass guesses — tune them by editing the
// numbers here, no codepath changes needed.
export const VARIANTS: CannonVariant[] = [
  {
    name: "tier_1",
    label: "tier 1",
    canvasPx: 64,
    // Footprint dimensions authored on the 0.125-world cell grid for
    // pixel alignment. Curves (barrel radius, cascabel sphere, torus
    // rings) stay free-valued — only straight silhouette edges matter.
    // Muzzle tip Z preserved at -0.6544: zOffset back-solved from
    //   -0.6544 + L · cos(60°) = 0.0492  (L now 1.625).
    params: {
      // Wood swivel base — polished light plank (maps to WOOD_LIGHT).
      // radius 7 cells (visible disc edge at ±0.875).
      base: {
        radius: cells(7),
        height: cells(0.5),
        material: {
          kind: "standard",
          color: 0xffac5e,
          roughness: 0.65,
          metalness: 0.0,
          texture: "wood",
        },
      },
      // Tapered profile: breech 0.32 → muzzle 0.22. Length 13 cells.
      // yPos = 6 cells (0.75); breech bottom then =
      //   0.75 − L·cos(60°)/2 − rBreech·sin(60°) = 0.067 above ground.
      barrel: {
        length: cells(13),
        radius: 0.2787,
        radiusBreech: 0.32,
        radiusMuzzle: 0.22,
        elevationDeg: 30,
        zOffset: 0.0492,
        yPos: cells(6),
        material: {
          kind: "standard",
          color: 0xdbe5fb,
          roughness: 0.2,
          metalness: 0.9,
        },
      },
      bore: {
        radius: 0.17,
        material: BORE_DARK,
      },
      // Top band at +2 cells, breech band at −5 cells along barrel local Y.
      bands: {
        positions: [0.25, -0.625],
        flare: cells(0.5),
        height: cells(2),
        material: {
          kind: "standard",
          color: 0xfbbc5e,
          roughness: 0.4,
          metalness: 0.85,
        },
      },
      // Cheeks (wooden side supports): w=1 cell, h=7 cells, d=5 cells,
      // xSpread=3.5 cells (cheek centers), yPos=half-height (3.5 cells).
      // Outer X edge = xSpread + width/2 = 0.5 (4 cells).
      supports: {
        width: cells(1),
        height: cells(7),
        depth: cells(5),
        xSpread: cells(3.5),
        yPos: cells(3.5),
        zOffset: cells(1),
        bevel: 0.015,
        material: {
          kind: "standard",
          color: 0x91522f,
          roughness: 0.95,
          metalness: 0.0,
          texture: "wood",
        },
      },
      decorations: [
        {
          name: "cascabel",
          shape: "sphere",
          dims: { radius: 0.125 },
          attachTo: "barrel",
          pos: [0, -1.625 / 2 - 0.0625, 0],
          material: {
            kind: "standard",
            color: 0xdbe5fb,
            roughness: 0.2,
            metalness: 0.9,
          },
        },
        {
          name: "muzzleSwell",
          shape: "torus",
          dims: {
            radius: 0.26,
            tube: 0.05,
            radialSegments: 16,
            tubularSegments: 32,
          },
          attachTo: "barrel",
          pos: [0, 1.625 / 2 + 0.0125, 0],
          rot: [Math.PI / 2, 0, 0],
          material: {
            kind: "standard",
            color: 0xdbe5fb,
            roughness: 0.2,
            metalness: 0.9,
          },
        },
        {
          name: "trunnion",
          shape: "cylinder",
          dims: {
            radiusTop: 0.0625,
            radiusBottom: 0.0625,
            height: cells(8),
            segments: 16,
          },
          attachTo: "barrel",
          pos: [0, 0, 0],
          rot: [0, 0, Math.PI / 2],
          material: {
            kind: "standard",
            color: 0xdbe5fb,
            roughness: 0.2,
            metalness: 0.9,
          },
        },
        {
          name: "vent",
          shape: "disc",
          dims: { radius: 0.035, segments: 16 },
          attachTo: "barrel",
          pos: [0, cells(-5), 0.321],
          material: BORE_DARK,
        },
        {
          name: "cascabelRing",
          shape: "torus",
          dims: {
            radius: 0.17,
            tube: 0.012,
            radialSegments: 8,
            tubularSegments: 20,
          },
          attachTo: "barrel",
          pos: [0, -1.625 / 2 - 0.0625, 0],
          rot: [Math.PI / 2, 0, 0],
          material: {
            kind: "standard",
            color: 0x71716d,
            roughness: 0.5,
            metalness: 0.9,
          },
        },
        {
          name: "groundShadow",
          shape: "disc",
          dims: { radius: 1.0, segments: 32 },
          attachTo: "scene",
          pos: [0, 0.01, 0],
          rot: [-Math.PI / 2, 0, 0],
          material: { kind: "basic", color: 0x1a1510, side: "double" },
        },
        {
          name: "groundAO",
          shape: "disc",
          dims: { radius: 0.9375, segments: 32 },
          attachTo: "scene",
          pos: [0, 0.015, 0],
          rot: [-Math.PI / 2, 0, 0],
          material: { kind: "basic", color: 0x080806, side: "double" },
        },
      ],
    },
  },
  {
    name: "tier_2",
    label: "tier 2",
    canvasPx: 64,
    // Same cannon as tier_1 but:
    //   * no reinforcement bands
    //   * 3-piece industrial mount replaces the wooden side cheeks
    // Vertical dimensions halved across all 2-tile sprites so cannon
    // mounts sit roughly at wall-apex height in the assembled scene.
    params: {
      base: {
        radius: cells(7),
        height: cells(0.5),
        material: {
          kind: "standard",
          color: 0xffffff,
          roughness: 0.35,
          metalness: 0.8,
          texture: "metal_grip",
        },
      },
      barrel: {
        length: cells(10),
        radius: 0.2787,
        radiusBreech: 0.32,
        radiusMuzzle: 0.22,
        elevationDeg: 30,
        zOffset: -0.1137,
        yPos: cells(5),
        material: {
          kind: "standard",
          color: 0xefefeb,
          roughness: 0.35,
          metalness: 0.85,
        },
      },
      bore: {
        radius: 0.17,
        material: BORE_DARK,
      },
      bands: {
        positions: [],
        flare: cells(0.5),
        height: cells(2),
        material: {
          kind: "standard",
          color: 0x71b04e,
          roughness: 0.6,
          metalness: 0.3,
        },
      },
      supports: {
        kind: "stack",
        zOffset: cells(1),
        slabs: [
          {
            width: cells(8),
            depth: cells(7),
            height: cells(2),
            taperTop: 0.85,
            material: {
              kind: "standard",
              color: 0x71716d,
              roughness: 0.55,
              metalness: 0.8,
            },
          },
          {
            width: cells(5),
            depth: cells(5),
            height: cells(0.5),
            material: {
              kind: "standard",
              color: 0xcfcfc5,
              roughness: 0.25,
              metalness: 0.9,
            },
          },
        ],
        material: {
          kind: "standard",
          color: 0x71716d,
          roughness: 0.55,
          metalness: 0.8,
        },
      },
      decorations: [
        {
          name: "cascabel",
          shape: "sphere",
          dims: { radius: 0.125 },
          attachTo: "barrel",
          pos: [0, -1.25 / 2 - 0.0625, 0],
          material: {
            kind: "standard",
            color: 0xefefeb,
            roughness: 0.35,
            metalness: 0.85,
          },
        },
        {
          name: "muzzleSwell",
          shape: "torus",
          dims: {
            radius: 0.26,
            tube: 0.05,
            radialSegments: 16,
            tubularSegments: 32,
          },
          attachTo: "barrel",
          pos: [0, 1.25 / 2 + 0.0125, 0],
          rot: [Math.PI / 2, 0, 0],
          material: {
            kind: "standard",
            color: 0xefefeb,
            roughness: 0.35,
            metalness: 0.85,
          },
        },
        {
          name: "cheekLeft",
          shape: "box",
          dims: { width: 0.125, height: 0.5, depth: 0.25, bevel: 0.015 },
          attachTo: "scene",
          pos: [cells(-3.5), 0.561, cells(-1)],
          material: {
            kind: "standard",
            color: 0xa6b0c0,
            roughness: 0.28,
            metalness: 0.92,
          },
        },
        {
          name: "cheekRight",
          shape: "box",
          dims: { width: 0.125, height: 0.5, depth: 0.25, bevel: 0.015 },
          attachTo: "scene",
          pos: [cells(3.5), 0.561, cells(-1)],
          material: {
            kind: "standard",
            color: 0xa6b0c0,
            roughness: 0.28,
            metalness: 0.92,
          },
        },
        {
          name: "trunnion",
          shape: "cylinder",
          dims: {
            radiusTop: 0.0625,
            radiusBottom: 0.0625,
            height: cells(8),
            segments: 16,
          },
          attachTo: "barrel",
          pos: [0, 0, 0],
          rot: [0, 0, Math.PI / 2],
          material: {
            kind: "standard",
            color: 0xefefeb,
            roughness: 0.35,
            metalness: 0.85,
          },
        },
        {
          name: "vent",
          shape: "disc",
          dims: { radius: 0.035, segments: 16 },
          attachTo: "barrel",
          pos: [0, cells(-4), 0.321],
          material: BORE_DARK,
        },
        {
          name: "cascabelRing",
          shape: "torus",
          dims: {
            radius: 0.17,
            tube: 0.012,
            radialSegments: 8,
            tubularSegments: 20,
          },
          attachTo: "barrel",
          pos: [0, -1.25 / 2 - 0.0625, 0],
          rot: [Math.PI / 2, 0, 0],
          material: {
            kind: "standard",
            color: 0x71716d,
            roughness: 0.55,
            metalness: 0.9,
          },
        },
        {
          name: "groundShadow",
          shape: "disc",
          dims: { radius: 1.0, segments: 32 },
          attachTo: "scene",
          pos: [0, 0.01, 0],
          rot: [-Math.PI / 2, 0, 0],
          material: { kind: "basic", color: 0x1a1510, side: "double" },
        },
        {
          name: "groundAO",
          shape: "disc",
          dims: { radius: 0.9375, segments: 32 },
          attachTo: "scene",
          pos: [0, 0.015, 0],
          rot: [-Math.PI / 2, 0, 0],
          material: { kind: "basic", color: 0x080806, side: "double" },
        },
      ],
    },
  },
  {
    name: "tier_3",
    label: "tier 3",
    canvasPx: 64,
    params: {
      base: {
        radius: cells(7),
        height: cells(0.5),
        material: {
          kind: "standard",
          color: 0xffffff,
          roughness: 0.35,
          metalness: 0.8,
          texture: "metal_grip",
        },
      },
      barrel: {
        length: cells(10),
        radius: 0.3344,
        radiusBreech: 0.38,
        radiusMuzzle: 0.27,
        elevationDeg: 30,
        zOffset: -0.1137,
        yPos: cells(5.5),
        material: {
          kind: "standard",
          color: 0x91715e,
          roughness: 0.4,
          metalness: 0.8,
        },
      },
      bore: {
        radius: 0.204,
        material: BORE_DARK,
      },
      bands: {
        positions: [],
        flare: cells(0.5),
        height: cells(2),
        material: {
          kind: "standard",
          color: 0xfbbc5e,
          roughness: 0.4,
          metalness: 0.85,
        },
      },
      supports: {
        kind: "stack",
        zOffset: cells(1),
        slabs: [
          {
            width: cells(10),
            depth: cells(7),
            height: cells(2.5),
            taperTop: 0.85,
            material: {
              kind: "standard",
              color: 0x71523e,
              roughness: 0.6,
              metalness: 0.8,
            },
          },
          {
            width: cells(6),
            depth: cells(5),
            height: cells(0.5),
            material: {
              kind: "standard",
              color: 0xfbbc5e,
              roughness: 0.3,
              metalness: 0.9,
            },
          },
        ],
        material: {
          kind: "standard",
          color: 0x71523e,
          roughness: 0.6,
          metalness: 0.8,
        },
      },
      decorations: [
        {
          name: "cascabel",
          shape: "sphere",
          dims: { radius: 0.125 },
          attachTo: "barrel",
          pos: [0, -1.25 / 2 - 0.0625, 0],
          material: {
            kind: "standard",
            color: 0xfbbc5e,
            roughness: 0.4,
            metalness: 0.85,
          },
        },
        {
          name: "muzzleSwell",
          shape: "torus",
          dims: {
            radius: 0.32,
            tube: 0.05,
            radialSegments: 16,
            tubularSegments: 32,
          },
          attachTo: "barrel",
          pos: [0, 1.25 / 2 + 0.0125, 0],
          rot: [Math.PI / 2, 0, 0],
          material: {
            kind: "standard",
            color: 0xfbbc5e,
            roughness: 0.4,
            metalness: 0.85,
          },
        },
        {
          name: "cheekLeft",
          shape: "box",
          dims: { width: 0.125, height: 0.5, depth: 0.25, bevel: 0.015 },
          attachTo: "scene",
          pos: [cells(-3.5), 0.624, cells(-1)],
          material: {
            kind: "standard",
            color: 0x917156,
            roughness: 0.35,
            metalness: 0.88,
          },
        },
        {
          name: "cheekRight",
          shape: "box",
          dims: { width: 0.125, height: 0.5, depth: 0.25, bevel: 0.015 },
          attachTo: "scene",
          pos: [cells(3.5), 0.624, cells(-1)],
          material: {
            kind: "standard",
            color: 0x917156,
            roughness: 0.35,
            metalness: 0.88,
          },
        },
        {
          name: "trunnion",
          shape: "cylinder",
          dims: {
            radiusTop: 0.0625,
            radiusBottom: 0.0625,
            height: cells(8),
            segments: 16,
          },
          attachTo: "barrel",
          pos: [0, 0, 0],
          rot: [0, 0, Math.PI / 2],
          material: {
            kind: "standard",
            color: 0xfbbc5e,
            roughness: 0.4,
            metalness: 0.85,
          },
        },
        {
          name: "vent",
          shape: "disc",
          dims: { radius: 0.045, segments: 16 },
          attachTo: "barrel",
          pos: [0, cells(-4), 0.381],
          material: BORE_DARK,
        },
        {
          name: "cascabelRing",
          shape: "torus",
          dims: {
            radius: 0.2,
            tube: 0.014,
            radialSegments: 8,
            tubularSegments: 20,
          },
          attachTo: "barrel",
          pos: [0, -1.25 / 2 - 0.0625, 0],
          rot: [Math.PI / 2, 0, 0],
          material: {
            kind: "standard",
            color: 0x7d5e2f,
            roughness: 0.5,
            metalness: 0.9,
          },
        },
        {
          name: "groundShadow",
          shape: "disc",
          dims: { radius: 1.0, segments: 32 },
          attachTo: "scene",
          pos: [0, 0.01, 0],
          rot: [-Math.PI / 2, 0, 0],
          material: { kind: "basic", color: 0x1a1510, side: "double" },
        },
        {
          name: "groundAO",
          shape: "disc",
          dims: { radius: 0.9375, segments: 32 },
          attachTo: "scene",
          pos: [0, 0.015, 0],
          rot: [-Math.PI / 2, 0, 0],
          material: { kind: "basic", color: 0x080806, side: "double" },
        },
      ],
    },
  },
  {
    name: "super_gun",
    label: "super gun",
    canvasPx: 96,
    params: {
      base: {
        radius: cells(7),
        height: cells(0.5),
        material: {
          kind: "standard",
          color: 0xffffff,
          roughness: 0.25,
          metalness: 0.9,
          texture: "metal_grip",
        },
      },
      barrel: {
        length: cells(10),
        radius: 0.3344,
        radiusBreech: 0.38,
        radiusMuzzle: 0.27,
        elevationDeg: 30,
        zOffset: -0.1137,
        yPos: cells(5.5),
        material: {
          kind: "standard",
          color: 0xffffff,
          roughness: 0.2,
          metalness: 0.95,
        },
      },
      bore: {
        radius: 0.204,
        material: BORE_DARK,
      },
      bands: {
        positions: [-0.25, 0.125],
        flare: 0.03125,
        height: cells(1),
        material: {
          kind: "standard",
          color: 0xffff8d,
          roughness: 0.3,
          metalness: 0.9,
        },
      },
      supports: {
        kind: "stack",
        zOffset: cells(1),
        slabs: [
          {
            width: cells(10),
            depth: cells(7),
            height: cells(2.5),
            taperTop: 0.85,
            material: {
              kind: "standard",
              color: 0x526279,
              roughness: 0.45,
              metalness: 0.88,
            },
          },
          {
            width: cells(6),
            depth: cells(5),
            height: cells(0.5),
            material: {
              kind: "standard",
              color: 0xffff8d,
              roughness: 0.25,
              metalness: 0.92,
            },
          },
        ],
        material: {
          kind: "standard",
          color: 0x526279,
          roughness: 0.45,
          metalness: 0.88,
        },
      },
      decorations: [
        {
          name: "cascabel",
          shape: "sphere",
          dims: { radius: 0.125 },
          attachTo: "barrel",
          pos: [0, -1.25 / 2 - 0.0625, 0],
          material: {
            kind: "standard",
            color: 0xffff8d,
            roughness: 0.3,
            metalness: 0.9,
          },
        },
        {
          name: "muzzleSwell",
          shape: "torus",
          dims: {
            radius: 0.32,
            tube: 0.05,
            radialSegments: 16,
            tubularSegments: 32,
          },
          attachTo: "barrel",
          pos: [0, 1.25 / 2 + 0.0125, 0],
          rot: [Math.PI / 2, 0, 0],
          material: {
            kind: "standard",
            color: 0xffff8d,
            roughness: 0.3,
            metalness: 0.9,
          },
        },
        {
          name: "cheekLeft",
          shape: "box",
          dims: { width: 0.125, height: 0.5, depth: 0.25, bevel: 0.015 },
          attachTo: "scene",
          pos: [cells(-3.5), 0.624, cells(-1)],
          material: {
            kind: "standard",
            color: 0xcfdffb,
            roughness: 0.22,
            metalness: 0.95,
          },
        },
        {
          name: "cheekRight",
          shape: "box",
          dims: { width: 0.125, height: 0.5, depth: 0.25, bevel: 0.015 },
          attachTo: "scene",
          pos: [cells(3.5), 0.624, cells(-1)],
          material: {
            kind: "standard",
            color: 0xcfdffb,
            roughness: 0.22,
            metalness: 0.95,
          },
        },
        {
          name: "trunnion",
          shape: "cylinder",
          dims: {
            radiusTop: 0.0625,
            radiusBottom: 0.0625,
            height: cells(8),
            segments: 16,
          },
          attachTo: "barrel",
          pos: [0, 0, 0],
          rot: [0, 0, Math.PI / 2],
          material: {
            kind: "standard",
            color: 0xffff8d,
            roughness: 0.3,
            metalness: 0.9,
          },
        },
        {
          name: "vent",
          shape: "disc",
          dims: { radius: 0.045, segments: 16 },
          attachTo: "barrel",
          pos: [0, cells(-4), 0.381],
          material: BORE_DARK,
        },
        {
          name: "cascabelRing",
          shape: "torus",
          dims: {
            radius: 0.2,
            tube: 0.014,
            radialSegments: 8,
            tubularSegments: 20,
          },
          attachTo: "barrel",
          pos: [0, -1.25 / 2 - 0.0625, 0],
          rot: [Math.PI / 2, 0, 0],
          material: {
            kind: "standard",
            color: 0x7d5e2f,
            roughness: 0.5,
            metalness: 0.9,
          },
        },
        {
          name: "groundShadow",
          shape: "disc",
          dims: { radius: 1.0, segments: 32 },
          attachTo: "scene",
          pos: [0, 0.01, 0],
          rot: [-Math.PI / 2, 0, 0],
          material: { kind: "basic", color: 0x1a1510, side: "double" },
        },
        {
          name: "groundAO",
          shape: "disc",
          dims: { radius: 0.9375, segments: 32 },
          attachTo: "scene",
          pos: [0, 0.015, 0],
          rot: [-Math.PI / 2, 0, 0],
          material: { kind: "basic", color: 0x080806, side: "double" },
        },
      ],
    },
  },
  {
    name: "mortar",
    label: "mortar",
    canvasPx: 64,
    params: {
      base: {
        radius: cells(7),
        height: cells(0.5),
        material: {
          kind: "standard",
          color: 0xffac5e,
          roughness: 0.85,
          metalness: 0.0,
          texture: "wood",
        },
      },
      barrel: {
        length: cells(10),
        radius: 0.2787,
        radiusBreech: 0.34,
        radiusMuzzle: 0.2,
        elevationDeg: 80,
        zOffset: 0,
        yPos: 0.991,
        material: {
          kind: "standard",
          color: 0x7d899c,
          roughness: 0.55,
          metalness: 0.75,
        },
      },
      bore: {
        radius: 0.17,
        material: BORE_DARK,
      },
      bands: {
        positions: [],
        flare: cells(0.5),
        height: cells(2),
        material: {
          kind: "standard",
          color: 0x71b04e,
          roughness: 0.6,
          metalness: 0.3,
        },
      },
      supports: {
        kind: "stack",
        zOffset: 0,
        slabs: [
          {
            width: cells(9),
            depth: cells(9),
            height: cells(2.5),
            taperTop: 0.85,
            material: {
              kind: "standard",
              color: 0x6d523e,
              roughness: 0.7,
              metalness: 0.7,
            },
          },
          {
            width: cells(5),
            depth: cells(5),
            height: cells(0.5),
            material: {
              kind: "standard",
              color: 0xb08d6d,
              roughness: 0.45,
              metalness: 0.75,
            },
          },
        ],
        material: {
          kind: "standard",
          color: 0x6d523e,
          roughness: 0.7,
          metalness: 0.7,
        },
      },
      decorations: [
        {
          name: "cascabel",
          shape: "sphere",
          dims: { radius: 0.125 },
          attachTo: "barrel",
          pos: [0, -1.25 / 2 - 0.125, 0],
          material: {
            kind: "standard",
            color: 0x71716d,
            roughness: 0.55,
            metalness: 0.8,
          },
        },
        {
          name: "muzzleSwell",
          shape: "torus",
          dims: {
            radius: 0.23,
            tube: 0.04,
            radialSegments: 16,
            tubularSegments: 32,
          },
          attachTo: "barrel",
          pos: [0, 1.25 / 2 + 0.0125, 0],
          rot: [Math.PI / 2, 0, 0],
          material: {
            kind: "standard",
            color: 0x71716d,
            roughness: 0.55,
            metalness: 0.8,
          },
        },
        {
          name: "cheekLeft",
          shape: "box",
          dims: { width: 0.125, height: 0.875, depth: 0.375, bevel: 0.015 },
          attachTo: "scene",
          pos: [cells(-3.5), cells(6), 0],
          material: {
            kind: "standard",
            color: 0xffcb75,
            roughness: 0.4,
            metalness: 0.7,
          },
        },
        {
          name: "cheekRight",
          shape: "box",
          dims: { width: 0.125, height: 0.875, depth: 0.375, bevel: 0.015 },
          attachTo: "scene",
          pos: [cells(3.5), cells(6), 0],
          material: {
            kind: "standard",
            color: 0xffcb75,
            roughness: 0.4,
            metalness: 0.7,
          },
        },
        {
          name: "trunnion",
          shape: "cylinder",
          dims: {
            radiusTop: 0.0625,
            radiusBottom: 0.0625,
            height: cells(8),
            segments: 16,
          },
          attachTo: "barrel",
          pos: [0, cells(-2), 0],
          rot: [0, 0, Math.PI / 2],
          material: {
            kind: "standard",
            color: 0x71716d,
            roughness: 0.55,
            metalness: 0.8,
          },
        },
        {
          name: "vent",
          shape: "disc",
          dims: { radius: 0.035, segments: 16 },
          attachTo: "barrel",
          pos: [0, cells(-4), 0.341],
          material: BORE_DARK,
        },
        {
          name: "cascabelRing",
          shape: "torus",
          dims: {
            radius: 0.22,
            tube: 0.013,
            radialSegments: 8,
            tubularSegments: 20,
          },
          attachTo: "barrel",
          pos: [0, -1.25 / 2 - 0.125, 0],
          rot: [Math.PI / 2, 0, 0],
          material: {
            kind: "standard",
            color: 0x71462f,
            roughness: 0.7,
            metalness: 0.7,
          },
        },
        {
          name: "groundShadow",
          shape: "disc",
          dims: { radius: 1.0, segments: 32 },
          attachTo: "scene",
          pos: [0, 0.01, 0],
          rot: [-Math.PI / 2, 0, 0],
          material: { kind: "basic", color: 0x1a1510, side: "double" },
        },
        {
          name: "groundAO",
          shape: "disc",
          dims: { radius: 0.9375, segments: 32 },
          attachTo: "scene",
          pos: [0, 0.015, 0],
          rot: [-Math.PI / 2, 0, 0],
          material: { kind: "basic", color: 0x080806, side: "double" },
        },
      ],
    },
  },
];
// ---------- palette ----------------------------------------------------
export const PALETTE: readonly [number, number, number][] = [
  // wood
  [0x3a, 0x24, 0x10],
  [0x5a, 0x38, 0x20],
  [0x8a, 0x58, 0x30],
  // cast iron
  [0x2a, 0x2a, 0x28],
  [0x4a, 0x4a, 0x48],
  [0x7a, 0x7a, 0x78],
  [0x70, 0x75, 0x80],
  [0x90, 0x98, 0xa5],
  // bronze accent
  [0x40, 0x30, 0x18],
  [0x80, 0x60, 0x30],
  [0xb0, 0x88, 0x48],
  // darkest accent
  [0x0a, 0x0a, 0x0a],
];

let cachedWoodTexture: THREE.Texture | undefined;
let cachedMetalGripTexture: THREE.Texture | undefined;

/** Look up a cannon variant by name. */
export function getCannonVariant(name: string): CannonVariant | undefined {
  return findVariant(VARIANTS, name);
}

export function barrelWorldPoints(barrel: BarrelParams): {
  center: readonly [number, number, number];
  breech: readonly [number, number, number];
  muzzle: readonly [number, number, number];
} {
  const len = barrel.length;
  const theta = ((-90 + barrel.elevationDeg) * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const deltaY = (len / 2) * cosT;
  const deltaZ = (len / 2) * sinT;
  const cx = 0;
  const cy = barrel.yPos;
  const cz = barrel.zOffset;
  return {
    center: [cx, cy, cz],
    muzzle: [cx, cy + deltaY, cz + deltaZ],
    breech: [cx, cy - deltaY, cz - deltaZ],
  };
}

export function buildCannon(
  three: typeof THREE,
  scene: THREE.Scene | THREE.Group,
  params: CannonParams,
): void {
  const mat = (spec: MaterialSpec): THREE.Material => makeMaterial(three, spec);

  // Base — named so the entity manager can hide just the ground disc
  // during battle (the rest of the cannon keeps rendering).
  const base = new three.Mesh(
    new three.CylinderGeometry(
      params.base.radius,
      params.base.radius,
      params.base.height,
      48,
    ),
    mat(params.base.material),
  );
  base.name = "base";
  base.position.y = params.base.height / 2;
  scene.add(base);

  // Barrel (inside an elevation group). Optional taper: radiusBreech
  // > radiusMuzzle gives the historic "wider at the back" silhouette.
  const barrelGroup = new three.Group();
  const radiusMuzzle = params.barrel.radiusMuzzle ?? params.barrel.radius;
  const radiusBreech = params.barrel.radiusBreech ?? params.barrel.radius;
  const barrel = new three.Mesh(
    new three.CylinderGeometry(
      radiusMuzzle,
      radiusBreech,
      params.barrel.length,
      32,
    ),
    mat(params.barrel.material),
  );
  barrelGroup.add(barrel);

  // Bore: flat dark disc on the muzzle face.
  const bore = new three.Mesh(
    new three.CircleGeometry(params.bore.radius, 24),
    mat(params.bore.material),
  );
  bore.rotation.x = -Math.PI / 2;
  bore.position.y = params.barrel.length / 2 + 0.001;
  barrel.add(bore);

  // Reinforcement bands. Each band hugs the LOCAL barrel radius at its
  // axial position.
  if (params.bands && params.bands.positions.length > 0) {
    const bandMat = mat(params.bands.material);
    const len = params.barrel.length;
    const rBreech = params.barrel.radiusBreech ?? params.barrel.radius;
    const rMuzzle = params.barrel.radiusMuzzle ?? params.barrel.radius;
    const flare = params.bands.flare;
    const bandHeight = params.bands.height;
    for (const localY of params.bands.positions) {
      const yTop = localY + bandHeight / 2;
      const yBottom = localY - bandHeight / 2;
      const tTop = (yTop + len / 2) / len;
      const tBottom = (yBottom + len / 2) / len;
      const radiusTop = rBreech + (rMuzzle - rBreech) * tTop + flare;
      const radiusBottom = rBreech + (rMuzzle - rBreech) * tBottom + flare;
      const band = new three.Mesh(
        new three.CylinderGeometry(radiusTop, radiusBottom, bandHeight, 32),
        bandMat,
      );
      band.position.y = localY;
      barrel.add(band);
    }
  }

  // Apply elevation + position.
  barrelGroup.rotation.x = three.MathUtils.degToRad(
    -90 + params.barrel.elevationDeg,
  );
  barrelGroup.position.set(0, params.barrel.yPos, params.barrel.zOffset);
  scene.add(barrelGroup);

  // Support(s) underneath the barrel.
  const supportMat = mat(params.supports.material);
  if (params.supports.kind === "stack") {
    const stack = params.supports;
    let yCursor = 0;
    for (const slab of stack.slabs) {
      const slabMat = slab.material ? mat(slab.material) : supportMat;
      const geom = new three.BoxGeometry(slab.width, slab.height, slab.depth);
      if (slab.taperTop !== undefined) {
        const [taperX, taperZ] = Array.isArray(slab.taperTop)
          ? slab.taperTop
          : ([slab.taperTop, slab.taperTop] as const);
        const pos = geom.attributes.position as
          | THREE.BufferAttribute
          | undefined;
        if (pos) {
          for (let vertexIdx = 0; vertexIdx < pos.count; vertexIdx++) {
            if (pos.getY(vertexIdx) > 0) {
              pos.setX(vertexIdx, pos.getX(vertexIdx) * taperX);
              pos.setZ(vertexIdx, pos.getZ(vertexIdx) * taperZ);
            }
          }
          pos.needsUpdate = true;
          geom.computeVertexNormals();
        }
      }
      const slabMesh = new three.Mesh(geom, slabMat);
      slabMesh.position.set(0, yCursor + slab.height / 2, stack.zOffset);
      scene.add(slabMesh);
      yCursor += slab.height;
    }
  } else {
    const cheeks = params.supports;
    const cheekGeom =
      cheeks.bevel !== undefined
        ? createBeveledBox(
            three,
            cheeks.width,
            cheeks.height,
            cheeks.depth,
            cheeks.bevel,
          )
        : new three.BoxGeometry(cheeks.width, cheeks.height, cheeks.depth);
    const xSpread = cheeks.xSpread ?? 0;
    for (const xCenter of [-xSpread, xSpread]) {
      const support = new three.Mesh(cheekGeom, supportMat);
      support.position.set(xCenter, cheeks.yPos, cheeks.zOffset);
      scene.add(support);
    }
  }

  // Decorations. The DecorationSpec's `name` propagates onto the mesh so
  // the entity manager can find specific parts (e.g. ground-shadow discs)
  // by name after extractSubParts.
  const decorations = params.decorations ?? [];
  for (const dec of decorations) {
    const mesh = new three.Mesh(
      createDecorationGeometry(three, dec),
      mat(dec.material),
    );
    if (dec.name) mesh.name = dec.name;
    const pos = dec.pos;
    mesh.position.set(pos[0], pos[1], pos[2]);
    if (dec.rot) mesh.rotation.set(dec.rot[0], dec.rot[1], dec.rot[2]);
    if (dec.scale) mesh.scale.set(dec.scale[0], dec.scale[1], dec.scale[2]);
    const parent = dec.attachTo === "barrel" ? barrel : scene;
    parent.add(mesh);
  }
}

/** Texture-aware wrapper around `createMaterial`. Attaches a procedural
 *  wood/metal-grip map when the spec names one. Only generated in the
 *  browser — Node (verify/measure scripts) falls back to the base colour. */
function makeMaterial(
  three: typeof THREE,
  spec: MaterialSpec | TexturedMaterialSpec,
): THREE.Material {
  const mat = createMaterial(spec);
  if (spec.kind === "basic") return mat;
  const textured = spec as TexturedMaterialSpec;
  if (
    !(
      mat instanceof
      (three.MeshStandardMaterial as unknown as typeof THREE.MeshStandardMaterial)
    )
  ) {
    return mat;
  }
  if (textured.texture === "wood") {
    const tex = getWoodTexture(three);
    if (tex) mat.map = tex;
  } else if (textured.texture === "metal_grip") {
    const tex = getMetalGripTexture(three);
    if (tex) mat.map = tex;
  }
  return mat;
}

function getWoodTexture(three: typeof THREE): THREE.Texture | undefined {
  if (typeof document === "undefined") return undefined;
  if (cachedWoodTexture) return cachedWoodTexture;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.fillStyle = "#c8c8c8";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "rgba(60, 40, 20, 0.55)";
  ctx.lineWidth = 1;
  for (let yLine = 1; yLine < size; yLine += 3) {
    ctx.beginPath();
    const drift = Math.sin(yLine * 0.15) * 1.2;
    ctx.moveTo(0, yLine + drift);
    for (let xStep = 4; xStep <= size; xStep += 4) {
      const wobble = Math.sin((xStep + yLine) * 0.22) * 1.1;
      ctx.lineTo(xStep, yLine + drift + wobble);
    }
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(40, 25, 10, 0.35)";
  for (const [kx, ky, kr] of [
    [12, 20, 3],
    [44, 38, 2.5],
    [28, 52, 2],
  ] as const) {
    ctx.beginPath();
    ctx.ellipse(kx, ky, kr, kr * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new three.CanvasTexture(canvas);
  tex.wrapS = three.RepeatWrapping;
  tex.wrapT = three.RepeatWrapping;
  cachedWoodTexture = tex;
  return tex;
}

function getMetalGripTexture(three: typeof THREE): THREE.Texture | undefined {
  if (typeof document === "undefined") return undefined;
  if (cachedMetalGripTexture) return cachedMetalGripTexture;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.fillStyle = "#c0c0c0";
  ctx.fillRect(0, 0, size, size);
  const step = 4;
  ctx.fillStyle = "rgba(40, 40, 50, 0.55)";
  for (let row = 0; row < size / step + 1; row++) {
    const offset = (row % 2) * (step / 2);
    for (let column = 0; column < size / step + 1; column++) {
      const xCenter = column * step + offset;
      const yCenter = row * step;
      ctx.beginPath();
      ctx.ellipse(
        xCenter + 0.3,
        yCenter + 0.3,
        1.2,
        0.7,
        Math.PI / 4,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }
  ctx.fillStyle = "rgba(240, 240, 240, 0.55)";
  for (let row = 0; row < size / step + 1; row++) {
    const offset = (row % 2) * (step / 2);
    for (let column = 0; column < size / step + 1; column++) {
      const xCenter = column * step + offset;
      const yCenter = row * step;
      ctx.beginPath();
      ctx.ellipse(
        xCenter - 0.3,
        yCenter - 0.3,
        1.05,
        0.55,
        Math.PI / 4,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }
  const tex = new three.CanvasTexture(canvas);
  tex.wrapS = three.RepeatWrapping;
  tex.wrapT = three.RepeatWrapping;
  cachedMetalGripTexture = tex;
  return tex;
}

function createDecorationGeometry(
  three: typeof THREE,
  dec: DecorationSpec,
): THREE.BufferGeometry {
  const dims = dec.dims;
  switch (dec.shape) {
    case "box":
      if (dims.bevel !== undefined) {
        return createBeveledBox(
          three,
          dims.width ?? 0,
          dims.height ?? 0,
          dims.depth ?? 0,
          dims.bevel,
        );
      }
      return new three.BoxGeometry(
        dims.width ?? 0,
        dims.height ?? 0,
        dims.depth ?? 0,
      );
    case "cylinder":
      return new three.CylinderGeometry(
        dims.radiusTop ?? 0,
        dims.radiusBottom ?? 0,
        dims.height ?? 0,
        dims.segments ?? 32,
      );
    case "torus":
      return new three.TorusGeometry(
        dims.radius ?? 0,
        dims.tube ?? 0,
        dims.radialSegments ?? 16,
        dims.tubularSegments ?? 32,
      );
    case "sphere":
      return new three.SphereGeometry(
        dims.radius ?? 0,
        dims.widthSegments ?? 24,
        dims.heightSegments ?? 16,
      );
    case "disc":
      return new three.CircleGeometry(dims.radius ?? 0, dims.segments ?? 32);
    default: {
      const exhaustive: never = dec.shape;
      throw new Error(`unknown decoration shape: ${exhaustive as string}`);
    }
  }
}

function createBeveledBox(
  three: typeof THREE,
  width: number,
  height: number,
  depth: number,
  bevelAmount: number | BevelSpec,
): THREE.BufferGeometry {
  const spec =
    typeof bevelAmount === "number"
      ? { size: bevelAmount, thickness: bevelAmount, segments: 1 }
      : {
          size: bevelAmount.size ?? 0.02,
          thickness: bevelAmount.thickness ?? bevelAmount.size ?? 0.02,
          segments: bevelAmount.segments ?? 1,
        };
  const halfWidth = (width - 2 * spec.size) / 2;
  const halfDepth = (depth - 2 * spec.size) / 2;
  const shape = new three.Shape();
  shape.moveTo(-halfWidth, -halfDepth);
  shape.lineTo(halfWidth, -halfDepth);
  shape.lineTo(halfWidth, halfDepth);
  shape.lineTo(-halfWidth, halfDepth);
  shape.closePath();
  const geom = new three.ExtrudeGeometry(shape, {
    depth: height - 2 * spec.thickness,
    bevelEnabled: true,
    bevelThickness: spec.thickness,
    bevelSize: spec.size,
    bevelSegments: spec.segments,
    steps: 1,
  });
  geom.rotateX(-Math.PI / 2);
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  if (bb) {
    geom.translate(
      -(bb.min.x + bb.max.x) / 2,
      -(bb.min.y + bb.max.y) / 2,
      -(bb.min.z + bb.max.z) / 2,
    );
  }
  return geom;
}

// Suppress FRUSTUM_HALF unused-import lint if no runtime callsite needs it;
// we keep the symbol re-exported for callers that validate bounds.
void FRUSTUM_HALF;
