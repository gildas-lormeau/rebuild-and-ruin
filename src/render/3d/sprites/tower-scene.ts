/**
 * tower-scene.ts — shared tower scene description.
 *
 * TypeScript conversion of the original `tower-scene.mjs` used by the
 * `build-tower-3d.html` sandbox. Two real variants are exported:
 * `home_tower` (with gate + 3 flags + door) and `secondary_tower`
 * (no gate, single main flag).
 *
 * Geometry model (from the user's ASCII schematic):
 *   • A wide rectangular main keep with a FLAT blue roof.
 *   • Two narrower, TALLER square turrets flanking the keep on its
 *     left and right sides (they rise above the keep's roof).
 *   • A small pole-platform centered on the keep's roof, with a thin
 *     pole and a small pennant flag attached near the top of the pole.
 *   • Optional door slit on the +Z face of the keep.
 *
 * No base disc — towers sit directly on the ground (yBase defaults 0).
 * THREE is injected so this module stays free of three.js as a static
 * dependency (matches wall-scene.ts's `buildWall(THREE, scene, params)`
 * convention).
 *
 * Per-player tinting (new in Phase 3): the pennant/flag meshes are
 * named `"flag"` on the THREE.Group so the towers entity manager can
 * recolor their material after `buildTower` returns without rewriting
 * scene geometry. Nothing else is recolored yet — the stone body keeps
 * its generic limestone look, matching the sprite previews.
 */

import * as THREE from "three";
import { createTiledCanvasTexture } from "./procedural-texture.ts";
import { BOUND_EPS, FRUSTUM_HALF } from "./sprite-bounds.ts";
import {
  applyBoxWallUV,
  CELL,
  cells,
  createMaterial,
  findVariant,
  type MaterialSpec,
} from "./sprite-kit.ts";
import { FLAG_RED, MERLON_AO, WOOD_DARK } from "./sprite-materials.ts";

export interface TexturedSpec extends MaterialSpec {
  texture?: "stone" | "door" | "roof";
}

export type FlagSide = "+x" | "-x" | "+z" | "-z";

export interface FlagParams {
  width: number;
  height: number;
  /** Pennant Y center, measured from the pole's top (negative → below tip). */
  yOffset: number;
  /** Which side of the pole the flag sticks out toward. Default "+x". */
  side?: FlagSide;
  material: MaterialSpec;
}

export interface PoleParams {
  radius: number;
  height: number;
  material: MaterialSpec;
  flag?: FlagParams;
}

export interface PolePlatformParams {
  width: number;
  depth: number;
  height: number;
  /** [dx, dz] from turret center. Default [0, 0]. */
  offset?: readonly [number, number];
  material: MaterialSpec;
  pole?: PoleParams;
}

export type Corner = "NW" | "NE" | "SW" | "SE";

export interface CornerFlagSpec {
  corner: Corner;
  pole: PoleParams;
}

export interface ParapetClipSideSpec {
  xMin?: number;
  xMax?: number;
  zMin?: number;
  zMax?: number;
  exclude?: { lo: number; hi: number }[];
}

export interface ParapetClipSpec {
  N?: ParapetClipSideSpec;
  S?: ParapetClipSideSpec;
  E?: ParapetClipSideSpec;
  W?: ParapetClipSideSpec;
}

export type ParapetSide = "N" | "S" | "E" | "W";

export interface ParapetParams {
  height: number;
  thickness: number;
  material: MaterialSpec;
  merlons?: boolean;
  skipSides?: ParapetSide[];
  clip?: ParapetClipSpec;
}

export interface RoofParams {
  thickness: number;
  /** Default 1.06 — roof footprint is slightly larger than the walls. */
  eaveScale?: number;
  material: TexturedSpec;
  parapet?: ParapetParams;
}

export interface WindowParams {
  width: number;
  height: number;
  material: MaterialSpec;
}

export interface TurretParams {
  name?: string;
  /** World-X center of the turret. */
  x: number;
  /** World-Z center of the turret. */
  z: number;
  /** X extent of the walls. */
  width: number;
  /** Z extent of the walls. */
  depth: number;
  /** Body (wall) height in Y. */
  height: number;
  /** Default 0 — Y of the wall bottom. */
  yBase?: number;
  /** Default 0 — square corners. > 0 rounds the extruded outline. */
  cornerR?: number;
  /** Stone body shading. */
  material: TexturedSpec;
  /** Flat roof slab on top of the walls. */
  roof: RoofParams;
  /** Optional door/window on +Z face. */
  window?: WindowParams;
  /** Pole platform on roof (centered, or offset via polePlatform.offset). */
  polePlatform?: PolePlatformParams;
  /** Optional per-corner flagpoles rooted at the walltop. */
  cornerFlags?: CornerFlagSpec[];
}

export interface TowerParams {
  turrets: TurretParams[];
}

export interface Variant {
  name: string;
  label: string;
  canvasPx: number;
  params: TowerParams;
}

interface TurretFootprint {
  xMin: number;
  xMax: number;
  zMin: number;
  zMax: number;
}

interface RoofPlacement {
  width: number;
  depth: number;
  thickness: number;
  yCenter: number;
}

interface ParapetPlacement {
  side: ParapetSide;
  dims: { width: number; height: number; depth: number };
  pos: [number, number, number];
}

interface WindowPlacement {
  width: number;
  height: number;
  pos: [number, number, number];
}

interface PolePlatformPlacement {
  platform: {
    width: number;
    depth: number;
    height: number;
    pos: [number, number, number];
  };
  pole?: {
    radius: number;
    height: number;
    pos: [number, number, number];
  };
  poleMaterial?: MaterialSpec;
  flag?: {
    width: number;
    height: number;
    pos: [number, number, number];
    yaw: number;
    material: MaterialSpec;
  };
}

interface CornerFlagPlacement {
  corner: Corner;
  pole: {
    radius: number;
    height: number;
    pos: [number, number, number];
  };
  flag?: {
    width: number;
    height: number;
    pos: [number, number, number];
    yaw: number;
    material: MaterialSpec;
  };
}

interface PoleFlagResult {
  pole: { radius: number; height: number; pos: [number, number, number] };
  material: MaterialSpec;
  flag?: {
    width: number;
    height: number;
    pos: [number, number, number];
    yaw: number;
    material: MaterialSpec;
  };
}

export interface VariantReport {
  name: string;
  turrets: {
    name: string | undefined;
    x: number;
    z: number;
    width: number;
    depth: number;
    height: number;
    footprint: TurretFootprint;
    wallTopY: number;
  }[];
  warnings: string[];
}

interface UVGenerator {
  generateTopUV(
    geometry: THREE.ExtrudeGeometry,
    vertices: number[],
    iA: number,
    iB: number,
    iC: number,
  ): THREE.Vector2[];
  generateSideWallUV(
    geometry: THREE.ExtrudeGeometry,
    vertices: number[],
    iA: number,
    iB: number,
    iC: number,
    iD: number,
  ): THREE.Vector2[];
}

// ---------- scene-local materials ----------
const STONE_BODY: TexturedSpec = {
  kind: "standard",
  color: 0xffffff,
  roughness: 0.85,
  metalness: 0.15,
  texture: "stone",
};
// Same tint/shading as STONE_BODY but WITHOUT the stone texture map.
// Used on horizontal/top surfaces (turret tops, merlon tops, roof-slab
// side strips), on the thin merlon/parapet boxes themselves (where a
// 64×64 brick texture would render as one giant brick), and on rounded
// ExtrudeGeometry bodies where UVs aren't uniform-density.
const STONE_PLAIN: MaterialSpec = {
  kind: "standard",
  color: 0xffffff,
  roughness: 0.85,
  metalness: 0.15,
};
const ROOF_SLATE: TexturedSpec = {
  kind: "standard",
  color: 0x9ca6bb,
  roughness: 0.75,
  metalness: 0.1,
  texture: "roof",
};
const WINDOW_DARK: TexturedSpec = {
  kind: "basic",
  color: 0xffffff,
  side: "double",
  texture: "door",
};
const PLATFORM_STONE: MaterialSpec = {
  kind: "standard",
  color: 0x5a5a58,
  roughness: 0.85,
  metalness: 0.15,
};
// Continuous low wall used on small turrets so characters on the
// roof walkway don't fall off. Height matches the cubic merlon size
// (0.029 × TOWER_Y_SCALE ≈ 0.125 world ≈ 1 cell tall); thickness is
// 1 cell so it pixel-aligns with the roof outline.
const PARAPET: ParapetParams = {
  height: 0.029,
  thickness: 0.125,
  material: STONE_PLAIN,
};
// Crenellated parapet for small turrets. Unlike the earlier "split the
// span into N teeth" approach, merlons are now placed on a FIXED WORLD
// LATTICE (see MERLON_LATTICE below) so adjacent turrets at pixel-grid
// positions line up with the wall-sprite merlon pattern. Teeth are
// taller than the flat parapet (0.04 → 0.08) so the crenellation reads
// clearly after quantize.
const MERLON_PARAPET: ParapetParams = {
  // Cubic teeth: MERLON_SIZE = 0.125 world wide, and TOWER_Y_SCALE
  // = 4.30 inflates local Y, so local height = 0.125 / 4.30 ≈ 0.029
  // yields a ~0.125 × 0.125 × 0.125 world cube (≈ 4 px at game-2×).
  height: 0.029,
  thickness: 0.125,
  material: STONE_PLAIN,
  merlons: true,
};
// Merlons are 1 cell wide and sit 1 cell apart (M_M_M…), anchored to
// each wall span's west/north end. For an odd-cell span the pattern
// ends with a merlon flush at both corners (the main-platform case);
// for an even-cell span the far end is a gap.
const MERLON_SIZE = 0.125;
const MERLON_STEP = 0.25;
// one merlon + one gap
// Thin square stone deck added on top of rounded turret roofs.
const MERLON_DECK_HEIGHT = 0.03;
// Default rounded-corner radius for small turrets. 1 cell wide.
const CORNER_R = 0.125;
/**
 * Cell-grid authoring helpers. Sprite is 16×16 cells = ±1 world in XZ.
 * Each cell = 0.125 world (= 2 px at game-1×, 4 px at game-2×).
 */
const col = (c: number): number => (c - 7.5) * CELL;
const row = (r: number): number => (r - 7.5) * CELL;
// Y-axis authoring. Geometry heights are pre-scaled (the tower group
// applies TOWER_Y_SCALE = 4.30 at render time), so 1 cell post-scale
// in Y requires cells(1) / TOWER_Y_SCALE ≈ 0.029 in the authored value.
const TOWER_Y_SCALE = 4.3;
const yCells = (n: number): number => (n * CELL) / TOWER_Y_SCALE;
/** Uniform XZ scale. Kept at 1.0 so every turret dimension lands on the
 *  world grid. */
const TOWER_XZ_SCALE = 1.0;
const UV_DENSITY = 2.0;
const ROOF_TILES_PER_WORLD = 16;
const roofWrapsPerWorld = ROOF_TILES_PER_WORLD / 4;
export const VARIANTS: Variant[] = [
  {
    // Secondary tower — same layout as home tower minus the gate.
    name: "secondary_tower",
    label: "secondary tower",
    canvasPx: 64,
    params: {
      turrets: [
        {
          name: "rear_main",
          x: col(7),
          z: row(3),
          width: cells(11),
          depth: cells(7),
          height: 0.15,
          yBase: 0,
          material: STONE_BODY,
          roof: {
            thickness: 0,
            eaveScale: 1.0,
            material: ROOF_SLATE,
            parapet: { ...MERLON_PARAPET, skipSides: ["S"] },
          },
          polePlatform: {
            offset: [0, cells(2.5)],
            width: cells(3),
            depth: cells(4),
            height: 0.05,
            material: PLATFORM_STONE,
            pole: {
              radius: 0.02,
              height: 0.15,
              material: WOOD_DARK,
              flag: {
                width: cells(2),
                height: 0.0625,
                yOffset: -0.03125,
                side: "+x",
                material: FLAG_RED,
              },
            },
          },
        },
        {
          name: "front_main",
          x: col(7),
          z: row(9),
          width: cells(13),
          depth: cells(5),
          height: 0.15,
          yBase: 0,
          material: STONE_BODY,
          roof: {
            thickness: 0,
            eaveScale: 1.0,
            material: ROOF_SLATE,
            parapet: { ...MERLON_PARAPET, skipSides: ["N"] },
          },
          window: { width: cells(2), height: cells(1), material: WINDOW_DARK },
        },
        {
          name: "rear_left",
          x: col(1.5),
          z: row(5.5),
          width: cells(4),
          depth: cells(4),
          height: 0.25,
          yBase: 0,
          cornerR: CORNER_R,
          material: STONE_BODY,
          roof: {
            thickness: 0,
            eaveScale: 1.0,
            material: ROOF_SLATE,
            parapet: PARAPET,
          },
        },
        {
          name: "rear_right",
          x: col(12.5),
          z: row(5.5),
          width: cells(4),
          depth: cells(4),
          height: 0.25,
          yBase: 0,
          cornerR: CORNER_R,
          material: STONE_BODY,
          roof: {
            thickness: 0,
            eaveScale: 1.0,
            material: ROOF_SLATE,
            parapet: PARAPET,
          },
        },
      ],
    },
  },
  {
    // Home tower — all XZ authored in ASCII cells.
    name: "home_tower",
    label: "home tower",
    canvasPx: 64,
    params: {
      turrets: [
        {
          name: "rear_main",
          x: col(7),
          z: row(3),
          width: cells(11),
          depth: cells(7),
          height: 0.15,
          yBase: 0,
          material: STONE_BODY,
          roof: {
            thickness: 0,
            eaveScale: 1.0,
            material: ROOF_SLATE,
            parapet: { ...MERLON_PARAPET, skipSides: ["S"] },
          },
          polePlatform: {
            offset: [0, cells(2.5)],
            width: cells(3),
            depth: cells(4),
            height: 0.05,
            material: PLATFORM_STONE,
            pole: {
              radius: 0.02,
              height: yCells(8),
              material: WOOD_DARK,
              flag: {
                width: cells(2),
                height: yCells(2),
                yOffset: -yCells(1),
                side: "+x",
                material: FLAG_RED,
              },
            },
          },
        },
        {
          name: "front_main",
          x: col(7),
          z: row(9),
          width: cells(13),
          depth: cells(5),
          height: 0.15,
          yBase: 0,
          material: STONE_BODY,
          roof: {
            thickness: 0,
            eaveScale: 1.0,
            material: ROOF_SLATE,
            parapet: {
              ...MERLON_PARAPET,
              skipSides: ["N"],
              clip: {
                S: { exclude: [{ lo: col(4.5), hi: col(9.5) }] },
              },
            },
          },
        },
        {
          name: "rear_left",
          x: col(1.5),
          z: row(5.5),
          width: cells(4),
          depth: cells(4),
          height: 0.35,
          yBase: 0,
          cornerR: CORNER_R,
          material: STONE_BODY,
          roof: {
            thickness: 0,
            eaveScale: 1.0,
            material: ROOF_SLATE,
            parapet: PARAPET,
          },
        },
        {
          name: "rear_right",
          x: col(12.5),
          z: row(5.5),
          width: cells(4),
          depth: cells(4),
          height: 0.35,
          yBase: 0,
          cornerR: CORNER_R,
          material: STONE_BODY,
          roof: {
            thickness: 0,
            eaveScale: 1.0,
            material: ROOF_SLATE,
            parapet: PARAPET,
          },
        },
        {
          name: "gate",
          x: col(7),
          z: row(13),
          width: cells(5),
          depth: cells(5),
          height: 0.3,
          yBase: 0,
          cornerR: CORNER_R,
          material: STONE_BODY,
          roof: {
            thickness: 0,
            eaveScale: 1.0,
            material: ROOF_SLATE,
            parapet: PARAPET,
          },
          window: { width: cells(2), height: cells(1), material: WINDOW_DARK },
          cornerFlags: [
            {
              corner: "SW",
              pole: {
                radius: 0.0156,
                height: yCells(3),
                material: WOOD_DARK,
                flag: {
                  width: cells(2),
                  height: yCells(2),
                  yOffset: -yCells(1),
                  side: "+x",
                  material: FLAG_RED,
                },
              },
            },
            {
              corner: "SE",
              pole: {
                radius: 0.0156,
                height: yCells(3),
                material: WOOD_DARK,
                flag: {
                  width: cells(2),
                  height: yCells(2),
                  yOffset: -yCells(1),
                  side: "+x",
                  material: FLAG_RED,
                },
              },
            },
          ],
        },
      ],
    },
  },
];
export const PALETTE: [number, number, number][] = [
  [0x4a, 0x4a, 0x48],
  [0x88, 0x88, 0x85],
  [0xc8, 0xc8, 0xc5],
  [0xff, 0xff, 0xff],
  [0x30, 0x34, 0x3a],
  [0x50, 0x55, 0x60],
  [0x7a, 0x80, 0x90],
  [0x3a, 0x24, 0x10],
  [0x5a, 0x38, 0x20],
  [0x80, 0x1a, 0x1a],
  [0xb0, 0x2a, 0x2a],
  [0xd8, 0x50, 0x40],
  [0x0a, 0x0a, 0x0a],
];

let _stoneTexture: THREE.CanvasTexture | undefined;
let _doorTexture: THREE.CanvasTexture | undefined;
let _roofTexture: THREE.CanvasTexture | undefined;

// Find a variant by name. Used by the towers entity manager.
export function getTowerVariant(name: string): Variant | undefined {
  return findVariant(VARIANTS, name);
}

export function variantReport(variant: Variant): VariantReport {
  const warnings: string[] = [];
  const turrets = variant.params.turrets.map((t) => ({
    ...t,
    footprint: turretFootprint(t),
  }));

  for (const t of turrets) {
    const fp = t.footprint;
    if (
      fp.xMin < -FRUSTUM_HALF - BOUND_EPS ||
      fp.xMax > FRUSTUM_HALF + BOUND_EPS ||
      fp.zMin < -FRUSTUM_HALF - BOUND_EPS ||
      fp.zMax > FRUSTUM_HALF + BOUND_EPS
    ) {
      warnings.push(
        `turret "${t.name}" roof leaves the ±${FRUSTUM_HALF} canvas: ` +
          `x=[${fp.xMin.toFixed(3)}, ${fp.xMax.toFixed(3)}], ` +
          `z=[${fp.zMin.toFixed(3)}, ${fp.zMax.toFixed(3)}]`,
      );
    }
  }

  return {
    name: variant.name,
    turrets: turrets.map((t) => ({
      name: t.name,
      x: t.x,
      z: t.z,
      width: t.width,
      depth: t.depth,
      height: t.height,
      footprint: t.footprint,
      wallTopY: wallTopY(t),
    })),
    warnings,
  };
}

/** Top-down footprint of a turret including eave overhang. */
export function turretFootprint(turret: TurretParams): TurretFootprint {
  const eaveScale = turret.roof.eaveScale ?? 1.06;
  const halfW = (turret.width / 2) * eaveScale;
  const halfD = (turret.depth / 2) * eaveScale;
  return {
    xMin: turret.x - halfW,
    xMax: turret.x + halfW,
    zMin: turret.z - halfD,
    zMax: turret.z + halfD,
  };
}

/**
 * Build the turret stack authored in `params` into `scene`. A fresh
 * `THREE.Group` wraps every mesh and applies (TOWER_XZ_SCALE,
 * TOWER_Y_SCALE, TOWER_XZ_SCALE) so the authored tiny heights scale up
 * to world units at render time.
 *
 * Mesh naming: flag (pennant) meshes set `mesh.name = "flag"` so callers
 * can find and recolor them after the build (used by the per-player
 * tower tinting in `entities/towers.ts`). No other naming is load-bearing.
 */
export function buildTower(
  three: typeof THREE,
  scene: THREE.Scene | THREE.Group,
  params: TowerParams,
): void {
  const mat = (spec: TexturedSpec | MaterialSpec): THREE.Material =>
    makeMaterial(three, spec);

  const group = new three.Group();
  group.scale.set(TOWER_XZ_SCALE, TOWER_Y_SCALE, TOWER_XZ_SCALE);
  scene.add(group);

  const plainMat = mat(STONE_PLAIN);

  for (const t of params.turrets) {
    const yBase = t.yBase ?? 0;
    const cornerR = t.cornerR ?? 0;
    const rounded = cornerR > 0;

    const sideMat = mat(t.material);
    const roofTopMat = mat(t.roof.material);
    let body: THREE.Mesh;
    if (rounded) {
      const shape = roundedRectShape(three, t.width / 2, t.depth / 2, cornerR);
      const geom = new three.ExtrudeGeometry(shape, {
        depth: t.height,
        bevelEnabled: false,
        UVGenerator: stoneWallUVGenerator(three),
      } as THREE.ExtrudeGeometryOptions);
      geom.rotateX(-Math.PI / 2);
      geom.translate(0, -t.height / 2, 0);
      body = new three.Mesh(geom, [plainMat, sideMat]);
    } else {
      const geom = new three.BoxGeometry(t.width, t.height, t.depth);
      applyBoxWallUV(
        geom,
        t.width,
        t.height * TOWER_Y_SCALE,
        t.depth,
        UV_DENSITY,
      );
      body = new three.Mesh(geom, [
        sideMat,
        sideMat,
        plainMat,
        plainMat,
        sideMat,
        sideMat,
      ]);
    }
    body.position.set(t.x, yBase + t.height / 2, t.z);
    group.add(body);

    // Roof.
    const roof = roofPlacement(t);
    let roofMesh: THREE.Mesh;
    if (roof.thickness === 0) {
      if (rounded) {
        const shape = roundedRectShape(
          three,
          roof.width / 2,
          roof.depth / 2,
          cornerR,
        );
        const geom = new three.ShapeGeometry(shape);
        geom.rotateX(-Math.PI / 2);
        applyRoofUVShape(geom);
        roofMesh = new three.Mesh(geom, roofTopMat);
      } else {
        const plane = new three.PlaneGeometry(roof.width, roof.depth);
        plane.rotateX(-Math.PI / 2);
        applyRoofUVPlane(plane, roof.width, roof.depth);
        roofMesh = new three.Mesh(plane, roofTopMat);
      }
      roofMesh.position.set(t.x, roof.yCenter + 0.0005, t.z);
    } else if (rounded) {
      const shape = roundedRectShape(
        three,
        roof.width / 2,
        roof.depth / 2,
        cornerR,
      );
      const geom = new three.ExtrudeGeometry(shape, {
        depth: roof.thickness,
        bevelEnabled: false,
      });
      geom.rotateX(-Math.PI / 2);
      geom.translate(0, -roof.thickness / 2, 0);
      roofMesh = new three.Mesh(geom, [roofTopMat, plainMat]);
      roofMesh.position.set(t.x, roof.yCenter, t.z);
    } else {
      roofMesh = new three.Mesh(
        new three.BoxGeometry(roof.width, roof.thickness, roof.depth),
        [plainMat, plainMat, roofTopMat, plainMat, plainMat, plainMat],
      );
      roofMesh.position.set(t.x, roof.yCenter, t.z);
    }
    group.add(roofMesh);

    const hasDeck = rounded && !!t.roof.parapet && !!t.roof.parapet.merlons;
    if (hasDeck) {
      const roofTopY = roof.yCenter + roof.thickness / 2;
      const deckMesh = new three.Mesh(
        new three.BoxGeometry(t.width, MERLON_DECK_HEIGHT, t.depth),
        plainMat,
      );
      deckMesh.position.set(t.x, roofTopY + MERLON_DECK_HEIGHT / 2, t.z);
      group.add(deckMesh);
    }

    if (t.roof.parapet) {
      const parapet = t.roof.parapet;
      const parapetPlainMat = mat(parapet.material);
      const parapetSideMat = mat({
        ...parapet.material,
        texture: "stone",
      });
      const parapetMatArray: THREE.Material[] = [
        parapetSideMat,
        parapetSideMat,
        parapetPlainMat,
        parapetPlainMat,
        parapetSideMat,
        parapetSideMat,
      ];
      const flat = !parapet.height;
      const hasClip = !!parapet.skipSides || !!parapet.clip;
      const roundedRing = rounded && !flat && !parapet.merlons && !hasClip;
      if (roundedRing) {
        const outerHW = t.width / 2;
        const outerHD = t.depth / 2;
        const outerR = cornerR;
        const innerHW = outerHW - parapet.thickness;
        const innerHD = outerHD - parapet.thickness;
        const innerR = Math.max(CELL / 2, outerR - parapet.thickness);
        const shape = roundedRectShape(three, outerHW, outerHD, outerR);
        shape.holes.push(roundedRectPath(three, innerHW, innerHD, innerR));
        const geom = new three.ExtrudeGeometry(shape, {
          depth: parapet.height,
          bevelEnabled: false,
          UVGenerator: stoneWallUVGenerator(three),
        } as THREE.ExtrudeGeometryOptions);
        geom.rotateX(-Math.PI / 2);
        const ring = new three.Mesh(geom, [parapetPlainMat, parapetSideMat]);
        ring.position.set(t.x, wallTopY(t), t.z);
        group.add(ring);
      } else {
        const aoMat = parapet.merlons ? mat(MERLON_AO) : null;
        const roofTopY = roof.yCenter + roof.thickness / 2;
        const deckTopY = hasDeck ? roofTopY + MERLON_DECK_HEIGHT : roofTopY;
        for (const w of parapetPlacements(t)) {
          let wallMesh: THREE.Mesh;
          if (flat) {
            const plane = new three.PlaneGeometry(w.dims.width, w.dims.depth);
            plane.rotateX(-Math.PI / 2);
            wallMesh = new three.Mesh(plane, parapetPlainMat);
            wallMesh.position.set(w.pos[0], w.pos[1] + 0.0005, w.pos[2]);
          } else {
            const geom = new three.BoxGeometry(
              w.dims.width,
              w.dims.height,
              w.dims.depth,
            );
            applyBoxWallUV(
              geom,
              w.dims.width,
              w.dims.height * TOWER_Y_SCALE,
              w.dims.depth,
              UV_DENSITY,
            );
            wallMesh = new three.Mesh(geom, parapetMatArray);
            wallMesh.position.set(w.pos[0], w.pos[1], w.pos[2]);
          }
          group.add(wallMesh);
          if (aoMat && !flat) {
            const halo = CELL * 0.5;
            const ao = new three.PlaneGeometry(
              w.dims.width + halo,
              w.dims.depth + halo,
            );
            ao.rotateX(-Math.PI / 2);
            const aoMesh = new three.Mesh(ao, aoMat);
            aoMesh.position.set(w.pos[0], deckTopY + 0.0005, w.pos[2]);
            group.add(aoMesh);
          }
        }
      }
    }

    const win = windowPlacement(t);
    if (win && t.window) {
      const windowMesh = new three.Mesh(
        new three.BoxGeometry(win.width, win.height, 0.02),
        mat(t.window.material),
      );
      windowMesh.position.set(win.pos[0], win.pos[1], win.pos[2]);
      group.add(windowMesh);
    }

    const pp = polePlatformPlacement(t);
    if (pp && t.polePlatform) {
      const plat = pp.platform;
      const platR = Math.min(plat.width, plat.depth) / 2;
      const platSideSpec: TexturedSpec = {
        ...t.polePlatform.material,
        texture: "stone",
      };
      const platSideMat = mat(platSideSpec);
      const platPlainMat = mat(t.polePlatform.material);
      const platGeom = new three.CylinderGeometry(
        platR,
        platR,
        plat.height,
        24,
      );
      applyCylinderWallUV(platGeom, platR, plat.height * TOWER_Y_SCALE);
      const platMesh = new three.Mesh(platGeom, [
        platSideMat,
        platPlainMat,
        platPlainMat,
      ]);
      platMesh.position.set(plat.pos[0], plat.pos[1], plat.pos[2]);
      group.add(platMesh);

      const lipThickness = CELL / 2;
      const lipHeight = CELL / 2 / TOWER_Y_SCALE;
      const lipShape = new three.Shape();
      lipShape.absarc(0, 0, platR, 0, Math.PI * 2, false);
      const lipHole = new three.Path();
      lipHole.absarc(0, 0, platR - lipThickness, 0, Math.PI * 2, true);
      lipShape.holes.push(lipHole);
      const lipGeom = new three.ExtrudeGeometry(lipShape, {
        depth: lipHeight,
        bevelEnabled: false,
        curveSegments: 24,
        UVGenerator: stoneWallUVGenerator(three),
      } as THREE.ExtrudeGeometryOptions);
      lipGeom.rotateX(-Math.PI / 2);
      const lipMesh = new three.Mesh(lipGeom, [platPlainMat, platSideMat]);
      lipMesh.position.set(
        plat.pos[0],
        plat.pos[1] + plat.height / 2,
        plat.pos[2],
      );
      group.add(lipMesh);

      if (pp.pole && t.polePlatform.pole) {
        const p = pp.pole;
        const poleMesh = new three.Mesh(
          new three.CylinderGeometry(p.radius, p.radius, p.height, 12),
          mat(t.polePlatform.pole.material),
        );
        poleMesh.position.set(p.pos[0], p.pos[1], p.pos[2]);
        group.add(poleMesh);
      }

      if (pp.flag && t.polePlatform.pole?.flag) {
        const f = pp.flag;
        const flagMesh = new three.Mesh(
          new three.BoxGeometry(f.width, f.height, 0.02),
          mat(t.polePlatform.pole.flag.material),
        );
        flagMesh.position.set(f.pos[0], f.pos[1], f.pos[2]);
        flagMesh.rotation.y = f.yaw;
        flagMesh.name = "flag";
        group.add(flagMesh);
      }
    }

    const corners = cornerFlagPlacements(t);
    for (let i = 0; i < corners.length; i++) {
      const spec = t.cornerFlags?.[i];
      if (!spec) continue;
      const place = corners[i];
      if (!place) continue;
      const poleMesh = new three.Mesh(
        new three.CylinderGeometry(
          place.pole.radius,
          place.pole.radius,
          place.pole.height,
          12,
        ),
        mat(spec.pole.material),
      );
      poleMesh.position.set(
        place.pole.pos[0],
        place.pole.pos[1],
        place.pole.pos[2],
      );
      group.add(poleMesh);

      if (place.flag && spec.pole.flag) {
        const flagMesh = new three.Mesh(
          new three.BoxGeometry(place.flag.width, place.flag.height, 0.02),
          mat(spec.pole.flag.material),
        );
        flagMesh.position.set(
          place.flag.pos[0],
          place.flag.pos[1],
          place.flag.pos[2],
        );
        flagMesh.rotation.y = place.flag.yaw;
        flagMesh.name = "flag";
        group.add(flagMesh);
      }
    }
  }
}

export function parapetPlacements(turret: TurretParams): ParapetPlacement[] {
  if (!turret.roof.parapet) return [];
  const p = turret.roof.parapet;
  const skip = new Set<ParapetSide>(p.skipSides ?? []);
  const clip = p.clip ?? {};
  const roof = roofPlacement(turret);
  const roofTopY = roof.yCenter + roof.thickness / 2;
  // Rounded turrets with a merlon parapet get a thin square stone deck
  // between the rounded roof and the merlons, so the merlon lattice
  // uses the full bounding box (no cornerR-shrink).
  const hasDeck = (turret.cornerR ?? 0) > 0 && !!p.merlons;
  const deckTopY = hasDeck ? roofTopY + MERLON_DECK_HEIGHT : roofTopY;
  const yCenter = deckTopY + p.height / 2;
  const halfW = roof.width / 2;
  const halfD = roof.depth / 2;
  const out: ParapetPlacement[] = [];

  const clamp1d = (
    lo: number,
    hi: number,
    clipLo: number | undefined,
    clipHi: number | undefined,
  ): { lo: number; hi: number } | null => {
    const newLo = clipLo === undefined ? lo : Math.max(lo, clipLo);
    const newHi = clipHi === undefined ? hi : Math.min(hi, clipHi);
    if (newHi - newLo <= 1e-6) return null;
    return { lo: newLo, hi: newHi };
  };

  const splitIntoMerlons = (
    lo: number,
    hi: number,
  ): { center: number; length: number }[] => {
    if (!p.merlons) return [{ center: (lo + hi) / 2, length: hi - lo }];
    const eps = 1e-4;
    const segs: { center: number; length: number }[] = [];
    for (let i = 0; ; i++) {
      const center = lo + MERLON_SIZE / 2 + i * MERLON_STEP;
      if (center + MERLON_SIZE / 2 > hi + eps) break;
      segs.push({ center, length: MERLON_SIZE });
    }
    return segs;
  };

  const inExclude = (
    center: number,
    exclude: { lo: number; hi: number }[] | undefined,
  ): boolean => {
    if (!exclude) return false;
    for (const e of exclude) {
      if (center > e.lo - 1e-4 && center < e.hi + 1e-4) return true;
    }
    return false;
  };

  const addAlongX = (
    side: ParapetSide,
    lo: number,
    hi: number,
    z: number,
    exclude: { lo: number; hi: number }[] | undefined,
  ): void => {
    for (const seg of splitIntoMerlons(lo, hi)) {
      if (inExclude(seg.center, exclude)) continue;
      out.push({
        side,
        dims: { width: seg.length, height: p.height, depth: p.thickness },
        pos: [seg.center, yCenter, z],
      });
    }
  };
  const addAlongZ = (
    side: ParapetSide,
    lo: number,
    hi: number,
    x: number,
    exclude: { lo: number; hi: number }[] | undefined,
  ): void => {
    for (const seg of splitIntoMerlons(lo, hi)) {
      if (inExclude(seg.center, exclude)) continue;
      out.push({
        side,
        dims: { width: p.thickness, height: p.height, depth: seg.length },
        pos: [x, yCenter, seg.center],
      });
    }
  };

  if (!skip.has("N")) {
    const c = clip.N ?? {};
    const span = clamp1d(turret.x - halfW, turret.x + halfW, c.xMin, c.xMax);
    if (span)
      addAlongX(
        "N",
        span.lo,
        span.hi,
        turret.z - halfD + p.thickness / 2,
        c.exclude,
      );
  }
  if (!skip.has("S")) {
    const c = clip.S ?? {};
    const span = clamp1d(turret.x - halfW, turret.x + halfW, c.xMin, c.xMax);
    if (span)
      addAlongX(
        "S",
        span.lo,
        span.hi,
        turret.z + halfD - p.thickness / 2,
        c.exclude,
      );
  }
  if (!skip.has("W")) {
    const c = clip.W ?? {};
    const span = clamp1d(turret.z - halfD, turret.z + halfD, c.zMin, c.zMax);
    if (span)
      addAlongZ(
        "W",
        span.lo,
        span.hi,
        turret.x - halfW + p.thickness / 2,
        c.exclude,
      );
  }
  if (!skip.has("E")) {
    const c = clip.E ?? {};
    const span = clamp1d(turret.z - halfD, turret.z + halfD, c.zMin, c.zMax);
    if (span)
      addAlongZ(
        "E",
        span.lo,
        span.hi,
        turret.x + halfW - p.thickness / 2,
        c.exclude,
      );
  }
  return out;
}

export function windowPlacement(turret: TurretParams): WindowPlacement | null {
  if (!turret.window) return null;
  const yBase = turret.yBase ?? 0;
  return {
    width: turret.window.width,
    height: turret.window.height,
    pos: [
      turret.x,
      yBase + turret.window.height / 2,
      turret.z + turret.depth / 2 + 0.005,
    ],
  };
}

export function polePlatformPlacement(
  turret: TurretParams,
): PolePlatformPlacement | null {
  if (!turret.polePlatform) return null;
  const pp = turret.polePlatform;
  const [offX, offZ] = pp.offset ?? [0, 0];
  const cx = turret.x + offX;
  const cz = turret.z + offZ;
  const roof = roofPlacement(turret);
  const roofTopY = roof.yCenter + roof.thickness / 2;
  const platformY = roofTopY + pp.height / 2;
  const result: PolePlatformPlacement = {
    platform: {
      width: pp.width,
      depth: pp.depth,
      height: pp.height,
      pos: [cx, platformY, cz],
    },
  };
  if (!pp.pole) return result;

  const platformTopY = roofTopY + pp.height;
  const pf = _makePoleFlag(pp.pole, cx, platformTopY, cz);
  result.pole = pf.pole;
  result.poleMaterial = pf.material;
  if (pf.flag) result.flag = pf.flag;
  return result;
}

export function cornerFlagPlacements(
  turret: TurretParams,
): CornerFlagPlacement[] {
  if (!turret.cornerFlags || turret.cornerFlags.length === 0) return [];
  const roof = roofPlacement(turret);
  const roofTopY = roof.yCenter + roof.thickness / 2;
  const parapet = turret.roof.parapet;
  const yTop = parapet ? roofTopY + parapet.height : roofTopY;
  const inset = parapet && parapet.thickness ? parapet.thickness / 2 : 0;
  const halfW = turret.width / 2 - inset;
  const halfD = turret.depth / 2 - inset;
  const cornerOf = (corner: Corner): [number, number] => {
    const dx = corner === "NE" || corner === "SE" ? +halfW : -halfW;
    const dz = corner === "SW" || corner === "SE" ? +halfD : -halfD;
    return [turret.x + dx, turret.z + dz];
  };
  return turret.cornerFlags.map((cf) => {
    const [cx, cz] = cornerOf(cf.corner);
    const pf = _makePoleFlag(cf.pole, cx, yTop, cz);
    const result: CornerFlagPlacement = {
      corner: cf.corner,
      pole: pf.pole,
    };
    if (pf.flag) result.flag = pf.flag;
    return result;
  });
}

export function roofPlacement(turret: TurretParams): RoofPlacement {
  const eaveScale = turret.roof.eaveScale ?? 1.06;
  const t = turret.roof.thickness;
  return {
    width: turret.width * eaveScale,
    depth: turret.depth * eaveScale,
    thickness: t,
    yCenter: wallTopY(turret) + t / 2,
  };
}

/** Y of the top of the wall (where the roof slab rests). */
export function wallTopY(turret: TurretParams): number {
  return (turret.yBase ?? 0) + turret.height;
}

function _makePoleFlag(
  pole: PoleParams,
  cx: number,
  baseY: number,
  cz: number,
): PoleFlagResult {
  const result: PoleFlagResult = {
    pole: {
      radius: pole.radius,
      height: pole.height,
      pos: [cx, baseY + pole.height / 2, cz],
    },
    material: pole.material,
  };
  if (pole.flag) {
    const f = pole.flag;
    const tipY = baseY + pole.height;
    const flagY = tipY + f.yOffset;
    let dx = 0;
    let dz = 0;
    switch (f.side ?? "+x") {
      case "+x":
        dx = +(pole.radius + f.width / 2);
        break;
      case "-x":
        dx = -(pole.radius + f.width / 2);
        break;
      case "+z":
        dz = +(pole.radius + f.width / 2);
        break;
      case "-z":
        dz = -(pole.radius + f.width / 2);
        break;
    }
    const yaw = f.side === "+z" || f.side === "-z" ? Math.PI / 2 : 0;
    result.flag = {
      width: f.width,
      height: f.height,
      pos: [cx + dx, flagY, cz + dz],
      yaw,
      material: f.material,
    };
  }
  return result;
}

function stoneWallUVGenerator(three: typeof THREE): UVGenerator {
  const zero = (): THREE.Vector2 => new three.Vector2(0, 0);
  return {
    generateTopUV: () => [zero(), zero(), zero()],
    generateSideWallUV(_geometry, vertices, iA, iB, iC, iD) {
      const pos = (i: number): [number, number, number] => [
        vertices[i * 3]!,
        vertices[i * 3 + 1]!,
        vertices[i * 3 + 2]!,
      ];
      const [ax, ay, az] = pos(iA);
      const [bx, by, bz] = pos(iB);
      const [cx, cy, cz] = pos(iC);
      const [dx, dy, dz] = pos(iD);
      const useX = Math.abs(ay - by) < Math.abs(ax - bx);
      const u = (px: number, py: number): number =>
        (useX ? px : py) * UV_DENSITY;
      const v = (pz: number): number => pz * UV_DENSITY * TOWER_Y_SCALE;
      return [
        new three.Vector2(u(ax, ay), v(az)),
        new three.Vector2(u(bx, by), v(bz)),
        new three.Vector2(u(cx, cy), v(cz)),
        new three.Vector2(u(dx, dy), v(dz)),
      ];
    },
  };
}

function applyCylinderWallUV(
  geom: THREE.CylinderGeometry,
  radius: number,
  hPost: number,
): void {
  const uv = geom.attributes["uv"] as THREE.BufferAttribute;
  const a = uv.array as Float32Array;
  const uScale = 2 * Math.PI * radius * UV_DENSITY;
  const vScale = hPost * UV_DENSITY;
  for (let i = 0; i < a.length; i += 2) {
    a[i] = a[i]! * uScale;
    a[i + 1] = a[i + 1]! * vScale;
  }
  uv.needsUpdate = true;
}

function roundedRectShape(
  three: typeof THREE,
  halfW: number,
  halfD: number,
  R: number,
): THREE.Shape {
  return _drawRoundedRect(new three.Shape(), halfW, halfD, R) as THREE.Shape;
}

function roundedRectPath(
  three: typeof THREE,
  halfW: number,
  halfD: number,
  R: number,
): THREE.Path {
  return _drawRoundedRect(new three.Path(), halfW, halfD, R) as THREE.Path;
}

function _drawRoundedRect<T extends THREE.Path>(
  p: T,
  halfW: number,
  halfD: number,
  R: number,
): T {
  const r = Math.max(0, Math.min(R, Math.min(halfW, halfD)));
  if (r === 0) {
    p.moveTo(-halfW, +halfD);
    p.lineTo(-halfW, -halfD);
    p.lineTo(+halfW, -halfD);
    p.lineTo(+halfW, +halfD);
    p.lineTo(-halfW, +halfD);
    return p;
  }
  p.moveTo(-halfW, +halfD - r);
  p.lineTo(-halfW, -halfD + r);
  p.absarc(-halfW + r, -halfD + r, r, Math.PI, 1.5 * Math.PI, false);
  p.lineTo(+halfW - r, -halfD);
  p.absarc(+halfW - r, -halfD + r, r, 1.5 * Math.PI, 2 * Math.PI, false);
  p.lineTo(+halfW, +halfD - r);
  p.absarc(+halfW - r, +halfD - r, r, 0, 0.5 * Math.PI, false);
  p.lineTo(-halfW + r, +halfD);
  p.absarc(-halfW + r, +halfD - r, r, 0.5 * Math.PI, Math.PI, false);
  return p;
}

function makeMaterial(
  three: typeof THREE,
  spec: TexturedSpec | MaterialSpec,
): THREE.MeshBasicMaterial | THREE.MeshStandardMaterial {
  const mat = createMaterial(spec);
  const textured = spec as TexturedSpec;
  if (textured.texture === "stone") {
    const tex = getStoneTexture(three);
    if (tex) mat.map = tex;
  } else if (textured.texture === "door") {
    const tex = getDoorTexture(three);
    if (tex) mat.map = tex;
  } else if (textured.texture === "roof") {
    const tex = getRoofTexture(three);
    if (tex) mat.map = tex;
  }
  return mat;
}

function getStoneTexture(three: typeof THREE): THREE.CanvasTexture | undefined {
  if (_stoneTexture) return _stoneTexture;
  const tex = createTiledCanvasTexture(three, 64, ({ ctx, size, rand }) => {
    const brickW = 16;
    const brickH = 8;
    for (let row = 0; row * brickH < size; row++) {
      const offset = (row % 2) * (brickW / 2);
      for (let col = -1; col * brickW + offset < size; col++) {
        const x = col * brickW + offset;
        const y = row * brickH;
        const base = 200 + Math.floor((rand() - 0.5) * 50);
        ctx.fillStyle = `rgb(${base},${base},${base})`;
        ctx.fillRect(x, y, brickW, brickH);
        const count = 6 + Math.floor(rand() * 5);
        for (let i = 0; i < count; i++) {
          const shade = base - 20 - Math.floor(rand() * 30);
          ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
          ctx.fillRect(
            x + Math.floor(rand() * brickW),
            y + Math.floor(rand() * brickH),
            1 + Math.floor(rand() * 2),
            1,
          );
        }
      }
    }
    ctx.fillStyle = "rgb(120,115,108)";
    for (let y = 0; y < size; y += brickH) ctx.fillRect(0, y, size, 1);
    for (let row = 0; row * brickH < size; row++) {
      const y = row * brickH;
      const offset = (row % 2) * (brickW / 2);
      for (let x = offset; x < size; x += brickW) ctx.fillRect(x, y, 1, brickH);
    }
  });
  if (tex) _stoneTexture = tex;
  return tex;
}

function getDoorTexture(three: typeof THREE): THREE.CanvasTexture | undefined {
  if (typeof document === "undefined") return undefined;
  if (_doorTexture) return _doorTexture;
  const w = 64;
  const h = 32;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return undefined;

  const plankCount = 2;
  const plankW = w / plankCount;
  const r = 16;
  const g = 10;
  const b = 6;
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = `rgb(${r - 4},${g - 2},${b - 1})`;
  for (let i = 0; i < plankCount; i++) {
    ctx.fillRect(Math.floor(i * plankW + plankW / 2), 0, 1, h);
  }
  ctx.fillStyle = "rgb(2,1,0)";
  for (let i = 0; i < plankCount; i++) {
    ctx.fillRect(i * plankW + plankW - 1, 0, 1, h);
  }
  ctx.fillStyle = "rgb(14,14,16)";
  ctx.fillRect(0, 3, w, 2);
  ctx.fillRect(0, h - 5, w, 2);
  ctx.fillStyle = "rgb(70,70,74)";
  for (let i = 0; i < plankCount; i++) {
    const cx = Math.floor(i * plankW + plankW / 2);
    ctx.fillRect(cx, 3, 1, 1);
    ctx.fillRect(cx, h - 5, 1, 1);
  }

  const tex = new three.CanvasTexture(c);
  tex.wrapS = three.RepeatWrapping;
  tex.wrapT = three.RepeatWrapping;
  _doorTexture = tex;
  return tex;
}

function getRoofTexture(three: typeof THREE): THREE.CanvasTexture | undefined {
  if (_roofTexture) return _roofTexture;
  const tex = createTiledCanvasTexture(three, 32, ({ ctx, size, rand }) => {
    const w = size;
    const h = size;
    ctx.fillStyle = "rgb(230,230,230)";
    ctx.fillRect(0, 0, w, h);
    const tileW = 8;
    const tileH = 8;
    for (let ty = 0; ty < h / tileH; ty++) {
      for (let tx = 0; tx < w / tileW; tx++) {
        const dim = ((tx + ty) % 2) * 12;
        ctx.fillStyle = `rgb(${230 - dim},${230 - dim},${230 - dim})`;
        ctx.fillRect(tx * tileW, ty * tileH, tileW, tileH);
      }
    }
    const img = ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = Math.floor((rand() - 0.5) * 60);
      img.data[i] = Math.max(0, Math.min(255, img.data[i]! + n));
      img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1]! + n));
      img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2]! + n));
    }
    ctx.putImageData(img, 0, 0);
    for (let i = 0; i < 80; i++) {
      const x = Math.floor(rand() * (w - 1));
      const y = Math.floor(rand() * (h - 1));
      const shade = 150 + Math.floor(rand() * 60);
      ctx.fillStyle = `rgb(${shade},${shade},${shade + 4})`;
      ctx.fillRect(x, y, 2, 2);
    }
    for (let i = 0; i < 120; i++) {
      const shade = 130 + Math.floor(rand() * 40);
      ctx.fillStyle = `rgb(${shade},${shade},${shade + 4})`;
      const wPx = rand() < 0.3 ? 2 : 1;
      ctx.fillRect(Math.floor(rand() * w), Math.floor(rand() * h), wPx, 1);
    }
    ctx.fillStyle = "rgb(180,180,185)";
    for (let y = tileH - 1; y < h; y += tileH) {
      for (let x = 0; x < w; x++) {
        const jy = y + (rand() < 0.15 ? (rand() < 0.5 ? -1 : 1) : 0);
        ctx.fillRect(x, jy, 1, 1);
      }
    }
    for (let x = tileW - 1; x < w; x += tileW) {
      for (let y = 0; y < h; y++) {
        const jx = x + (rand() < 0.15 ? (rand() < 0.5 ? -1 : 1) : 0);
        ctx.fillRect(jx, y, 1, 1);
      }
    }
  });
  if (tex) _roofTexture = tex;
  return tex;
}

function applyRoofUVPlane(
  geom: THREE.PlaneGeometry,
  w: number,
  d: number,
): void {
  const uv = geom.attributes["uv"] as THREE.BufferAttribute;
  const a = uv.array as Float32Array;
  const uMul = w * roofWrapsPerWorld;
  const vMul = d * roofWrapsPerWorld;
  for (let i = 0; i < a.length; i += 2) {
    a[i] = a[i]! * uMul;
    a[i + 1] = a[i + 1]! * vMul;
  }
  uv.needsUpdate = true;
}

function applyRoofUVShape(geom: THREE.ShapeGeometry): void {
  const uv = geom.attributes["uv"] as THREE.BufferAttribute;
  const a = uv.array as Float32Array;
  for (let i = 0; i < a.length; i += 2) {
    a[i] = a[i]! * roofWrapsPerWorld;
    a[i + 1] = a[i + 1]! * roofWrapsPerWorld;
  }
  uv.needsUpdate = true;
}
