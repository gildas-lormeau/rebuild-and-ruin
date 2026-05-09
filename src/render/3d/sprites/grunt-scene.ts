/**
 * Grunt sprite (small WW2-style tank, 1×1 tile, canvasPx=32) — boxy hull
 * + two tracks with wheel caps + turret + barrel. Four cardinal facing
 * variants ship for the 2D sprite atlas, but the 3D live renderer uses
 * `grunt_n` only and rotates the host group by `-grunt.facing` to match
 * the continuous-rotation convention used by cannons.
 */

import * as THREE from "three";
import {
  type BoxShapeParams,
  cells,
  createMaterial,
  findVariant,
  type MaterialSpec,
  measureVariantBoundsY,
} from "./sprite-kit.ts";

type HullParams = BoxShapeParams;

interface TracksParams {
  width: number;
  depth: number;
  height: number;
  /** Radius of front/back wheel caps. Defaults to height / 2. */
  endRadius?: number;
  /** Distance from center to each track. */
  xOffset: number;
  material: MaterialSpec;
  accentMaterial?: MaterialSpec;
}

interface TurretParams {
  radius: number;
  height: number;
  segments?: number;
  material: MaterialSpec;
}

interface BarrelParams {
  radius: number;
  length: number;
  material: MaterialSpec;
}

interface GruntParams {
  hull: HullParams;
  tracks: TracksParams;
  turret: TurretParams;
  barrel: BarrelParams;
  /** Rotation around Y for the whole rig (degrees, CCW viewed from +Y). */
  yawDegrees?: number;
}

interface GruntVariant {
  name: string;
  label: string;
  canvasPx: number;
  params: GruntParams;
}

const HULL_GREEN: MaterialSpec = {
  kind: "standard",
  color: 0x718d4e,
  roughness: 0.85,
  metalness: 0.1,
};
const TURRET_GREEN: MaterialSpec = {
  kind: "standard",
  color: 0x526d2f,
  roughness: 0.85,
  metalness: 0.1,
};
const TRACK_DARK: MaterialSpec = {
  kind: "standard",
  color: 0x525252,
  roughness: 0.95,
  metalness: 0.2,
};
const TRACK_MID: MaterialSpec = {
  kind: "standard",
  color: 0x717171,
  roughness: 0.95,
  metalness: 0.2,
};
// Gunmetal — clearly non-green so the barrel reads as a steel gun
// muzzle, not an extension of the green hull.
const BARREL_DARK: MaterialSpec = {
  kind: "standard",
  color: 0x717171,
  roughness: 0.5,
  metalness: 0.7,
};
// Matte dark material painted on the hull top under the turret — fakes
// the AO contact shadow where the turret meets the hull.
const TURRET_AO: MaterialSpec = {
  kind: "standard",
  color: 0x1a1a1a,
  roughness: 1.0,
  metalness: 0.0,
};
/**
 * Yaw lookup for cardinal facings. Yaw is rotation CCW around +Y when
 * viewed from above. The base pose has the barrel pointing −Z (north),
 * so:
 *   N → 0   E → −90   S → 180   W → 90
 */
const FACINGS: Readonly<Record<"N" | "E" | "S" | "W", number>> = {
  N: 0,
  E: -90,
  S: 180,
  W: 90,
};
const _boundsYCache = new Map<string, { minY: number; maxY: number }>();
export const VARIANTS: GruntVariant[] = (["N", "E", "S", "W"] as const).map(
  (dir) => ({
    name: `grunt_${dir.toLowerCase()}`,
    label: `grunt (facing ${dir})`,
    canvasPx: 32,
    params: gruntParams(FACINGS[dir]),
  }),
);
// ---------- palette ---------------------------------------------------
// Olive greens (hull / turret), dark grays (tracks), barrel dark.
export const PALETTE: [number, number, number][] = [
  // olive greens
  [0x3a, 0x4a, 0x2a], // dark
  [0x4a, 0x5a, 0x2a],
  [0x5a, 0x6a, 0x3a], // mid (hull)
  [0x6a, 0x7a, 0x4a], // light (turret)
  [0x7a, 0x8a, 0x5a], // highlight
  // tracks (greys)
  [0x1a, 0x1a, 0x1a],
  [0x2a, 0x2a, 0x2a],
  [0x3a, 0x3a, 0x3a],
  [0x4a, 0x4a, 0x4a],
  // dark accent
  [0x0a, 0x0a, 0x0a],
];

/** Authored Y-bounds of a grunt variant, in authored world units (±1
 *  frustum frame — no internal scale applied). Callers multiply by the
 *  entity-manager's uniform scale (TILE_SIZE / 2) to get world Y. */
export function boundsYOf(
  name: string,
): { minY: number; maxY: number } | undefined {
  const cached = _boundsYCache.get(name);
  if (cached) return cached;
  const variant = getGruntVariant(name);
  if (!variant) return undefined;
  const bounds = measureVariantBoundsY((scratch) => {
    buildGrunt(THREE, scratch, variant.params);
  });
  _boundsYCache.set(name, bounds);
  return bounds;
}

/** Look up a grunt variant by name. */
export function getGruntVariant(name: string): GruntVariant | undefined {
  return findVariant(VARIANTS, name);
}

export function buildGrunt(
  three: typeof THREE,
  scene: THREE.Scene | THREE.Group,
  params: GruntParams,
): void {
  const group = new three.Group();

  // Hull
  const hull = new three.Mesh(
    new three.BoxGeometry(
      params.hull.width,
      params.hull.height,
      params.hull.depth,
    ),
    createMaterial(params.hull.material),
  );
  hull.position.set(0, params.hull.yBase + params.hull.height / 2, 0);
  group.add(hull);

  // Two tracks (left, right). Each = central box + 2 cylindrical end
  // caps. From the side the caps render as wheels (drive sprocket +
  // idler the track wraps around).
  const trackMat = createMaterial(params.tracks.material);
  const tH = params.tracks.height;
  const tW = params.tracks.width;
  const tD = params.tracks.depth;
  const endR = params.tracks.endRadius ?? tH / 2;
  const boxDepth = Math.max(0, tD - 2 * endR);
  const yMid = endR; // sit so cylinder bottoms are flush with ground (y=0)
  for (const sx of [-1, +1]) {
    if (boxDepth > 0) {
      const box = new three.Mesh(
        new three.BoxGeometry(tW, tH, boxDepth),
        trackMat,
      );
      box.position.set(sx * params.tracks.xOffset, yMid, 0);
      group.add(box);
    }
    // Front and back end caps (cylinders, axis along X).
    for (const sz of [-1, +1]) {
      const cap = new three.Mesh(
        new three.CylinderGeometry(endR, endR, tW, 16),
        trackMat,
      );
      cap.rotation.z = Math.PI / 2;
      cap.position.set(sx * params.tracks.xOffset, yMid, sz * (boxDepth / 2));
      group.add(cap);
    }
    if (params.tracks.accentMaterial) {
      const accent = new three.Mesh(
        new three.BoxGeometry(tW * 1.02, 0.025, Math.max(0, boxDepth) * 0.95),
        createMaterial(params.tracks.accentMaterial),
      );
      accent.position.set(sx * params.tracks.xOffset, tH + 0.012, 0);
      group.add(accent);
    }
  }

  // AO shadow disc under the turret — sits on the hull top, half a
  // cell larger than the turret so a thin dark halo reads at the
  // turret-hull contact. +0.001 Y offset wins z-fighting with the
  // hull's top face.
  const aoRadius = params.turret.radius + cells(0.5);
  const aoGeom = new three.CircleGeometry(aoRadius, 24);
  aoGeom.rotateX(-Math.PI / 2);
  const aoDisc = new three.Mesh(aoGeom, createMaterial(TURRET_AO));
  aoDisc.position.set(0, hullTopY(params) + 0.001, 0);
  group.add(aoDisc);

  // Turret — vertical cylinder (axis = Y).
  const turret = new three.Mesh(
    new three.CylinderGeometry(
      params.turret.radius,
      params.turret.radius,
      params.turret.height,
      params.turret.segments ?? 24,
    ),
    createMaterial(params.turret.material),
  );
  const [tx, ty, tz] = turretCenter(params);
  turret.position.set(tx, ty, tz);
  group.add(turret);

  // Barrel — cylinder rotated to lie along Z, extending forward (−Z).
  const barrel = new three.Mesh(
    new three.CylinderGeometry(
      params.barrel.radius,
      params.barrel.radius,
      params.barrel.length,
      12,
    ),
    createMaterial(params.barrel.material),
  );
  const place = barrelPlacement(params);
  barrel.position.set(place.pos[0], place.pos[1], place.pos[2]);
  barrel.rotation.x = place.rotateXBy;
  group.add(barrel);

  // Yaw the whole rig.
  group.rotation.y = three.MathUtils.degToRad(params.yawDegrees ?? 0);
  scene.add(group);
}

/**
 * Barrel sits on the turret's front edge (−Z side, at the cylinder's
 * outer radius) and extends further forward by `length`. Returns the
 * cylinder's center position and the X-rotation needed so the barrel's
 * axis points along −Z.
 */
function barrelPlacement(params: GruntParams): {
  pos: readonly [number, number, number];
  rotateXBy: number;
} {
  const [tx, ty, tz] = turretCenter(params);
  const turretFrontZ = tz - params.turret.radius;
  const center: readonly [number, number, number] = [
    tx,
    ty,
    turretFrontZ - params.barrel.length / 2,
  ];
  return { pos: center, rotateXBy: Math.PI / 2 };
}

function turretCenter(params: GruntParams): readonly [number, number, number] {
  // Turret sits centered on top of the hull.
  return [0, hullTopY(params) + params.turret.height / 2, 0];
}

function hullTopY(params: GruntParams): number {
  return params.hull.yBase + params.hull.height;
}

function gruntParams(yawDegrees: number): GruntParams {
  return {
    // Footprint in cells (1 cell = 0.125 world):
    //   tracks: 2 cells wide × 14 cells deep, centred ±6 cells on X
    //     (outer edge at ±7 cells)
    //   hull: 10 × 13 × 5 cells, yBase 1 cell (sits on the tracks
    //     so the tracks stick ~1 cell below the hull)
    //   turret: radius 3 cells, height 3 cells
    //   barrel: radius ½ cell, length 4 cells (tip at -7 cells)
    hull: {
      width: cells(10),
      depth: cells(13),
      height: cells(5),
      yBase: cells(1),
      material: HULL_GREEN,
    },
    tracks: {
      // Central box plus two cylindrical end caps. From the side the
      // caps look like circular wheels (drive sprocket + idler the
      // track wraps around). `endRadius` defaults to height/2 so the
      // caps are flush with the box height.
      width: cells(2),
      depth: cells(14),
      height: cells(2),
      endRadius: cells(1), // = height / 2
      xOffset: cells(6),
      material: TRACK_DARK,
      accentMaterial: TRACK_MID,
    },
    turret: {
      // Cylindrical turret (vertical axis) centred on the hull.
      radius: cells(3),
      height: cells(3),
      segments: 24,
      material: TURRET_GREEN,
    },
    barrel: {
      // Sticks out from the turret's −Z face. Length 4 cells → tip at
      //   z = −(turret.radius 3 + barrel.length 4) cells = −7 cells.
      radius: cells(0.5),
      length: cells(4),
      material: BARREL_DARK,
    },
    yawDegrees,
  };
}
