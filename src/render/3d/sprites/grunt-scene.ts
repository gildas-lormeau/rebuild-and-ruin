/**
 * grunt-scene.ts — grunt sprite (small WW2-style tank).
 *
 * TypeScript conversion of the original `grunt-scene.mjs`. Grunts are
 * 1×1 tile in Rampart (canvasPx=32, matching the house). The geometry
 * is a boxy tank silhouette — hull, two tracks with cylindrical end
 * caps (wheels), turret, barrel — that fills the available top-down
 * footprint.
 *
 * The scene ships four cardinal facings (`grunt_n`, `grunt_e`,
 * `grunt_s`, `grunt_w`) whose geometry is IDENTICAL — only
 * `params.yawDegrees` differs (0 / -90 / 180 / 90). For the 3D live
 * renderer the grunts manager uses a single base variant (`grunt_n`,
 * barrel pointing −Z) and rotates the host group by `-grunt.facing` on
 * Y, matching the continuous-rotation convention used by cannons.
 * The per-facing variants are kept here for parity with the 2D sprite
 * atlas and offline sprite verification, but production does not call
 * them with non-zero yaw.
 *
 * THREE is injected to `buildGrunt(THREE, scene, params)` so this
 * module stays free of three.js as a static dependency — matches the
 * convention of the other `*-scene.ts` files.
 */

import type * as THREE from "three";
import { BOUND_EPS, FRUSTUM_HALF } from "./sprite-bounds.ts";
import { cells, createMaterial, type MaterialSpec } from "./sprite-kit.ts";

export interface HullParams {
  width: number;
  depth: number;
  height: number;
  yBase?: number;
  material: MaterialSpec;
}

export interface TracksParams {
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

export interface TurretParams {
  radius: number;
  height: number;
  segments?: number;
  material: MaterialSpec;
}

export interface BarrelParams {
  radius: number;
  length: number;
  material: MaterialSpec;
}

export interface GruntParams {
  hull: HullParams;
  tracks: TracksParams;
  turret: TurretParams;
  barrel: BarrelParams;
  /** Rotation around Y for the whole rig (degrees, CCW viewed from +Y). */
  yawDegrees?: number;
}

export interface GruntVariant {
  name: string;
  label: string;
  canvasPx: number;
  params: GruntParams;
}

export interface GruntVariantReport {
  name: string;
  yaw: number;
  xExtent: number;
  forwardExtent: number;
  hullTop: number;
  warnings: string[];
}

const HULL_GREEN: MaterialSpec = {
  kind: "standard",
  color: 0x3a4828,
  roughness: 0.85,
  metalness: 0.1,
};
const TURRET_GREEN: MaterialSpec = {
  kind: "standard",
  color: 0x2a3818,
  roughness: 0.85,
  metalness: 0.1,
};
const TRACK_DARK: MaterialSpec = {
  kind: "standard",
  color: 0x2a2a2a,
  roughness: 0.95,
  metalness: 0.2,
};
const TRACK_MID: MaterialSpec = {
  kind: "standard",
  color: 0x3a3a3a,
  roughness: 0.95,
  metalness: 0.2,
};
// Gunmetal — clearly non-green so the barrel reads as a steel gun
// muzzle, not an extension of the green hull.
const BARREL_DARK: MaterialSpec = {
  kind: "standard",
  color: 0x3a3a3a,
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

/** Look up a grunt variant by name. */
export function getGruntVariant(name: string): GruntVariant | undefined {
  return VARIANTS.find((variant) => variant.name === name);
}

export function variantReport(variant: GruntVariant): GruntVariantReport {
  const warnings: string[] = [];
  const p = variant.params;
  // Aggregate footprint = max of (hull + tracks side-by-side) in both
  // X and Z, with the rig rotated by yaw. Since rotation around Y can
  // be 90°, just take the larger of the two extents and check ≤ 1.
  const hullMaxX = p.hull.width / 2;
  const trackMaxX = p.tracks.xOffset + p.tracks.width / 2;
  const xExtent = Math.max(hullMaxX, trackMaxX);
  const zExtent = Math.max(p.hull.depth, p.tracks.depth) / 2;
  // Barrel can stick out past the hull / tracks in front (depends on
  // turret radius + barrel length). Account for it in the FORWARD direction.
  const barrelTipZ = -p.turret.radius - p.barrel.length;
  const forwardExtent = Math.max(zExtent, -barrelTipZ);
  if (Math.max(xExtent, forwardExtent) > FRUSTUM_HALF + BOUND_EPS) {
    warnings.push(
      `extent exceeds ±${FRUSTUM_HALF}: xExtent=${xExtent.toFixed(3)}, ` +
        `forwardExtent=${forwardExtent.toFixed(3)}`,
    );
  }
  return {
    name: variant.name,
    yaw: p.yawDegrees ?? 0,
    xExtent,
    forwardExtent,
    hullTop: hullTopY(p),
    warnings,
  };
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
  hull.position.set(0, (params.hull.yBase ?? 0) + params.hull.height / 2, 0);
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
export function barrelPlacement(params: GruntParams): {
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

export function turretCenter(
  params: GruntParams,
): readonly [number, number, number] {
  // Turret sits centered on top of the hull.
  return [0, hullTopY(params) + params.turret.height / 2, 0];
}

export function hullTopY(params: GruntParams): number {
  return (params.hull.yBase ?? 0) + params.hull.height;
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
