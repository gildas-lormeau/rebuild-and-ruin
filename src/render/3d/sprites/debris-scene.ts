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
        count: 88,
        footprint: { width: 1.5, depth: 1.375 },
        sizeRange: [0.1, 0.22],
        maxHeight: 0.3125,
        flatness: [0.4, 0.9],
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
        // Single reinforcement band, snapped off and tilted.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.22,
            radiusBottom: 0.22,
            height: 0.0625,
            segments: 20,
          },
          pos: [-0.3, 0.08, 0.3],
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
        count: 200,
        footprint: { width: 1.5, depth: 1.5 },
        sizeRange: [0.13, 0.32],
        maxHeight: 0.5,
        flatness: [0.4, 0.95],
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
        {
          shape: "box",
          dims: { width: 0.6875, height: 0.4375, depth: 0.5625 },
          pos: [0.05, 0.21, 0.1],
          rot: [-0.08, 0.2, 0.1],
          material: BARREL_MID,
        },
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.24,
            radiusBottom: 0.24,
            height: 0.5625,
            segments: 16,
          },
          pos: [-0.35, 0.22, -0.25],
          rot: [0, 0.55, Math.PI / 2 - 0.2],
          material: BARREL_LIGHT,
        },
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.26,
            radiusBottom: 0.26,
            height: 0.0625,
            segments: 20,
          },
          pos: [0.35, 0.06, -0.4],
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
        count: 104,
        footprint: { width: 1.5, depth: 1.375 },
        sizeRange: [0.12, 0.26],
        maxHeight: 0.4375,
        flatness: [0.4, 0.95],
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
        // Stub of the short fat barrel, lying on its side.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.2,
            radiusBottom: 0.2,
            height: 0.3125,
            segments: 16,
          },
          pos: [-0.2, 0.2, 0.3],
          rot: [Math.PI / 2 + 0.2, 0, 0.1],
          material: BARREL_LIGHT,
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
        count: 88,
        footprint: { width: 1.5, depth: 1.375 },
        sizeRange: [0.1, 0.22],
        maxHeight: 0.3125,
        flatness: [0.4, 0.9],
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
        // Detached emblem band — green accent tilted on the pile.
        {
          shape: "cylinder",
          dims: {
            radiusTop: 0.24,
            radiusBottom: 0.24,
            height: 0.07,
            segments: 20,
          },
          pos: [0.3, 0.08, 0.3],
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
        count: 144,
        footprint: { width: 1.625, depth: 1.5 },
        sizeRange: [0.1, 0.24],
        maxHeight: 0.375,
        flatness: [0.45, 1.0],
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
        // A snapped-off blue roof shard on top.
        {
          shape: "box",
          dims: { width: 0.3125, height: 0.0625, depth: 0.1875 },
          pos: [0.1, 0.34, -0.05],
          rot: [-0.2, 0.3, -0.12],
          material: ROOF_BLUE,
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
        count: 224,
        footprint: { width: 1.625, depth: 1.625 },
        sizeRange: [0.1, 0.26],
        maxHeight: 0.4375,
        flatness: [0.45, 1.0],
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
        {
          shape: "box",
          dims: { width: 0.625, height: 0.3125, depth: 0.1875 },
          pos: [-0.1, 0.17, -0.1],
          rot: [-0.06, 0.1, 0.14],
          material: STONE_LIGHT,
        },
        {
          shape: "box",
          dims: { width: 0.375, height: 0.3125, depth: 0.1875 },
          pos: [0.3, 0.14, 0.2],
          rot: [0.08, -0.2, -0.18],
          material: STONE_MID,
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
        // Torn flag fragment — long thin red slab lying near the pole
        // stub, identifying this pile as the home tower. Named "flag"
        // so the entity manager can tint it per-owner (see debris.ts).
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
        count: 260,
        // Footprint widened to 1.96 so rocks reach the tile edges
        // (halfW 0.98 + 0.707·minSize 0.10 = 1.05 at max rotation, but
        // typical rocks sit inside ±1). Paired with a smaller max size
        // than before (0.20 vs 0.24) so corner rocks don't poke as far
        // beyond the ±1 frustum.
        footprint: { width: 1.96, depth: 1.96 },
        sizeRange: [0.1, 0.2],
        maxHeight: 0.25,
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
        count: 310,
        footprint: { width: 1.96, depth: 1.96 },
        sizeRange: [0.1, 0.2],
        maxHeight: 0.25,
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
    const xPos = (rng() * 2 - 1) * halfW;
    const zPos = (rng() * 2 - 1) * halfD;
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
