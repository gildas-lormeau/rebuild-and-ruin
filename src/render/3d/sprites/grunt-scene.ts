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
  /** Forward arm length from the pivot to the bucket end. */
  length: number;
  /** Rear arm length past the pivot (the short side of the see-saw).
   *  Renders the trebuchet/mangonel silhouette where the arm extends on
   *  both sides of the pivot, with the counterweight at the rear tip. */
  rearLength: number;
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
  /** A-frame uprights — two posts on the base plate. Inlined (not
   *  extracted) because the {width, height, depth, material} subset
   *  collides with several generic box-shaped helpers in the sprite
   *  library; keeping it local avoids forcing a cross-cell type
   *  dependency the shape-duplicates lint would flag. */
  uprights: {
    width: number;
    depth: number;
    height: number;
    /** Distance from the arm centerline (each post is mirrored on ±X). */
    xOffset: number;
    material: MaterialSpec;
  };
  arm: ArmParams;
  /** Stone weight at the rear arm tip. Inlined (not extracted) because
   *  its `{width, height, depth, material}` shape collides with several
   *  generic box-shaped helpers across the sprite library; keeping it
   *  local avoids forcing a cross-cell type dependency. */
  counterweight: {
    width: number;
    height: number;
    depth: number;
    material: MaterialSpec;
  };
  /** Wooden spoon-bowl at the throwing tip. Flared cone — narrow end
   *  attaches to the arm, wide end is the bowl opening that holds the
   *  payload. Axis is along the arm's local +Y (rotates with the arm). */
  bucket: {
    /** Radius at the arm-tip end (narrow). */
    radiusInner: number;
    /** Radius at the far end (the bowl opening). */
    radiusOuter: number;
    /** Length along the arm axis. */
    length: number;
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
// muzzle, not an extension of the green hull.
const BARREL_DARK: MaterialSpec = {
  kind: "standard",
  color: 0x717171,
  roughness: 0.5,
  metalness: 0.7,
};
// Warmer, weathered olive for the catapult hull — pushes the chassis
// toward brown-yellow so the green doesn't dominate the read. Same
// "tank-shaped" silhouette, but visibly the dustier/older sibling of
// the regular grunt's bright olive.
const CATAPULT_HULL: MaterialSpec = {
  kind: "standard",
  color: 0x6e6740,
  roughness: 0.9,
  metalness: 0.1,
};
// Warm saddle-brown wood for the catapult arm + base plate — contrasts
// the chassis from any camera angle so the silhouette also reads as
// colour-distinct, not just shape-distinct. Matte (rope-bound timber).
const CATAPULT_ARM_WOOD: MaterialSpec = {
  kind: "standard",
  color: 0x8b5a2b,
  roughness: 0.95,
  metalness: 0.05,
};
// Same wood as the arm, but double-sided so the open spoon-bowl's inner
// wall renders correctly (the bucket cylinder is openEnded so the bowl
// looks concave from any camera angle, not like a solid paddle face).
const CATAPULT_BOWL_WOOD: MaterialSpec = {
  kind: "standard",
  color: 0x8b5a2b,
  roughness: 0.95,
  metalness: 0.05,
  side: "double",
};
// Weathered stone-gray for the counterweight — visually heavy and a
// different hue from the wood (arm + bowl), so the rear weight reads as
// a distinct mass balancing the throwing arm.
const CATAPULT_STONE: MaterialSpec = {
  kind: "standard",
  color: 0x6b6358,
  roughness: 0.95,
  metalness: 0.0,
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
  // catapult stone (counterweight)
  [0x6b, 0x63, 0x58],
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

  // Uprights — two posts standing on the base plate, raising the pivot
  // above the chassis so the see-saw arm has visible structural support.
  // Authored centered on the pivot Z (front edge of the base plate); the
  // arm swings between them.
  const plateTopY = hullTopY(params) + top.basePlate.height;
  const pivotZ = -top.basePlate.forwardOffset - top.basePlate.depth / 2;
  const uprightY = plateTopY + top.uprights.height / 2;
  const uprightMat = createMaterial(top.uprights.material);
  for (const sign of [-1, +1] as const) {
    const post = new three.Mesh(
      new three.BoxGeometry(
        top.uprights.width,
        top.uprights.height,
        top.uprights.depth,
      ),
      uprightMat,
    );
    post.position.set(sign * top.uprights.xOffset, uprightY, pivotZ);
    group.add(post);
  }

  // Arm pivot — sits at the top of the uprights, on the front edge of
  // the base plate. The arm group is rotated around X so the throwing
  // tip lifts forward-and-up by `pitchDegrees` past horizontal.
  const pivotY = plateTopY + top.uprights.height;
  const armPitchRad = three.MathUtils.degToRad(top.arm.pitchDegrees);
  const armPivot = new three.Group();
  armPivot.position.set(0, pivotY, pivotZ);
  armPivot.rotation.x = armPitchRad;
  group.add(armPivot);

  // See-saw arm — a single cylinder spanning the rear (counterweight)
  // side and the forward (throwing) side of the pivot. Center the
  // cylinder so its rear end is at local y=−rearLength and its forward
  // tip is at local y=+length.
  const totalArmLength = top.arm.length + top.arm.rearLength;
  const arm = new three.Mesh(
    new three.CylinderGeometry(
      top.arm.radius,
      top.arm.radius,
      totalArmLength,
      12,
    ),
    createMaterial(top.arm.material),
  );
  arm.position.set(0, (top.arm.length - top.arm.rearLength) / 2, 0);
  armPivot.add(arm);

  // Counterweight — stone block at the rear arm tip. Rigid-mounted in
  // the arm's local frame so it rotates with the arm.
  const cw = new three.Mesh(
    new three.BoxGeometry(
      top.counterweight.width,
      top.counterweight.height,
      top.counterweight.depth,
    ),
    createMaterial(top.counterweight.material),
  );
  cw.position.set(0, -top.arm.rearLength - top.counterweight.height / 2, 0);
  armPivot.add(cw);

  // Bucket / spoon-bowl at the forward tip. Open-ended flared cylinder
  // — narrow end attaches to the arm tip, wide opening is the bowl
  // mouth. Rotated −90° around X within armPivot so the bowl's axis is
  // perpendicular to the arm (i.e. the flat bottom of the bowl is
  // parallel to the arm beam). Bowl opens "up-and-back" relative to the
  // arm tip, tilted at the same angle as the arm (rigid wooden spoon).
  const bucket = new three.Mesh(
    new three.CylinderGeometry(
      top.bucket.radiusOuter,
      top.bucket.radiusInner,
      top.bucket.length,
      20,
      1,
      true,
    ),
    createMaterial(top.bucket.material),
  );
  bucket.rotation.x = -Math.PI / 2;
  bucket.position.set(0, top.arm.length, top.bucket.length / 2);
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
    // Same hull + tracks shape as the regular grunt — siege engines ride
    // on the same chassis (same army, different role). Hull tint is
    // shifted toward weathered brown-olive so the green doesn't
    // dominate the read; the wooden upper rig sits on it naturally.
    hull: {
      width: cells(10),
      depth: cells(13),
      height: cells(5),
      yBase: cells(1),
      material: CATAPULT_HULL,
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
      // Wooden mount near the front of the hull where the arm pivots.
      // Sits ~1.5 cells forward of hull center so the arm clearly
      // anchors at the front shoulder rather than dead-centre. Same
      // wood material as the arm — the whole upper rig is timber.
      basePlate: {
        width: cells(5),
        depth: cells(3),
        height: cells(1.5),
        forwardOffset: cells(1.5),
        material: CATAPULT_ARM_WOOD,
      },
      // A-frame uprights — two wooden posts on left/right of the arm,
      // raising the pivot above the base plate so the see-saw arm has
      // visible structural support. xOffset cells(2) keeps the cells(0.6)
      // -radius arm well clear of both posts.
      uprights: {
        width: cells(0.7),
        depth: cells(1.2),
        height: cells(2),
        xOffset: cells(2),
        material: CATAPULT_ARM_WOOD,
      },
      // Inclined wooden beam — pitched 40° above horizontal. `length` is
      // the long throwing side (pivot → bucket); `rearLength` is the
      // short counterweight side. Together they form a see-saw whose
      // rear tip sits low and behind the pivot.
      arm: {
        length: cells(7),
        rearLength: cells(2.5),
        radius: cells(0.6),
        pitchDegrees: 40,
        material: CATAPULT_ARM_WOOD,
      },
      // Stone counterweight at the rear arm tip. Rigid-mounted (rotates
      // with the arm); visually balances the throwing side.
      counterweight: {
        width: cells(2.5),
        height: cells(2),
        depth: cells(2.5),
        material: CATAPULT_STONE,
      },
      // Wooden spoon-bowl at the throwing tip. Same wood as the arm so
      // it reads as a continuous mangonel ladle (the bowl is the carved
      // end of the beam, not a separate part). Flared cone — narrow end
      // (cells(1.0)) attaches to the arm, wide end (cells(2.0)) is the
      // bowl opening that faces up-and-forward when the arm is loaded.
      // Open-ended + double-sided wood so the inside cone wall renders
      // (reads as a concave bowl from any angle, not a solid paddle).
      bucket: {
        radiusInner: cells(1.0),
        radiusOuter: cells(2.0),
        length: cells(3),
        material: CATAPULT_BOWL_WOOD,
      },
    },
    yawDegrees,
  };
}
