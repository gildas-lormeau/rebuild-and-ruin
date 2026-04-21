/**
 * house-scene.ts — civilian dwelling sprite.
 *
 * TypeScript conversion of the original `house-scene.mjs`. Single variant:
 * `house` — a 1×1 tile civilian dwelling (half the cannon footprint) with
 * a stone body, gabled red roof (triangular prism), an optional door on
 * the +Z face, and up to four windows — one per face.
 *
 * Roof geometry is a triangular prism. The ridge runs along the configurable
 * `roof.ridgeAxis` (default `'z'` so the gable triangle shows above the
 * front door). Slopes run perpendicular to the ridge.
 *
 * Same shape as tower-scene.ts / wall-scene.ts:
 *   • `VARIANTS`, `PALETTE`
 *   • `buildHouse(THREE, scene, params)` — THREE is injected so the module
 *     stays free of a static three.js dependency.
 *   • Pure-math helpers: `bodyTopY`, `roofPlacement`, `doorPlacement`,
 *     `windowPlacements`.
 *   • `variantReport` for sanity checks.
 *
 * The houses entity manager (see `../entities/houses.ts`) is the only
 * production caller — it fetches the shared variant params and positions
 * one mesh per `House` on the `GameMap`.
 */

import * as THREE from "three";
import { BOUND_EPS, FRUSTUM_HALF } from "./sprite-bounds.ts";
import { cells, findVariant, measureVariantBoundsY } from "./sprite-kit.ts";
import { buildTexturedMaterial, type TexturedSpec } from "./sprite-textures.ts";

export type WindowSide = "+x" | "-x" | "+z" | "-z";

export interface BodyParams {
  width: number;
  depth: number;
  height: number;
  yBase?: number;
  material: TexturedSpec;
}

export interface RoofParams {
  /** X extent of the roof footprint. Overhang past body width reads as
   *  the eave (no separate `eaveScale`). */
  width: number;
  /** Z extent of the roof footprint. */
  depth: number;
  /** Apex height above the wall top. */
  height: number;
  /** Axis the ridge runs along. Default `'z'` → gable triangle visible
   *  on the +Z face above the door. */
  ridgeAxis?: "x" | "z";
  material: TexturedSpec;
}

export interface DoorParams {
  width: number;
  height: number;
  /** Lateral offset from the +Z face center. Default 0. */
  xOffset?: number;
  material: TexturedSpec;
}

export interface WindowParams {
  side: WindowSide;
  width: number;
  height: number;
  /** Y-center of the window. Default = body mid-height. */
  yCenter?: number;
  /** Lateral offset from face center along the U-axis of the face. Default 0. */
  xOffset?: number;
  material: TexturedSpec;
}

export interface HouseParams {
  body: BodyParams;
  roof: RoofParams;
  door?: DoorParams;
  windows?: WindowParams[];
}

export interface VariantDescriptor {
  name: string;
  label: string;
  canvasPx: number;
  params: HouseParams;
}

export interface VariantReport {
  name: string;
  body: { width: number; depth: number; height: number };
  roof: { width: number; depth: number; height: number; ridgeAxis: "x" | "z" };
  warnings: string[];
}

export interface RoofPlacement {
  perpHalf: number;
  ridgeLen: number;
  height: number;
  yBase: number;
  apexY: number;
  ridgeAxis: "x" | "z";
}

export interface DoorPlacement {
  width: number;
  height: number;
  pos: readonly [number, number, number];
}

export interface WindowPlacement {
  width: number;
  height: number;
  pos: readonly [number, number, number];
  rotY: number;
  material: TexturedSpec;
}

const STONE_BODY: TexturedSpec = {
  kind: "standard",
  color: 0xdb9c7d,
  roughness: 0.85,
  metalness: 0.1,
};
const ROOF_RED: TexturedSpec = {
  kind: "standard",
  color: 0xff7d52,
  roughness: 0.65,
  metalness: 0.2,
  texture: "house_roof_tile",
};
const DOOR_DARK: TexturedSpec = {
  kind: "basic",
  color: 0x91522f,
  side: "double",
};
// Warm candlelight/hearth glow for windows — reads as an occupied
// dwelling against the dark door slit. Basic material so it doesn't
// darken under lighting; the emissive-like warmth sells "lit".
const WINDOW_LIT: TexturedSpec = {
  kind: "basic",
  color: 0xfffb7d,
  side: "double",
};
const _boundsYCache = new Map<string, { minY: number; maxY: number }>();
export const VARIANTS: VariantDescriptor[] = [
  {
    name: "house",
    label: "house",
    // 1×1 tile sprite — canvasPx=32 → game 1× = 16, internal 4× = 128.
    canvasPx: 32,
    // All dimensions authored in cells: 1 cell = 0.125 world = 1 px
    // at game-1×. Body is 14 cells wide (edges at ±7 cells); roof is
    // 16 cells wide so the eave overhangs the walls by 1 cell on each
    // side — just inside the ±1 sprite frustum.
    params: {
      body: {
        width: cells(14),
        depth: cells(14),
        height: cells(7),
        yBase: 0,
        material: STONE_BODY,
      },
      roof: {
        width: cells(16),
        depth: cells(16),
        height: cells(4),
        ridgeAxis: "z",
        material: ROOF_RED,
      },
      // Door shifted 3 cells left on the front face to leave room for
      // a window on the right half.
      door: {
        width: cells(2),
        height: cells(4),
        xOffset: cells(-3),
        material: DOOR_DARK,
      },
      windows: [
        // Front face: small window on the right half, centered vertically.
        {
          side: "+z",
          width: cells(2),
          height: cells(2),
          xOffset: cells(+3),
          material: WINDOW_LIT,
        },
        // One centered window per remaining side.
        { side: "-z", width: cells(2), height: cells(2), material: WINDOW_LIT },
        { side: "+x", width: cells(2), height: cells(2), material: WINDOW_LIT },
        { side: "-x", width: cells(2), height: cells(2), material: WINDOW_LIT },
      ],
    },
  },
];
// ---------- palette ---------------------------------------------------
// Cream/tan stone + red roof + dark accent — distinct from the
// stone-grey + blue-roof palette used by the military towers.
export const PALETTE: [number, number, number][] = [
  // tan / cream stone
  [0x6a, 0x50, 0x40],
  [0x9a, 0x80, 0x60],
  [0xc8, 0xa8, 0x88],
  // red roof
  [0x80, 0x2a, 0x18],
  [0xb0, 0x40, 0x2a],
  [0xd8, 0x60, 0x48],
  // dark accent (door, shadow)
  [0x2a, 0x1a, 0x10],
  [0x0a, 0x0a, 0x0a],
];

/** Authored Y-bounds of a house variant, in authored world units (±1
 *  frustum frame — no internal scale applied). Callers multiply by the
 *  entity-manager's uniform scale (TILE_SIZE / 2) to get world Y. */
export function boundsYOf(
  name: string,
): { minY: number; maxY: number } | undefined {
  const cached = _boundsYCache.get(name);
  if (cached) return cached;
  const variant = getHouseVariant(name);
  if (!variant) return undefined;
  const bounds = measureVariantBoundsY((scratch) => {
    buildHouse(THREE, scratch, variant.params);
  });
  _boundsYCache.set(name, bounds);
  return bounds;
}

export function getHouseVariant(name: string): VariantDescriptor | undefined {
  return findVariant(VARIANTS, name);
}

export function variantReport(variant: VariantDescriptor): VariantReport {
  const warnings: string[] = [];
  const p = variant.params;
  const body = p.body;
  const roof = p.roof;
  if (
    body.width / 2 > FRUSTUM_HALF + BOUND_EPS ||
    body.depth / 2 > FRUSTUM_HALF + BOUND_EPS
  ) {
    warnings.push(
      `body (${body.width}×${body.depth}) extends past the ±${FRUSTUM_HALF} canvas`,
    );
  }
  const roofHalfW = roof.width / 2;
  const roofHalfD = roof.depth / 2;
  if (
    roofHalfW > FRUSTUM_HALF + BOUND_EPS ||
    roofHalfD > FRUSTUM_HALF + BOUND_EPS
  ) {
    warnings.push(
      `roof footprint (${roof.width}×${roof.depth}) extends past the ±${FRUSTUM_HALF} canvas`,
    );
  }
  if (p.door && p.door.height > body.height + BOUND_EPS) {
    warnings.push(`door height ${p.door.height} > wall height ${body.height}`);
  }
  return {
    name: variant.name,
    body: { width: body.width, depth: body.depth, height: body.height },
    roof: {
      width: roof.width,
      depth: roof.depth,
      height: roof.height,
      ridgeAxis: roof.ridgeAxis ?? "z",
    },
    warnings,
  };
}

export function buildHouse(
  three: typeof THREE,
  scene: THREE.Scene | THREE.Group,
  params: HouseParams,
): void {
  const yBase = params.body.yBase ?? 0;

  // Body — square stone box.
  const body = new three.Mesh(
    new three.BoxGeometry(
      params.body.width,
      params.body.height,
      params.body.depth,
    ),
    buildTexturedMaterial(three, params.body.material),
  );
  body.position.set(0, yBase + params.body.height / 2, 0);
  scene.add(body);

  // Gable roof — triangular prism. Build the prism with the ridge
  // along Z (extrude along Z), then optionally rotate 90° around Y if
  // the variant wants the ridge along X.
  const roof = roofPlacement(params);
  const shape = new three.Shape();
  shape.moveTo(-roof.perpHalf, 0);
  shape.lineTo(roof.perpHalf, 0);
  shape.lineTo(0, roof.height);
  shape.closePath();
  const roofGeom = new three.ExtrudeGeometry(shape, {
    depth: roof.ridgeLen,
    bevelEnabled: false,
  });
  // ExtrudeGeometry places the shape at z=0 and extrudes to z=+ridgeLen;
  // translate so the prism is centered on Z (the local origin sits at
  // the wall-top midpoint, which we then position at world (0, wallTop, 0)).
  roofGeom.translate(0, 0, -roof.ridgeLen / 2);
  // Multi-material: ExtrudeGeometry exposes two groups — the front/back
  // caps (index 0, the gable triangles at each end) and the extruded
  // sides (index 1, the two roof slopes + the hidden bottom rectangle).
  // Tinting the caps with the body stone material treats them as wall,
  // not roof.
  const roofMesh = new three.Mesh(roofGeom, [
    buildTexturedMaterial(three, params.body.material), // caps → stone gable triangles
    buildTexturedMaterial(three, params.roof.material), // sides → red slopes
  ]);
  if (roof.ridgeAxis === "x") roofMesh.rotation.y = Math.PI / 2;
  roofMesh.position.set(0, roof.yBase, 0);
  scene.add(roofMesh);

  // Door on the +Z face, flush with ground.
  const door = doorPlacement(params);
  if (door && params.door) {
    const doorMesh = new three.Mesh(
      new three.BoxGeometry(door.width, door.height, 0.02),
      buildTexturedMaterial(three, params.door.material),
    );
    doorMesh.position.set(door.pos[0], door.pos[1], door.pos[2]);
    scene.add(doorMesh);
  }

  // Windows — one thin dark plane per entry in params.windows. Each
  // sits 0.005 world outside the wall face so it wins z-fighting with
  // the body surface.
  for (const w of windowPlacements(params)) {
    const windowMesh = new three.Mesh(
      new three.BoxGeometry(w.width, w.height, 0.02),
      buildTexturedMaterial(three, w.material),
    );
    windowMesh.position.set(w.pos[0], w.pos[1], w.pos[2]);
    windowMesh.rotation.y = w.rotY;
    scene.add(windowMesh);
  }
}

/**
 * Gable roof = triangular prism (ExtrudeGeometry of a triangle profile,
 * extruded along the ridge axis). Returns the canonical (pre-rotation)
 * shape dimensions and where to position the mesh.
 *
 * Convention: build the prism with the ridge along Z (extrude along Z),
 * then rotate 90° around Y if the variant wants the ridge along X. The
 * `perpHalf` is the half-width in the direction PERPENDICULAR to the
 * ridge; `ridgeLen` is the extrusion length.
 */
export function roofPlacement(params: HouseParams): RoofPlacement {
  const r = params.roof;
  const ridgeAxis = r.ridgeAxis ?? "z";
  // Whichever footprint dimension is perpendicular to the ridge becomes
  // the triangle base; the other becomes the prism length. No eaveScale:
  // the roof's width/depth ARE the final footprint (wider than the body
  // is what produces the visible eave overhang).
  const perpExtent = ridgeAxis === "x" ? r.depth : r.width;
  const ridgeExtent = ridgeAxis === "x" ? r.width : r.depth;
  return {
    perpHalf: perpExtent / 2,
    ridgeLen: ridgeExtent,
    height: r.height,
    yBase: bodyTopY(params),
    apexY: bodyTopY(params) + r.height,
    ridgeAxis,
  };
}

export function bodyTopY(params: HouseParams): number {
  return (params.body.yBase ?? 0) + params.body.height;
}

export function doorPlacement(params: HouseParams): DoorPlacement | null {
  if (!params.door) return null;
  const yBase = params.body.yBase ?? 0;
  const x = params.door.xOffset ?? 0;
  return {
    width: params.door.width,
    height: params.door.height,
    pos: [x, yBase + params.door.height / 2, params.body.depth / 2 + 0.005],
  };
}

/**
 * Per-window placement. Returns an array of `{ width, height, pos, rotY }`
 * — `rotY` orients the flat window plane so its +Z face points outward from
 * the wall it sits on.
 */
export function windowPlacements(params: HouseParams): WindowPlacement[] {
  if (!params.windows || params.windows.length === 0) return [];
  const yBase = params.body.yBase ?? 0;
  const halfW = params.body.width / 2;
  const halfD = params.body.depth / 2;
  const bodyMidY = yBase + params.body.height / 2;
  const out: WindowPlacement[] = [];
  for (const w of params.windows) {
    const yCenter = w.yCenter ?? bodyMidY;
    const off = w.xOffset ?? 0;
    let pos: readonly [number, number, number];
    let rotY: number;
    switch (w.side) {
      case "+z":
        pos = [off, yCenter, halfD + 0.005];
        rotY = 0;
        break;
      case "-z":
        pos = [off, yCenter, -halfD - 0.005];
        rotY = Math.PI;
        break;
      case "+x":
        pos = [halfW + 0.005, yCenter, off];
        rotY = Math.PI / 2;
        break;
      case "-x":
        pos = [-halfW - 0.005, yCenter, off];
        rotY = -Math.PI / 2;
        break;
      default:
        continue;
    }
    out.push({
      width: w.width,
      height: w.height,
      pos,
      rotY,
      material: w.material,
    });
  }
  return out;
}
