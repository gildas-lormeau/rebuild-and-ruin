/**
 * debris-scene.ts — destroyed cannon / tower / wall variants.
 *
 * TypeScript conversion of the original `debris-scene.mjs`. Nine variants:
 *   • cannon debris: `tier_1_debris`, `tier_2_debris`, `tier_3_debris`,
 *     `super_gun_debris`, `mortar_debris` (2×2 tile rubble piles).
 *   • tower debris: `secondary_tower_debris`, `home_tower_debris`
 *     (2×2 tile rubble piles).
 *   • wall debris: `wall_debris_a`, `wall_debris_b` (1×1 tile rubble piles
 *     — two seed variants so adjacent destroyed walls don't look identical).
 *
 * Each variant is a procedural rubble pile generated from a seeded RNG
 * so the layout is deterministic. The pile is a mix of:
 *   • Small "rocks" (boxes / icosahedra), randomly positioned within
 *     a footprint, randomly rotated and scaled. Material is sampled
 *     from the variant's `materials` list.
 *   • Optional hand-placed "chunks" (signature bits — broken barrel,
 *     leaning wall stub) that anchor the silhouette so the rubble
 *     stays recognizable at sprite size.
 *
 * The "pile" shape comes from a height envelope: max-y at the center,
 * dropping toward the edges. Each rock's y is a random fraction of the
 * envelope at its (x, z), so rocks cluster taller in the middle.
 *
 * Same shape as tower-scene.ts / wall-scene.ts / house-scene.ts:
 *   • `VARIANTS`, `PALETTE`
 *   • `buildDebris(THREE, scene, variant)` — THREE is injected so the
 *     module stays free of a static three.js dependency. Takes the FULL
 *     variant object (not just `.params`) because the internal
 *     `debrisLayout` inspects `.source` for ground-shadow decisions.
 *   • `variantReport` for sanity checks.
 *
 * The debris entity manager (see `../entities/debris.ts`) is the only
 * production caller — it picks the right variant per dead cannon /
 * tower / wall and positions one host group per debris instance.
 */

import type * as THREE from "three";
import { BOUND_EPS, FRUSTUM_HALF } from "./sprite-bounds.ts";
import {
  createMaterial,
  findVariant,
  type MaterialSpec,
} from "./sprite-kit.ts";
import {
  BAND_GREEN,
  FLAG_BASE,
  WALL_STONE_DARK,
  WALL_STONE_LIGHT,
  WALL_STONE_MAIN,
  WOOD_DARK,
} from "./sprite-materials.ts";

export type PieceShape = "box" | "cylinder" | "icosahedron" | "sphere";

export interface PieceDims {
  width?: number;
  height?: number;
  depth?: number;
  radius?: number;
  radiusTop?: number;
  radiusBottom?: number;
  segments?: number;
  widthSegments?: number;
  heightSegments?: number;
}

export interface ChunkSpec {
  shape: PieceShape;
  dims: PieceDims;
  pos: readonly [number, number, number];
  rot?: readonly [number, number, number];
  scale?: readonly [number, number, number];
  material: MaterialSpec;
}

export interface RocksSpec {
  count: number;
  footprint: { width: number; depth: number };
  sizeRange: readonly [number, number];
  maxHeight: number;
  flatness: readonly [number, number];
  /** Frequency-weighted material list. Higher weight → picked more often. */
  materials: ReadonlyArray<readonly [MaterialSpec, number]>;
  shapes?: readonly ("box" | "icosahedron")[];
}

export interface VariantParams {
  seed: number;
  rocks: RocksSpec;
  chunks?: ChunkSpec[];
}

export interface VariantDescriptor {
  name: string;
  label: string;
  /** Reference to the cannon/tower/wall the debris replaces. Consumed by
   *  `buildDebris` to decide whether to drop a ground shadow (cannons
   *  had one, towers and walls don't). */
  source: string;
  canvasPx: number;
  params: VariantParams;
}

export interface LayoutPiece {
  shape: PieceShape;
  dims: PieceDims;
  pos: readonly [number, number, number];
  rot?: readonly [number, number, number];
  scale?: readonly [number, number, number];
  material: MaterialSpec;
}

export interface VariantReport {
  name: string;
  source: string;
  pieceCount: number;
  rockCount: number;
  chunkCount: number;
  warnings: string[];
}

// ---------- scene-local materials ----------
const STONE_DARK: MaterialSpec = {
  kind: "standard",
  color: 0x2a2a28,
  roughness: 0.85,
  metalness: 0.1,
};
const STONE_MID: MaterialSpec = {
  kind: "standard",
  color: 0x4a4a48,
  roughness: 0.85,
  metalness: 0.1,
};
const STONE_LIGHT: MaterialSpec = {
  kind: "standard",
  color: 0x7a7a78,
  roughness: 0.85,
  metalness: 0.1,
};
const BARREL_DARK: MaterialSpec = {
  kind: "standard",
  color: 0x2a2a28,
  roughness: 0.4,
  metalness: 0.8,
};
const BARREL_MID: MaterialSpec = {
  kind: "standard",
  color: 0x4a4a48,
  roughness: 0.4,
  metalness: 0.8,
};
const BARREL_LIGHT: MaterialSpec = {
  kind: "standard",
  color: 0x7a7a78,
  roughness: 0.4,
  metalness: 0.8,
};
// Rampart rubble materials — mirror the rampart-scene palette (metallic
// core + corner pillars + top-light cap) so a destroyed rampart reads as
// "forge parts scattered on the ground", distinct from regular cannon
// rubble.
const RAMPART_METAL_DARK: MaterialSpec = {
  kind: "standard",
  color: 0x52524e,
  roughness: 0.5,
  metalness: 0.8,
};
const RAMPART_METAL_MID: MaterialSpec = {
  kind: "standard",
  color: 0x91918d,
  roughness: 0.45,
  metalness: 0.85,
};
const RAMPART_METAL_LIGHT: MaterialSpec = {
  kind: "standard",
  color: 0xefefeb,
  roughness: 0.4,
  metalness: 0.85,
};
const WOOD_MID: MaterialSpec = {
  kind: "standard",
  color: 0x5a3820,
  roughness: 0.95,
  metalness: 0.0,
};
const ROOF_BLUE: MaterialSpec = {
  kind: "standard",
  color: 0x1c699d,
  roughness: 0.55,
  metalness: 0.25,
};
// Frequency-weighted material lists. Each entry: [material, weight].
// Higher weight → picked more often. Rare colors (bands, flag, blue)
// use small weights so they show as accents rather than dominate.
const CANNON_MATERIALS: ReadonlyArray<readonly [MaterialSpec, number]> = [
  [BARREL_DARK, 3],
  [BARREL_MID, 5],
  [BARREL_LIGHT, 4],
  [WOOD_DARK, 2],
  [WOOD_MID, 2],
  [BAND_GREEN, 1],
];
// Rampart rubble is pure metal + green accent — no wood, no barrel
// parts. Weights bias toward the mid shade (core metal); dark and light
// supply highlight/shadow contrast, and BAND_GREEN adds the emblem
// accent that makes the pile read as a wrecked rampart rather than a
// regular cannon.
const RAMPART_MATERIALS: ReadonlyArray<readonly [MaterialSpec, number]> = [
  [RAMPART_METAL_DARK, 3],
  [RAMPART_METAL_MID, 5],
  [RAMPART_METAL_LIGHT, 3],
  [BAND_GREEN, 1],
];
const TOWER_MATERIALS: ReadonlyArray<readonly [MaterialSpec, number]> = [
  [STONE_DARK, 3],
  [STONE_MID, 5],
  [STONE_LIGHT, 4],
  [WOOD_DARK, 1],
  [ROOF_BLUE, 2],
  [FLAG_BASE, 1],
];
// Wall rubble uses only stone tones — walls are pure masonry, no wood
// or roof tile. Weights bias toward the lit main shade.
const WALL_MATERIALS: ReadonlyArray<readonly [MaterialSpec, number]> = [
  [WALL_STONE_DARK, 3],
  [WALL_STONE_MAIN, 6],
  [WALL_STONE_LIGHT, 3],
];
export const VARIANTS: VariantDescriptor[] = [
  // ---- cannon debris (5) -------------------------------------------------
  {
    name: "tier_1_debris",
    label: "tier 1 debris",
    source: "tier_1",
    canvasPx: 64,
    params: {
      seed: 0xc1a1,
      rocks: {
        count: 28,
        footprint: { width: 1.5, depth: 1.375 },
        sizeRange: [0.16, 0.32],
        maxHeight: 0.3125,
        flatness: [0.3, 0.8],
        materials: CANNON_MATERIALS,
      },
      chunks: [
        // Broken barrel section — short cylinder lying on its side.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.2,
            radiusBottom: 0.2,
            height: 0.5625,
            segments: 16,
          },
          pos: [0.1, 0.2, -0.05],
          rot: [0, 0.45, Math.PI / 2 + 0.18],
          material: BARREL_MID,
        },
        // Second barrel fragment — shorter, tilted the opposite way.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.18,
            radiusBottom: 0.18,
            height: 0.3,
            segments: 16,
          },
          pos: [0.35, 0.15, 0.3],
          rot: [0, -0.6, Math.PI / 2 - 0.35],
          material: BARREL_DARK,
        },
        // Broken wheel — short wide wooden cylinder lying on its side.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.32,
            radiusBottom: 0.32,
            height: 0.1,
            segments: 18,
          },
          pos: [-0.35, 0.1, -0.3],
          rot: [Math.PI / 2 - 0.25, 0.2, 0.1],
          material: WOOD_MID,
        },
        // Axle stub — dark metal cylinder emerging through the wheel.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.05,
            radiusBottom: 0.05,
            height: 0.22,
            segments: 10,
          },
          pos: [-0.35, 0.12, -0.3],
          rot: [Math.PI / 2 - 0.25, 0.2, 0.1],
          material: BARREL_DARK,
        },
        // Splintered carriage plank — elongated wooden box.
        {
          shape: "box",
          dims: { width: 0.5, height: 0.08, depth: 0.14 },
          pos: [-0.1, 0.05, 0.35],
          rot: [0.1, 0.7, 0.05],
          material: WOOD_DARK,
        },
        // Cascabel — small dark sphere, remnant of the breech end.
        {
          shape: "sphere",
          dims: { radius: 0.11, widthSegments: 12, heightSegments: 8 },
          pos: [-0.4, 0.12, 0.05],
          material: BARREL_DARK,
        },
        // Trunnion stub — short perpendicular cylinder near the barrel.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.06,
            radiusBottom: 0.06,
            height: 0.18,
            segments: 10,
          },
          pos: [0.22, 0.08, -0.3],
          rot: [0, 0, Math.PI / 2 + 0.15],
          material: BARREL_MID,
        },
        // Single reinforcement band, snapped off and tilted.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.22,
            radiusBottom: 0.22,
            height: 0.0625,
            segments: 20,
          },
          pos: [-0.15, 0.04, -0.1],
          rot: [Math.PI / 2 + 0.15, 0.1, 0.2],
          material: BAND_GREEN,
        },
      ],
    },
  },
  {
    name: "tier_2_debris",
    label: "tier 2 debris",
    source: "tier_2",
    canvasPx: 64,
    params: {
      seed: 0xc1a2,
      rocks: {
        count: 112,
        footprint: { width: 1.5, depth: 1.375 },
        sizeRange: [0.12, 0.28],
        maxHeight: 0.375,
        flatness: [0.4, 0.95],
        materials: [
          [BARREL_MID, 4],
          [BARREL_LIGHT, 4],
          [STONE_MID, 3],
          [BARREL_DARK, 2],
          [WOOD_DARK, 1],
        ],
      },
      chunks: [
        // Half of the metal block, tilted.
        {
          shape: "box",
          dims: { width: 0.5, height: 0.3125, depth: 0.375 },
          pos: [-0.05, 0.16, 0.05],
          rot: [0.1, 0.3, -0.08],
          material: BARREL_MID,
        },
        // Broken barrel, shorter and tilted further.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.18,
            radiusBottom: 0.18,
            height: 0.375,
            segments: 16,
          },
          pos: [0.3, 0.18, -0.2],
          rot: [0, -0.35, Math.PI / 2 + 0.4],
          material: BARREL_LIGHT,
        },
      ],
    },
  },
  {
    name: "tier_3_debris",
    label: "tier 3 debris",
    source: "tier_3",
    canvasPx: 64,
    params: {
      seed: 0xc1a3,
      rocks: {
        count: 128,
        footprint: { width: 1.5, depth: 1.5 },
        sizeRange: [0.13, 0.3],
        maxHeight: 0.4375,
        flatness: [0.4, 0.95],
        materials: [
          [BARREL_MID, 4],
          [BARREL_LIGHT, 4],
          [STONE_MID, 3],
          [BARREL_DARK, 2],
          [WOOD_DARK, 1],
        ],
      },
      chunks: [
        {
          shape: "box",
          dims: { width: 0.625, height: 0.375, depth: 0.5 },
          pos: [0.0, 0.18, 0.1],
          rot: [-0.1, 0.2, 0.08],
          material: BARREL_MID,
        },
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.22,
            radiusBottom: 0.22,
            height: 0.4375,
            segments: 16,
          },
          pos: [-0.3, 0.2, -0.25],
          rot: [0, 0.5, Math.PI / 2 - 0.3],
          material: BARREL_LIGHT,
        },
      ],
    },
  },
  {
    name: "super_gun_debris",
    label: "super gun debris",
    source: "super_gun",
    canvasPx: 64,
    params: {
      seed: 0xc1a4,
      rocks: {
        count: 40,
        footprint: { width: 1.5, depth: 1.5 },
        sizeRange: [0.2, 0.4],
        maxHeight: 0.5,
        flatness: [0.3, 0.85],
        materials: [
          [BARREL_MID, 4],
          [BARREL_LIGHT, 4],
          [STONE_MID, 3],
          [BARREL_DARK, 2],
          [WOOD_DARK, 1],
          [BAND_GREEN, 1],
        ],
      },
      chunks: [
        // Massive broken breech block — the core of the gun.
        {
          shape: "box",
          dims: { width: 0.6875, height: 0.4375, depth: 0.5625 },
          pos: [0.05, 0.21, 0.1],
          rot: [-0.08, 0.2, 0.1],
          material: BARREL_MID,
        },
        // Main barrel section — long heavy cylinder lying at an angle.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.24,
            radiusBottom: 0.24,
            height: 0.65,
            segments: 16,
          },
          pos: [-0.35, 0.22, -0.25],
          rot: [0, 0.55, Math.PI / 2 - 0.2],
          material: BARREL_LIGHT,
        },
        // Second barrel shard — shorter, split further.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.2,
            radiusBottom: 0.2,
            height: 0.42,
            segments: 16,
          },
          pos: [0.4, 0.18, 0.35],
          rot: [0, -0.4, Math.PI / 2 + 0.35],
          material: BARREL_DARK,
        },
        // Large broken wheel — cannon carriage, lying on side.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.4,
            radiusBottom: 0.4,
            height: 0.12,
            segments: 20,
          },
          pos: [-0.4, 0.13, 0.4],
          rot: [Math.PI / 2 - 0.3, 0.3, 0.08],
          material: WOOD_MID,
        },
        // Axle stub through the wheel.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.07,
            radiusBottom: 0.07,
            height: 0.3,
            segments: 10,
          },
          pos: [-0.4, 0.15, 0.4],
          rot: [Math.PI / 2 - 0.3, 0.3, 0.08],
          material: BARREL_DARK,
        },
        // Splintered carriage beam.
        {
          shape: "box",
          dims: { width: 0.55, height: 0.09, depth: 0.16 },
          pos: [0.1, 0.06, -0.4],
          rot: [0.08, -0.5, 0.12],
          material: WOOD_DARK,
        },
        // Heavy trunnion stub — fatter than regular cannon.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.09,
            radiusBottom: 0.09,
            height: 0.24,
            segments: 12,
          },
          pos: [0.3, 0.1, -0.05],
          rot: [0, 0, Math.PI / 2 + 0.2],
          material: BARREL_MID,
        },
        // Cascabel ball — large dark sphere, breech remnant.
        {
          shape: "sphere",
          dims: { radius: 0.15, widthSegments: 14, heightSegments: 10 },
          pos: [-0.15, 0.15, -0.4],
          material: BARREL_DARK,
        },
        // Detached reinforcement band — green accent.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.26,
            radiusBottom: 0.26,
            height: 0.0625,
            segments: 20,
          },
          pos: [0.3, 0.04, -0.2],
          rot: [Math.PI / 2 + 0.1, 0.1, -0.15],
          material: BAND_GREEN,
        },
      ],
    },
  },
  {
    name: "mortar_debris",
    label: "mortar debris",
    source: "mortar",
    canvasPx: 64,
    params: {
      seed: 0xc1a5,
      rocks: {
        count: 32,
        footprint: { width: 1.5, depth: 1.375 },
        sizeRange: [0.18, 0.34],
        maxHeight: 0.4375,
        flatness: [0.3, 0.85],
        materials: [
          [BARREL_MID, 4],
          [BARREL_LIGHT, 3],
          [STONE_MID, 3],
          [BARREL_DARK, 2],
        ],
      },
      chunks: [
        // Cubic block half — mortar's signature short stocky block.
        {
          shape: "box",
          dims: { width: 0.5625, height: 0.3125, depth: 0.5625 },
          pos: [0.0, 0.16, 0.0],
          rot: [0.05, 0.2, -0.04],
          material: BARREL_MID,
        },
        // Stub of the short fat barrel — vertical, snapped.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.26,
            radiusBottom: 0.28,
            height: 0.28,
            segments: 18,
          },
          pos: [-0.28, 0.14, 0.25],
          rot: [0.15, 0, 0.22],
          material: BARREL_LIGHT,
        },
        // Second fat barrel fragment — wider, tipped over.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.22,
            radiusBottom: 0.22,
            height: 0.26,
            segments: 16,
          },
          pos: [0.35, 0.16, -0.3],
          rot: [Math.PI / 2 - 0.2, 0.3, 0.0],
          material: BARREL_DARK,
        },
        // Broken square base plate — chunk of the mortar bed.
        {
          shape: "box",
          dims: { width: 0.38, height: 0.08, depth: 0.3 },
          pos: [0.25, 0.04, 0.35],
          rot: [0.05, 0.4, -0.08],
          material: STONE_MID,
        },
        // Corner trunnion peg — stubby cylinder.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.07,
            radiusBottom: 0.07,
            height: 0.2,
            segments: 10,
          },
          pos: [-0.4, 0.1, -0.35],
          rot: [0.2, 0, Math.PI / 2 - 0.1],
          material: BARREL_MID,
        },
        // Heavy cascabel / fuse plug sphere.
        {
          shape: "sphere",
          dims: { radius: 0.12, widthSegments: 12, heightSegments: 8 },
          pos: [0.15, 0.12, -0.4],
          material: BARREL_DARK,
        },
      ],
    },
  },
  {
    name: "rampart_debris",
    label: "rampart debris",
    source: "rampart_cannon",
    canvasPx: 64,
    params: {
      seed: 0xc1a6,
      rocks: {
        count: 26,
        footprint: { width: 1.5, depth: 1.375 },
        sizeRange: [0.16, 0.32],
        maxHeight: 0.3125,
        flatness: [0.3, 0.8],
        materials: RAMPART_MATERIALS,
      },
      chunks: [
        // Broken core block — the rampart's metal heart, tipped over.
        {
          shape: "box",
          dims: { width: 0.5, height: 0.3, depth: 0.5 },
          pos: [0.05, 0.15, -0.05],
          rot: [0.12, 0.35, 0.08],
          material: RAMPART_METAL_MID,
        },
        // Snapped corner pillar — short metal stub leaning.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.13,
            radiusBottom: 0.13,
            height: 0.35,
            segments: 12,
          },
          pos: [-0.35, 0.18, 0.3],
          rot: [Math.PI / 2 - 0.4, 0.15, 0.2],
          material: RAMPART_METAL_DARK,
        },
        // Second corner pillar fragment — shorter, leaning opposite.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.1,
            radiusBottom: 0.1,
            height: 0.24,
            segments: 12,
          },
          pos: [0.38, 0.14, -0.3],
          rot: [Math.PI / 2 - 0.3, -0.2, -0.25],
          material: RAMPART_METAL_DARK,
        },
        // Twisted metal plate — thin bent sheet.
        {
          shape: "box",
          dims: { width: 0.42, height: 0.05, depth: 0.28 },
          pos: [-0.1, 0.05, 0.4],
          rot: [0.08, 0.6, -0.14],
          material: RAMPART_METAL_LIGHT,
        },
        // Second plate fragment — angular shard.
        {
          shape: "box",
          dims: { width: 0.28, height: 0.04, depth: 0.2 },
          pos: [0.3, 0.04, 0.25],
          rot: [0.25, -0.4, 0.2],
          material: RAMPART_METAL_MID,
        },
        // Rivet head sphere — small metal ball.
        {
          shape: "sphere",
          dims: { radius: 0.08, widthSegments: 10, heightSegments: 6 },
          pos: [-0.35, 0.1, -0.2],
          material: RAMPART_METAL_LIGHT,
        },
        // Detached emblem band — green accent tilted on the pile.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.24,
            radiusBottom: 0.24,
            height: 0.07,
            segments: 20,
          },
          pos: [0.18, 0.04, -0.15],
          rot: [Math.PI / 2 + 0.2, 0.1, 0.25],
          material: BAND_GREEN,
        },
      ],
    },
  },
  // ---- tower debris (2) --------------------------------------------------
  {
    name: "secondary_tower_debris",
    label: "secondary tower debris",
    source: "secondary_tower",
    canvasPx: 64,
    params: {
      seed: 0xc1a6,
      rocks: {
        count: 102,
        footprint: { width: 1.625, depth: 1.5 },
        sizeRange: [0.16, 0.32],
        maxHeight: 0.375,
        flatness: [0.35, 0.9],
        materials: TOWER_MATERIALS,
      },
      chunks: [
        // Half of the keep wall — leaning chunk.
        {
          shape: "box",
          dims: { width: 0.5625, height: 0.3125, depth: 0.1875 },
          pos: [-0.05, 0.15, -0.1],
          rot: [-0.1, 0.2, 0.18],
          material: STONE_LIGHT,
        },
        // Second keep-wall fragment — shorter, tilted opposite.
        {
          shape: "box",
          dims: { width: 0.4, height: 0.26, depth: 0.17 },
          pos: [0.35, 0.13, 0.3],
          rot: [0.08, -0.25, -0.2],
          material: STONE_MID,
        },
        // Crenellation merlon — small square battlement block.
        {
          shape: "box",
          dims: { width: 0.14, height: 0.14, depth: 0.14 },
          pos: [-0.05, 0.36, -0.1],
          rot: [-0.05, 0.2, 0.12],
          material: STONE_LIGHT,
        },
        // Second merlon, fallen away from the wall.
        {
          shape: "box",
          dims: { width: 0.13, height: 0.13, depth: 0.13 },
          pos: [-0.35, 0.07, 0.1],
          rot: [0.35, 0.1, 0.5],
          material: STONE_MID,
        },
        // A snapped-off blue roof shard on top.
        {
          shape: "box",
          dims: { width: 0.3125, height: 0.0625, depth: 0.1875 },
          pos: [0.1, 0.34, -0.05],
          rot: [-0.2, 0.3, -0.12],
          material: ROOF_BLUE,
        },
        // Second roof shard — narrower, tipped far.
        {
          shape: "box",
          dims: { width: 0.22, height: 0.05, depth: 0.14 },
          pos: [-0.3, 0.05, -0.3],
          rot: [0.5, 0.3, 0.6],
          material: ROOF_BLUE,
        },
        // Arch stone — wedge-shaped keystone, part of a window arch.
        {
          shape: "box",
          dims: { width: 0.2, height: 0.12, depth: 0.14 },
          pos: [0.25, 0.08, -0.35],
          rot: [0.25, -0.3, 0.18],
          material: STONE_DARK,
        },
        // Broken pole stub.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.018,
            radiusBottom: 0.018,
            height: 0.1875,
            segments: 8,
          },
          pos: [0.2, 0.1, 0.3],
          rot: [-Math.PI / 2 + 0.4, 0.0, 0.5],
          material: WOOD_DARK,
        },
      ],
    },
  },
  {
    name: "home_tower_debris",
    label: "home tower debris",
    source: "home_tower",
    canvasPx: 64,
    params: {
      seed: 0xc1a7,
      rocks: {
        count: 126,
        footprint: { width: 1.625, depth: 1.625 },
        sizeRange: [0.17, 0.34],
        maxHeight: 0.4375,
        flatness: [0.35, 0.9],
        materials: [
          [STONE_DARK, 3],
          [STONE_MID, 5],
          [STONE_LIGHT, 4],
          [WOOD_DARK, 1],
          [ROOF_BLUE, 2],
          [FLAG_BASE, 1],
        ],
      },
      chunks: [
        // Main keep-wall chunk — leaning slab.
        {
          shape: "box",
          dims: { width: 0.625, height: 0.3125, depth: 0.1875 },
          pos: [-0.1, 0.17, -0.1],
          rot: [-0.06, 0.1, 0.14],
          material: STONE_LIGHT,
        },
        // Second wall chunk.
        {
          shape: "box",
          dims: { width: 0.375, height: 0.3125, depth: 0.1875 },
          pos: [0.3, 0.14, 0.2],
          rot: [0.08, -0.2, -0.18],
          material: STONE_MID,
        },
        // Third wall fragment — shorter, different angle.
        {
          shape: "box",
          dims: { width: 0.32, height: 0.24, depth: 0.17 },
          pos: [-0.35, 0.13, 0.3],
          rot: [0.1, 0.5, -0.12],
          material: STONE_DARK,
        },
        // Crenellation merlons — three battlement cubes fallen away.
        {
          shape: "box",
          dims: { width: 0.15, height: 0.15, depth: 0.15 },
          pos: [0.0, 0.37, -0.1],
          rot: [-0.08, 0.15, 0.1],
          material: STONE_LIGHT,
        },
        {
          shape: "box",
          dims: { width: 0.14, height: 0.14, depth: 0.14 },
          pos: [0.4, 0.08, -0.38],
          rot: [0.4, 0.2, 0.5],
          material: STONE_MID,
        },
        {
          shape: "box",
          dims: { width: 0.13, height: 0.13, depth: 0.13 },
          pos: [-0.25, 0.07, -0.35],
          rot: [0.3, 0.5, -0.2],
          material: STONE_LIGHT,
        },
        // Arch keystone — wedge from the gateway.
        {
          shape: "box",
          dims: { width: 0.22, height: 0.14, depth: 0.16 },
          pos: [0.1, 0.08, 0.4],
          rot: [0.18, 0.3, -0.15],
          material: STONE_DARK,
        },
        // Two roof shards.
        {
          shape: "box",
          dims: { width: 0.375, height: 0.0625, depth: 0.1875 },
          pos: [-0.2, 0.36, 0.1],
          rot: [-0.18, 0.4, -0.22],
          material: ROOF_BLUE,
        },
        {
          shape: "box",
          dims: { width: 0.25, height: 0.0625, depth: 0.1875 },
          pos: [0.28, 0.32, -0.2],
          rot: [0.3, -0.2, 0.12],
          material: ROOF_BLUE,
        },
        // Third roof shard — tipped flat on the pile.
        {
          shape: "box",
          dims: { width: 0.2, height: 0.05, depth: 0.13 },
          pos: [-0.38, 0.04, -0.1],
          rot: [0.55, 0.3, 0.4],
          material: ROOF_BLUE,
        },
        // Broken pole stub.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.02,
            radiusBottom: 0.02,
            height: 0.25,
            segments: 8,
          },
          pos: [0.1, 0.12, 0.4],
          rot: [-Math.PI / 2 + 0.3, 0.0, 0.6],
          material: WOOD_DARK,
        },
        // Torn flag fragment — long thin slab lying near the pole stub,
        // identifying this pile as the home tower. Named "flag" so the
        // entity manager can tint it per-owner (see debris.ts).
        {
          shape: "box",
          dims: { width: 0.3125, height: 0.03125, depth: 0.1875 },
          pos: [-0.3, 0.02, 0.3],
          rot: [0.05, 0.65, -0.12],
          material: FLAG_BASE,
        },
      ],
    },
  },
  // ---- wall debris (2) ----------------------------------------------------
  // 1×1 tile rubble piles. Two seed variants so adjacent destroyed walls
  // don't look identical; the engine picks by tile hash.
  {
    name: "wall_debris_a",
    label: "wall debris (A)",
    source: "wall",
    canvasPx: 32,
    params: {
      seed: 0xda11,
      rocks: {
        // In-game a 1×1 tile is only ~16 world pixels wide, so rocks
        // must be several world pixels across (sizeRange authored * 8
        // = world pixels) to read as individual pieces rather than
        // dithered noise. Paired with the full-tile base plate below,
        // a modest count of larger rocks reads as chunky rubble.
        count: 55,
        footprint: { width: 1.8, depth: 1.8 },
        sizeRange: [0.22, 0.42],
        maxHeight: 0.5,
        flatness: [0.45, 0.95],
        materials: WALL_MATERIALS,
      },
    },
  },
  {
    name: "wall_debris_b",
    label: "wall debris (B)",
    source: "wall",
    canvasPx: 32,
    params: {
      seed: 0xda12,
      rocks: {
        count: 70,
        footprint: { width: 1.8, depth: 1.8 },
        sizeRange: [0.22, 0.42],
        maxHeight: 0.5,
        flatness: [0.45, 0.95],
        materials: WALL_MATERIALS,
      },
    },
  },
];
// ---------- palette ----------------------------------------------------
// Combines the cannon and tower color sets — every variant quantizes to
// the same shared palette regardless of which materials it uses.
export const PALETTE: [number, number, number][] = [
  // stone / iron greys (tower, cannon)
  [0x2a, 0x2a, 0x28],
  [0x4a, 0x4a, 0x48],
  [0x7a, 0x7a, 0x78],
  // lighter stones — wall palette
  [0x6a, 0x6a, 0x65],
  [0x8a, 0x8a, 0x85],
  [0xa5, 0xa5, 0xa0],
  // wood
  [0x3a, 0x24, 0x10],
  [0x5a, 0x38, 0x20],
  [0x8a, 0x58, 0x30],
  // band green
  [0x3a, 0x5a, 0x28],
  // roof blue
  [0x0d, 0x3a, 0x6a],
  [0x1c, 0x69, 0x9d],
  [0x5a, 0xa0, 0xd0],
  // flag red
  [0x80, 0x1a, 0x1a],
  [0xb0, 0x2a, 0x2a],
  [0xd8, 0x50, 0x40],
  // dark accent
  [0x0a, 0x0a, 0x0a],
];

/** Look up a variant by name — matches the API of other scene files. */
export function getDebrisVariant(name: string): VariantDescriptor | undefined {
  return findVariant(VARIANTS, name);
}

/**
 * Sanity-check footprint vs ±1 canvas. Doesn't try to validate the
 * pile's "realism" — that's a visual judgment.
 */
export function variantReport(variant: VariantDescriptor): VariantReport {
  const warnings: string[] = [];
  const footprint = variant.params.rocks.footprint;
  const halfW = footprint.width / 2;
  const halfD = footprint.depth / 2;
  if (halfW > FRUSTUM_HALF + BOUND_EPS || halfD > FRUSTUM_HALF + BOUND_EPS) {
    warnings.push(
      `footprint (${footprint.width}×${footprint.depth}) leaves the ±${FRUSTUM_HALF} canvas`,
    );
  }
  // Chunks should also stay roughly inside the canvas (rough bound: pos ± 0.6).
  for (const chunk of variant.params.chunks ?? []) {
    const [xPos, , zPos] = chunk.pos;
    if (Math.abs(xPos) > 0.95 || Math.abs(zPos) > 0.95) {
      warnings.push(
        `chunk at (${xPos.toFixed(2)}, ${zPos.toFixed(2)}) sits near/past canvas edge`,
      );
    }
  }
  const layout = debrisLayout(variant);
  return {
    name: variant.name,
    source: variant.source,
    pieceCount: layout.length,
    rockCount: variant.params.rocks.count,
    chunkCount: variant.params.chunks?.length ?? 0,
    warnings,
  };
}

/**
 * Build the rubble pile for `variant` under `scene`. Takes the FULL
 * variant object (not just `.params`) because ground-shadow gating
 * consults `.source`.
 */
export function buildDebris(
  three: typeof THREE,
  scene: THREE.Scene | THREE.Group,
  variant: VariantDescriptor,
): void {
  const mat = (spec: MaterialSpec): THREE.Material => createMaterial(spec);

  // Wall rubble: add an opaque full-tile base plate under the rocks so
  // grass doesn't show through the gaps between pieces. Uses the
  // brightest wall stone tone and sits just above the terrain plane (y
  // slightly > 0) so rock bottoms at y=0 don't z-fight with it.
  if (variant.source === "wall") {
    const plate = new three.Mesh(
      new three.BoxGeometry(2, 0.02, 2),
      mat(WALL_STONE_LIGHT),
    );
    plate.position.set(0, 0.01, 0);
    scene.add(plate);
  }

  const pieces = debrisLayout(variant);
  for (const piece of pieces) {
    const mesh = new three.Mesh(
      createPieceGeometry(three, piece),
      mat(piece.material),
    );
    // Name the signature flag chunk so the entity manager can tint it
    // per-owner without walking material references. Matches the
    // `home_tower_debris` chunk that carries FLAG_BASE.
    if (piece.material === FLAG_BASE) mesh.name = "flag";
    mesh.position.set(piece.pos[0], piece.pos[1], piece.pos[2]);
    if (piece.rot) mesh.rotation.set(piece.rot[0], piece.rot[1], piece.rot[2]);
    if (piece.scale)
      mesh.scale.set(piece.scale[0], piece.scale[1], piece.scale[2]);
    scene.add(mesh);
  }
}

/**
 * Generate a deterministic list of pieces (rocks + chunks) to render.
 * Each entry has the shape: { shape, dims, pos, rot, scale?, material }.
 */
export function debrisLayout(variant: VariantDescriptor): LayoutPiece[] {
  const params = variant.params;
  const rocks = params.rocks;
  const rng = mulberry32(params.seed);
  const shapes: readonly ("box" | "icosahedron")[] = rocks.shapes ?? [
    "box",
    "icosahedron",
  ];
  const totalWeight = rocks.materials.reduce(
    (sum, [, weight]) => sum + weight,
    0,
  );
  const pickMaterial = (): MaterialSpec => {
    let roll = rng() * totalWeight;
    for (const [material, weight] of rocks.materials) {
      roll -= weight;
      if (roll <= 0) return material;
    }
    return rocks.materials[rocks.materials.length - 1]![0];
  };
  const lerp = (low: number, high: number, fraction: number): number =>
    low + (high - low) * fraction;

  const halfW = rocks.footprint.width / 2;
  const halfD = rocks.footprint.depth / 2;
  // Envelope radius — distance from center beyond which y-cap drops to 0.
  // Use the longer axis so corner rocks aren't squashed by the envelope.
  const envR = Math.hypot(halfW, halfD);

  const out: LayoutPiece[] = [];
  for (let i = 0; i < rocks.count; i++) {
    // Polar sample inside an ellipse inscribed in the footprint —
    // rocks spread in a round heap rather than filling the rectangle
    // out to the corners. `sqrt(rng())` keeps area density uniform so
    // the pile stays as full as it was under rectangular sampling.
    const angle = rng() * Math.PI * 2;
    const norm = Math.sqrt(rng());
    const xPos = Math.cos(angle) * norm * halfW;
    const zPos = Math.sin(angle) * norm * halfD;
    const radius = Math.hypot(xPos, zPos);
    const yEnvelope = rocks.maxHeight * Math.max(0, 1 - radius / envR);
    // Random share of the local envelope so rocks scatter at different
    // heights instead of all peaking at yEnvelope.
    const yTop = yEnvelope * lerp(0.25, 1.0, rng());

    const baseSize = lerp(rocks.sizeRange[0], rocks.sizeRange[1], rng());
    const flatness = lerp(rocks.flatness[0], rocks.flatness[1], rng());
    const sizeY = baseSize * flatness;
    // Sit so the rock's bottom is at max(0, yTop - sizeY) — i.e. each
    // rock rests on the envelope at its (x, z), with its center
    // offset upward by sizeY/2.
    const yCenter = Math.max(sizeY / 2, yTop - sizeY / 2);

    const shape = shapes[Math.floor(rng() * shapes.length)]!;
    out.push({
      shape,
      dims: { width: baseSize, height: sizeY, depth: baseSize },
      pos: [xPos, yCenter, zPos],
      rot: [rng() * Math.PI, rng() * Math.PI, rng() * Math.PI],
      material: pickMaterial(),
    });
  }

  if (params.chunks) for (const chunk of params.chunks) out.push(chunk);
  return out;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let result = Math.imul(state ^ (state >>> 15), 1 | state);
    result =
      (result + Math.imul(result ^ (result >>> 7), 61 | result)) ^ result;
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function createPieceGeometry(
  three: typeof THREE,
  piece: LayoutPiece,
): THREE.BufferGeometry {
  const dims = piece.dims;
  switch (piece.shape) {
    case "box":
      return new three.BoxGeometry(dims.width, dims.height, dims.depth);
    case "cylinder":
      return new three.CylinderGeometry(
        dims.radiusTop,
        dims.radiusBottom,
        dims.height,
        dims.segments ?? 16,
      );
    case "sphere":
      return new three.SphereGeometry(
        dims.radius,
        dims.widthSegments ?? 12,
        dims.heightSegments ?? 8,
      );
    case "icosahedron":
      // Inscribed in a sphere of radius ≈ width/2 — gives boxlike scale.
      return new three.IcosahedronGeometry((dims.width ?? 0.1) / 2, 0);
    default: {
      const exhaustive: never = piece.shape;
      throw new Error(`unknown piece shape: ${exhaustive as string}`);
    }
  }
}
