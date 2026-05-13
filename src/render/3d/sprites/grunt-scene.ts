/**
 * Grunt sprite (small WW2-style tank, 1×1 tile, canvasPx=32) — hull +
 * tracks + a top rig. The top is either a turret + horizontal barrel
 * (regular grunt) or a tilted launcher arm + payload bucket (catapult —
 * siege engine on the same chassis). Four cardinal facings ship per
 * kind; the 3D renderer uses the `_n` variant and rotates by `-facing`.
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

interface BasePlateParams {
  width: number;
  depth: number;
  height: number;
  /** Distance along −Z (forward) from the hull center to the plate
   *  center. Positive values push the pivot point toward the front of
   *  the hull so the arm tips read as projecting beyond the chassis. */
  forwardOffset: number;
  material: MaterialSpec;
}

interface ArmParams {
  /** Arm length from the pivot at the base plate's top to the bucket
   *  center (cylinder length along its local +Y before rotation). */
  length: number;
  radius: number;
  /** Pitch above the horizontal plane, in degrees. The arm rotates
   *  around its base pivot on the X axis so the tip lifts toward −Z; 0
   *  would point straight up, 90 would lie flat forward. The siege-engine
   *  read wants the tip clearly above horizontal but well short of vertical. */
  pitchDegrees: number;
  material: MaterialSpec;
}

interface TurretTop {
  kind: "turret";
  turret: TurretParams;
  barrel: BarrelParams;
}

interface LauncherTop {
  kind: "launcher";
  basePlate: BasePlateParams;
  arm: ArmParams;
  bucket: {
    width: number;
    height: number;
    depth: number;
    material: MaterialSpec;
  };
}

type GruntTop = TurretTop | LauncherTop;

interface GruntParams {
  hull: HullParams;
  tracks: TracksParams;
  top: GruntTop;
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
// muzzle, not an extension of the green hull. Also used for the
// catapult's launcher arm (steel siege beam).
const BARREL_DARK: MaterialSpec = {
  kind: "standard",
  color: 0x717171,
  roughness: 0.5,
  metalness: 0.7,
};
// Matte dark material painted on the hull top under the turret / base
// plate — fakes the AO contact shadow where the upper rig meets the hull.
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
export const VARIANTS: GruntVariant[] = (["N", "E", "S", "W"] as const).flatMap(
  (dir) => [
    {
      name: `grunt_${dir.toLowerCase()}`,
      label: `grunt (facing ${dir})`,
      canvasPx: 32,
      params: gruntParams(FACINGS[dir]),
    },
    {
      name: `catapult_${dir.toLowerCase()}`,
      label: `catapult (facing ${dir})`,
      canvasPx: 32,
      params: catapultParams(FACINGS[dir]),
    },
  ],
);
// ---------- palette ---------------------------------------------------
// Olive greens (hull / turret), dark grays (tracks), barrel/arm dark.
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

  if (params.top.kind === "turret") {
    buildTurretTop(three, group, params, params.top);
  } else {
    buildLauncherTop(three, group, params, params.top);
  }

  // Yaw the whole rig.
  group.rotation.y = three.MathUtils.degToRad(params.yawDegrees ?? 0);
  scene.add(group);
}

function buildTurretTop(
  three: typeof THREE,
  group: THREE.Group,
  params: GruntParams,
  top: TurretTop,
): void {
  // AO shadow disc under the turret — sits on the hull top, half a
  // cell larger than the turret so a thin dark halo reads at the
  // turret-hull contact. +0.001 Y offset wins z-fighting with the
  // hull's top face.
  const aoRadius = top.turret.radius + cells(0.5);
  addAoDisc(three, group, params, aoRadius, 0);

  // Turret — vertical cylinder (axis = Y).
  const turret = new three.Mesh(
    new three.CylinderGeometry(
      top.turret.radius,
      top.turret.radius,
      top.turret.height,
      top.turret.segments ?? 24,
    ),
    createMaterial(top.turret.material),
  );
  const [tx, ty, tz] = turretCenter(params, top);
  turret.position.set(tx, ty, tz);
  group.add(turret);

  // Barrel — cylinder rotated to lie along Z, extending forward (−Z).
  const barrel = new three.Mesh(
    new three.CylinderGeometry(
      top.barrel.radius,
      top.barrel.radius,
      top.barrel.length,
      12,
    ),
    createMaterial(top.barrel.material),
  );
  const place = barrelPlacement(params, top);
  barrel.position.set(place.pos[0], place.pos[1], place.pos[2]);
  barrel.rotation.x = place.rotateXBy;
  group.add(barrel);
}

function buildLauncherTop(
  three: typeof THREE,
  group: THREE.Group,
  params: GruntParams,
  top: LauncherTop,
): void {
  // AO disc spans the base plate footprint plus a small halo so the
  // pivot mount reads as planted on the hull.
  const aoRadius =
    Math.max(top.basePlate.width, top.basePlate.depth) / 2 + cells(0.5);
  const aoCenterZ = -top.basePlate.forwardOffset;
  addAoDisc(three, group, params, aoRadius, aoCenterZ);

  // Base plate — small box mount that sits on the hull top toward the
  // front, marking the pivot point of the launcher arm.
  const plateY = hullTopY(params) + top.basePlate.height / 2;
  const plate = new three.Mesh(
    new three.BoxGeometry(
      top.basePlate.width,
      top.basePlate.height,
      top.basePlate.depth,
    ),
    createMaterial(top.basePlate.material),
  );
  plate.position.set(0, plateY, -top.basePlate.forwardOffset);
  group.add(plate);

  // Arm — cylinder. Authored along its local +Y, then rotated around X
  // so the tip lifts forward-and-up by `pitchDegrees` past horizontal.
  // Pivot sits at the top-front edge of the base plate.
  const pivotY = hullTopY(params) + top.basePlate.height;
  const pivotZ = -top.basePlate.forwardOffset - top.basePlate.depth / 2;
  const armPitchRad = three.MathUtils.degToRad(top.arm.pitchDegrees);
  // Rotate the cylinder so its axis points along (−sin(p)·−Z, cos(p)·+Y)
  // — i.e. up-and-forward when p > 0. Three.js rotates a Y-axis cylinder
  // by `rotation.x = +p` to tilt the +Y end toward −Z.
  const armPivot = new three.Group();
  armPivot.position.set(0, pivotY, pivotZ);
  armPivot.rotation.x = armPitchRad;
  group.add(armPivot);

  const arm = new three.Mesh(
    new three.CylinderGeometry(
      top.arm.radius,
      top.arm.radius,
      top.arm.length,
      12,
    ),
    createMaterial(top.arm.material),
  );
  // Cylinder authored centered on its origin; shift so the base sits at
  // the pivot and the tip is at +length along the rotated +Y axis.
  arm.position.set(0, top.arm.length / 2, 0);
  armPivot.add(arm);

  // Bucket / payload cradle at the tip. A small box mounted just past
  // the tip in the arm's local frame; rotated with the arm group.
  const bucket = new three.Mesh(
    new three.BoxGeometry(
      top.bucket.width,
      top.bucket.height,
      top.bucket.depth,
    ),
    createMaterial(top.bucket.material),
  );
  bucket.position.set(0, top.arm.length + top.bucket.height / 2, 0);
  armPivot.add(bucket);
}

function addAoDisc(
  three: typeof THREE,
  group: THREE.Group,
  params: GruntParams,
  radius: number,
  centerZ: number,
): void {
  const aoGeom = new three.CircleGeometry(radius, 24);
  aoGeom.rotateX(-Math.PI / 2);
  const aoDisc = new three.Mesh(aoGeom, createMaterial(TURRET_AO));
  aoDisc.position.set(0, hullTopY(params) + 0.001, centerZ);
  group.add(aoDisc);
}

/**
 * Barrel sits on the turret's front edge (−Z side, at the cylinder's
 * outer radius) and extends further forward by `length`. Returns the
 * cylinder's center position and the X-rotation needed so the barrel's
 * axis points along −Z.
 */
function barrelPlacement(
  params: GruntParams,
  top: TurretTop,
): {
  pos: readonly [number, number, number];
  rotateXBy: number;
} {
  const [tx, ty, tz] = turretCenter(params, top);
  const turretFrontZ = tz - top.turret.radius;
  const center: readonly [number, number, number] = [
    tx,
    ty,
    turretFrontZ - top.barrel.length / 2,
  ];
  return { pos: center, rotateXBy: Math.PI / 2 };
}

function turretCenter(
  params: GruntParams,
  top: TurretTop,
): readonly [number, number, number] {
  // Turret sits centered on top of the hull.
  return [0, hullTopY(params) + top.turret.height / 2, 0];
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
    top: {
      kind: "turret",
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
    },
    yawDegrees,
  };
}

function catapultParams(yawDegrees: number): GruntParams {
  return {
    // Same hull + tracks as the regular grunt — siege engines ride on
    // the same chassis (same army, different role). The visual
    // distinction is the top: a tilted launcher arm instead of a
    // turret + horizontal barrel.
    hull: {
      width: cells(10),
      depth: cells(13),
      height: cells(5),
      yBase: cells(1),
      material: HULL_GREEN,
    },
    tracks: {
      width: cells(2),
      depth: cells(14),
      height: cells(2),
      endRadius: cells(1),
      xOffset: cells(6),
      material: TRACK_DARK,
      accentMaterial: TRACK_MID,
    },
    top: {
      kind: "launcher",
      // Small mount near the front of the hull where the arm pivots.
      // Sits ~1.5 cells forward of hull center so the arm clearly
      // anchors at the front shoulder rather than dead-centre.
      basePlate: {
        width: cells(5),
        depth: cells(3),
        height: cells(1.5),
        forwardOffset: cells(1.5),
        material: TURRET_GREEN,
      },
      // Inclined steel beam — 7 cells long, pitched 40° above horizontal
      // so the tip lifts well clear of the hull but well short of
      // vertical. Reads as an onager arm at a glance.
      arm: {
        length: cells(7),
        radius: cells(0.6),
        pitchDegrees: 40,
        material: BARREL_DARK,
      },
      // Payload bucket at the tip — a small box that catches the eye as
      // the projectile cradle.
      bucket: {
        width: cells(2.5),
        height: cells(1.5),
        depth: cells(2.5),
        material: HULL_GREEN,
      },
    },
    yawDegrees,
  };
}
