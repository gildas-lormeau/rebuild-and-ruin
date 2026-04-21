/**
 * balloon-scene.ts — balloon cannon: ground base + in-flight envelope.
 *
 * TypeScript conversion of the original `balloon-scene.mjs`. Two
 * variants matching the existing pixel sprites in
 * scripts/generate-sprites.html:
 *
 *   balloon_base (2×2 tile)   — empty mooring on the ground:
 *     • 4 corner wooden stakes
 *     • ropes outlining the square between stakes
 *     • central metal mooring disc + dark bolt
 *     • a deflated red balloon resting on the mooring
 *
 *   balloon_flight (2×2 tile wide × 3 tall) — deployed:
 *     • red ellipsoid envelope hovering above
 *     • 8 vertical gore seams along the envelope meridians
 *     • darker load ring just below the equator
 *     • wooden basket with top/bottom rims and a mid-band
 *     • 4 ropes connecting basket corners to envelope underside
 *       (each rope grazes the sphere at its tangent point)
 *
 * THREE is injected to `buildBalloon(THREE, scene, variant)` so this
 * module stays free of three.js as a static dependency — matches the
 * convention of the other `*-scene.ts` files. `buildBalloon` takes the
 * full variant (not just params) and routes internally by `variant.name`.
 */

import type * as THREE from "three";
import { BOUND_EPS, FRUSTUM_HALF, fmtBound } from "./sprite-bounds.ts";
import { cells, createMaterial, type MaterialSpec } from "./sprite-kit.ts";
import { GROUND_AO, GROUND_SHADOW } from "./sprite-materials.ts";

export interface EnvelopeParams {
  radius: number;
  yScale: number;
  yCenter: number;
  material: MaterialSpec;
}

export interface BasketParams {
  width: number;
  depth: number;
  height: number;
  yCenter: number;
  material: MaterialSpec;
  rimMaterial?: MaterialSpec;
}

export interface FlightRopesParams {
  radius: number;
  material: MaterialSpec;
}

export interface GoresParams {
  count: number;
  tubeRadius: number;
  material: MaterialSpec;
}

export interface LoadRingParams {
  yRelativeToCenter: number;
  radiusScale: number;
  tubeRadius: number;
  material: MaterialSpec;
}

export interface BalloonFlightParams {
  envelope: EnvelopeParams;
  basket: BasketParams;
  ropes: FlightRopesParams;
  gores?: GoresParams;
  loadRing?: LoadRingParams;
}

export interface StakesParams {
  radius: number;
  height: number;
  footprintHalf: number;
  material: MaterialSpec;
}

export interface StakeRopesParams {
  radius: number;
  material: MaterialSpec;
}

export interface MooringParams {
  outerRadius: number;
  height: number;
  material: MaterialSpec;
}

export interface BoltParams {
  width: number;
  height: number;
  material: MaterialSpec;
}

export interface DeflatedBalloonParams {
  radius: number;
  ySquash: number;
  material: MaterialSpec;
}

export interface GroundDiscParams {
  radius: number;
  yPos: number;
  material: MaterialSpec;
}

export interface BalloonBaseParams {
  stakes: StakesParams;
  stakeRopes: StakeRopesParams;
  mooring: MooringParams;
  bolt: BoltParams;
  deflatedBalloon: DeflatedBalloonParams;
  groundShadow?: GroundDiscParams;
  groundAO?: GroundDiscParams;
}

export type BalloonParams = BalloonFlightParams | BalloonBaseParams;

export interface BalloonFlightVariant {
  name: "balloon_flight";
  label: string;
  canvasPx: number;
  canvasPxH: number;
  params: BalloonFlightParams;
}

export interface BalloonBaseVariant {
  name: "balloon_base";
  label: string;
  canvasPx: number;
  params: BalloonBaseParams;
}

export type BalloonVariant = BalloonFlightVariant | BalloonBaseVariant;

export interface BalloonVariantReport {
  name: string;
  warnings: string[];
}

export interface StakePosition {
  name: "NW" | "NE" | "SE" | "SW";
  x: number;
  z: number;
}

export interface StakeRopeSegment {
  from: StakePosition;
  to: StakePosition;
  length: number;
  axis: "x" | "z";
  midpoint: readonly [number, number, number];
}

const ENVELOPE_RED: MaterialSpec = {
  kind: "standard",
  color: 0xff5e5e,
  roughness: 0.55,
  metalness: 0.1,
};
const ENVELOPE_DARK: MaterialSpec = {
  kind: "standard",
  color: 0xfa3e3e,
  roughness: 0.6,
  metalness: 0.1,
};
const ENVELOPE_SEAM: MaterialSpec = {
  kind: "standard",
  color: 0xbc2f2f,
  roughness: 0.7,
  metalness: 0.1,
};
const DEFLATED_RED: MaterialSpec = {
  kind: "standard",
  color: 0xfa5e5e,
  roughness: 0.65,
  metalness: 0.1,
};
const ROPE_BROWN: MaterialSpec = {
  kind: "standard",
  color: 0xcfb071,
  roughness: 0.95,
  metalness: 0.0,
};
const BASKET_WOOD: MaterialSpec = {
  kind: "standard",
  color: 0xffcd27,
  roughness: 0.9,
  metalness: 0.0,
};
const BASKET_RIM: MaterialSpec = {
  kind: "standard",
  color: 0xcf9113,
  roughness: 0.9,
  metalness: 0.0,
};
const STAKE_WOOD: MaterialSpec = {
  kind: "standard",
  color: 0x91713e,
  roughness: 0.95,
  metalness: 0.0,
};
const MOORING_LIGHT: MaterialSpec = {
  kind: "standard",
  color: 0xdbdbdb,
  roughness: 0.4,
  metalness: 0.85,
};
const MOORING_DARK: MaterialSpec = {
  kind: "standard",
  color: 0x636363,
  roughness: 0.45,
  metalness: 0.85,
};
export const VARIANTS: BalloonVariant[] = [
  {
    name: "balloon_flight",
    label: "balloon (in flight)",
    // 2 tiles wide × 3 tiles tall → canvas 64 × 96 (game 2×).
    canvasPx: 64,
    canvasPxH: 96,
    params: {
      // Envelope is a tall ovaloid (yScale 1.45 → height/width ≈ 1.45).
      // Basket sits near the canvas bottom; ropes span a tall gap.
      // Total Y span ≈ 3.26 (envelope top 1.72 to basket bottom −1.54),
      // filling ~94% of the tilted-view frustum (±1.725 → 3.45).
      envelope: {
        // radius/yScale are shape floats (off-grid: 0.55 world = 4.4
        // cells, yScale is a unitless stretch factor).
        radius: 0.55,
        yScale: 1.45,
        yCenter: cells(7),
        material: ENVELOPE_RED,
      },
      basket: {
        width: cells(3),
        depth: cells(3),
        height: cells(2),
        yCenter: cells(-11),
        material: BASKET_WOOD,
        rimMaterial: BASKET_RIM,
      },
      ropes: {
        // Four ropes — anchor points are auto-computed in
        // flightRopeAnchors as the tangent points on the envelope, so
        // each rope grazes the sphere from the corresponding basket
        // corner. `radius` is a thin-geometry tuning float.
        radius: 0.012,
        material: ROPE_BROWN,
      },
      // Vertical panel seams: 8 thin half-toroidal arcs following the
      // ellipsoid's meridians, evenly spaced around Y. Classic balloon
      // gore detail — readable from top-down and 3/4 view.
      gores: {
        count: 8,
        // Thin tube radius — kept as a free-valued float.
        tubeRadius: 0.012,
        material: ENVELOPE_SEAM,
      },
      // Load ring: darker full ring just below the equator where the
      // ropes converge on the envelope underside. `yRelativeToCenter`
      // and `radiusScale` are shape tuners (not on the cell grid).
      loadRing: {
        yRelativeToCenter: -0.08,
        radiusScale: 0.99,
        tubeRadius: 0.018,
        material: ENVELOPE_DARK,
      },
    },
  },
  {
    name: "balloon_base",
    label: "balloon base (deflated)",
    canvasPx: 64,
    params: {
      stakes: {
        // 4 wooden corner pegs at the canvas corners. `radius` is a
        // thin-cylinder tuner.
        radius: 0.05,
        height: cells(1.5),
        footprintHalf: cells(7),
        material: STAKE_WOOD,
      },
      stakeRopes: {
        // 4 horizontal ropes between adjacent stakes (square outline).
        radius: 0.018,
        material: ROPE_BROWN,
      },
      mooring: {
        // Central metal disc with bolt. `outerRadius` is a shape tuner
        // (0.2 world ≈ 1.6 cells).
        outerRadius: 0.2,
        height: cells(0.5),
        material: MOORING_LIGHT,
      },
      bolt: {
        width: cells(0.5),
        height: cells(1),
        material: MOORING_DARK,
      },
      deflatedBalloon: {
        // Flat-squashed sphere resting on the mooring. `radius` and
        // `ySquash` are shape tuners.
        radius: 0.32,
        ySquash: 0.3,
        material: DEFLATED_RED,
      },
      // Broad ground shadow filling the 2×2 tile, plus a tighter AO
      // disc just past the stake footprint to anchor the base on the
      // tile. `yPos` values are tiny z-fight offsets above the ground
      // plane (off-grid by design).
      groundShadow: { radius: cells(8), yPos: 0.002, material: GROUND_SHADOW },
      groundAO: { radius: cells(7.5), yPos: 0.005, material: GROUND_AO },
    },
  },
];
// ---------- palette ---------------------------------------------------
// Mostly red (envelope/balloon) + brown/wood (basket, stakes, ropes) +
// metal greys (mooring) + dark accents.
export const PALETTE: [number, number, number][] = [
  // red
  [0x60, 0x18, 0x18],
  [0x80, 0x20, 0x20],
  [0xa0, 0x30, 0x30],
  [0xb0, 0x30, 0x30],
  [0xd8, 0x60, 0x48],
  // wood (basket, stakes, ropes)
  [0x4a, 0x3a, 0x20],
  [0x6a, 0x4a, 0x0a],
  [0x6a, 0x5a, 0x3a],
  [0x8b, 0x69, 0x14],
  [0xa0, 0x7a, 0x1a],
  // metal (mooring)
  [0x33, 0x33, 0x33],
  [0x55, 0x55, 0x55],
  [0x70, 0x70, 0x70],
  // dark accent
  [0x0a, 0x0a, 0x0a],
];

/** Look up a balloon variant by name. Matches the other scene files'
 *  helper so the entity manager can fetch params by variant string. */
export function getBalloonVariant(name: string): BalloonVariant | undefined {
  return VARIANTS.find((variant) => variant.name === name);
}

export function variantReport(variant: BalloonVariant): BalloonVariantReport {
  const warnings: string[] = [];
  // Canvas aspect (height / width). Top-view frustum extends to ±aspect
  // in Z; tilted view's vertical extent is ±aspect·1.15 (the +15%
  // padding the pipeline applies for the tilted camera). This tilted-Y
  // bound is specific to the tall balloon_flight sprite and isn't
  // shared with any other scene, so it stays inline here.
  if (variant.name === "balloon_base") {
    const p = variant.params;
    const f = p.stakes.footprintHalf;
    if (f > FRUSTUM_HALF + BOUND_EPS)
      warnings.push(fmtBound("stake footprint half", f));
    const balloonR = p.deflatedBalloon.radius;
    if (balloonR > FRUSTUM_HALF + BOUND_EPS)
      warnings.push(fmtBound("deflated balloon r", balloonR));
  } else {
    const p = variant.params;
    const aspect = variant.canvasPxH / variant.canvasPx;
    const yBound = aspect * 1.15;
    const r = p.envelope.radius;
    if (r > FRUSTUM_HALF + BOUND_EPS)
      warnings.push(fmtBound("envelope r (X)", r));
    const eTop = p.envelope.yCenter + p.envelope.radius * p.envelope.yScale;
    const eBottom = p.envelope.yCenter - p.envelope.radius * p.envelope.yScale;
    const bBottom = p.basket.yCenter - p.basket.height / 2;
    if (bBottom < -yBound - BOUND_EPS)
      warnings.push(`basket bottom y=${bBottom} past −${yBound.toFixed(3)}`);
    if (eTop > yBound + BOUND_EPS)
      warnings.push(`envelope top y=${eTop} past +${yBound.toFixed(3)}`);
    if (eBottom <= bBottom)
      warnings.push("envelope bottom must sit above basket bottom");
  }
  return { name: variant.name, warnings };
}

export function buildBalloon(
  three: typeof THREE,
  scene: THREE.Scene | THREE.Group,
  variant: BalloonVariant,
): void {
  if (variant.name === "balloon_flight") {
    buildBalloonFlight(three, scene, variant.params);
    return;
  }
  if (variant.name === "balloon_base") {
    buildBalloonBase(three, scene, variant.params);
    return;
  }
  // Exhaustiveness check — if a new variant is added, this is a type error.
  const _exhaustive: never = variant;
  throw new Error(
    `buildBalloon: unknown variant ${JSON.stringify(_exhaustive)}`,
  );
}

function buildBalloonFlight(
  three: typeof THREE,
  scene: THREE.Scene | THREE.Group,
  params: BalloonFlightParams,
): void {
  // Envelope — sphere scaled in Y to make a tall ellipsoid.
  const envelope = new three.Mesh(
    new three.SphereGeometry(params.envelope.radius, 32, 24),
    createMaterial(params.envelope.material),
  );
  envelope.scale.set(1, params.envelope.yScale, 1);
  envelope.position.set(0, params.envelope.yCenter, 0);
  scene.add(envelope);

  // Gores — 8 vertical meridian seams on the ellipsoid surface.
  // TorusGeometry: a ring in its local XY plane, arc=π gives a
  // semicircle. Start angle is at +X so we rotate the GEOMETRY by π/2
  // about Z to move the arc endpoints onto the poles (0, ±r). After
  // y-scaling, each rotated copy is a meridian on the ellipsoid (math
  // verified: points satisfy x²/R² + y²/(R·yScale)² + z²/R² = 1).
  if (params.gores) {
    const g = params.gores;
    const goreGeom = new three.TorusGeometry(
      params.envelope.radius,
      g.tubeRadius,
      6,
      24,
      Math.PI,
    );
    goreGeom.rotateZ(Math.PI / 2);
    goreGeom.scale(1, params.envelope.yScale, 1);
    const goreMat = createMaterial(g.material);
    for (let i = 0; i < g.count; i++) {
      const gore = new three.Mesh(goreGeom, goreMat);
      gore.rotation.y = (i / g.count) * Math.PI * 2;
      gore.position.set(0, params.envelope.yCenter, 0);
      scene.add(gore);
    }
  }

  // Load ring — darker horizontal torus just below the equator where
  // the ropes converge visually on the envelope underside.
  if (params.loadRing) {
    const lr = params.loadRing;
    const ringGeom = new three.TorusGeometry(
      params.envelope.radius * lr.radiusScale,
      lr.tubeRadius,
      8,
      32,
    );
    ringGeom.rotateX(Math.PI / 2);
    const ring = new three.Mesh(ringGeom, createMaterial(lr.material));
    ring.position.set(0, params.envelope.yCenter + lr.yRelativeToCenter, 0);
    scene.add(ring);
  }

  // Basket
  const basket = new three.Mesh(
    new three.BoxGeometry(
      params.basket.width,
      params.basket.height,
      params.basket.depth,
    ),
    createMaterial(params.basket.material),
  );
  basket.position.set(0, params.basket.yCenter, 0);
  scene.add(basket);

  // Basket rims — thin slabs slightly oversized on XZ at the top AND
  // bottom. The pair bookends the basket silhouette from 3/4 view.
  // Mid-band — thin dark horizontal strap around the basket waist.
  if (params.basket.rimMaterial) {
    const rimH = 0.03125;
    const rimW = params.basket.width * 1.05;
    const rimD = params.basket.depth * 1.05;
    const rimMat = createMaterial(params.basket.rimMaterial);
    const topY = params.basket.yCenter + params.basket.height / 2 + rimH / 2;
    const botY = params.basket.yCenter - params.basket.height / 2 - rimH / 2;
    const topRim = new three.Mesh(
      new three.BoxGeometry(rimW, rimH, rimD),
      rimMat,
    );
    topRim.position.set(0, topY, 0);
    scene.add(topRim);
    const botRim = new three.Mesh(
      new three.BoxGeometry(rimW, rimH, rimD),
      rimMat,
    );
    botRim.position.set(0, botY, 0);
    scene.add(botRim);
    // Mid-band: slightly smaller XZ than the rims so the rim still
    // reads as the outermost edge.
    const bandH = 0.03125;
    const band = new three.Mesh(
      new three.BoxGeometry(
        params.basket.width * 1.03,
        bandH,
        params.basket.depth * 1.03,
      ),
      rimMat,
    );
    band.position.set(0, params.basket.yCenter, 0);
    scene.add(band);
  }

  // Ropes — 4 thin cylinders from basket corners to envelope underside.
  const anchors = flightRopeAnchors(params);
  const ropeMat = createMaterial(params.ropes.material);
  for (let i = 0; i < 4; i++) {
    const [bx, by, bz] = anchors.basket[i]!;
    const [ex, ey, ez] = anchors.envelope[i]!;
    const dx = ex - bx;
    const dy = ey - by;
    const dz = ez - bz;
    const len = Math.hypot(dx, dy, dz);
    const rope = new three.Mesh(
      new three.CylinderGeometry(
        params.ropes.radius,
        params.ropes.radius,
        len,
        8,
      ),
      ropeMat,
    );
    // Cylinder default axis is +Y. Orient it so it points from basket
    // anchor to envelope anchor.
    rope.position.set((bx + ex) / 2, (by + ey) / 2, (bz + ez) / 2);
    // Compute rotation: rotate +Y axis to direction (dx, dy, dz).
    const dir = new three.Vector3(dx, dy, dz).normalize();
    const yAxis = new three.Vector3(0, 1, 0);
    rope.quaternion.setFromUnitVectors(yAxis, dir);
    scene.add(rope);
  }
}

/**
 * Anchor positions for the four basket-to-envelope ropes.
 *
 * The envelope anchors are the tangent points on the envelope sphere
 * for a straight rope coming from the corresponding basket corner.
 * Each rope grazes the sphere at exactly one point — visually "wraps"
 * around the lower-outer side of the envelope, like a real balloon's
 * load lines.
 *
 * Math (per corner, in the vertical plane through the corner and the
 * envelope's Y axis):
 *   rb = horizontal distance from the envelope axis to the basket corner
 *   hb = vertical position of the corner relative to the envelope center
 *   D  = sqrt(rb² + hb²) — straight-line distance corner→center
 *   The tangent point on a sphere of radius R satisfies
 *     rb·cos(φ) + hb·sin(φ) = R       (angle φ from horizontal)
 *   which solves to  φ = atan2(hb, rb) + acos(R/D).
 *   Then T_radial = R·cos(φ),  T_y = envelope.yCenter + R·sin(φ).
 *
 * The envelope's Y-stretch (`yScale`) is intentionally ignored — the
 * tangent is computed against the unstretched sphere of radius `radius`.
 * For modest yScale (~1.1–1.2) the visual error is negligible and the
 * math stays simple.
 */
export function flightRopeAnchors(params: BalloonFlightParams): {
  basket: [number, number, number][];
  envelope: [number, number, number][];
} {
  const b = params.basket;
  const e = params.envelope;
  const bxh = b.width / 2;
  const bzh = b.depth / 2;
  const byTop = b.yCenter + b.height / 2;
  const basketPts: [number, number, number][] = [
    [-bxh, byTop, -bzh],
    [bxh, byTop, -bzh],
    [bxh, byTop, bzh],
    [-bxh, byTop, bzh],
  ];
  const envPts: [number, number, number][] = basketPts.map(([bx, by, bz]) => {
    const rb = Math.hypot(bx, bz);
    const hb = by - e.yCenter;
    const D = Math.hypot(rb, hb);
    if (D <= e.radius) return [bx, by, bz]; // degenerate: corner inside sphere
    const phi = Math.atan2(hb, rb) + Math.acos(e.radius / D);
    const tRadial = e.radius * Math.cos(phi);
    const tY = e.yCenter + e.radius * Math.sin(phi);
    // Lift the tangent point back to 3D in the same horizontal direction
    // as the basket corner.
    const dirX = bx / rb;
    const dirZ = bz / rb;
    return [tRadial * dirX, tY, tRadial * dirZ];
  });
  return { basket: basketPts, envelope: envPts };
}

function buildBalloonBase(
  three: typeof THREE,
  scene: THREE.Scene | THREE.Group,
  params: BalloonBaseParams,
): void {
  // Ground shadow (broad, tile-wide) + tight AO disc. Drawn first so
  // the stakes and mooring render on top. Matches cannon pattern.
  if (params.groundShadow) {
    const gs = params.groundShadow;
    const disc = new three.Mesh(
      new three.CircleGeometry(gs.radius, 32),
      createMaterial(gs.material),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(0, gs.yPos, 0);
    scene.add(disc);
  }
  if (params.groundAO) {
    const ao = params.groundAO;
    const disc = new three.Mesh(
      new three.CircleGeometry(ao.radius, 32),
      createMaterial(ao.material),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(0, ao.yPos, 0);
    scene.add(disc);
  }

  // 4 corner stakes
  const stakeMat = createMaterial(params.stakes.material);
  for (const p of stakePositions(params)) {
    const stake = new three.Mesh(
      new three.CylinderGeometry(
        params.stakes.radius,
        params.stakes.radius,
        params.stakes.height,
        12,
      ),
      stakeMat,
    );
    stake.position.set(p.x, params.stakes.height / 2, p.z);
    scene.add(stake);
  }

  // Ropes between stakes — horizontal cylinders rotated so their axis
  // matches the segment direction.
  const ropeMat = createMaterial(params.stakeRopes.material);
  for (const seg of stakeRopeSegments(params)) {
    const rope = new three.Mesh(
      new three.CylinderGeometry(
        params.stakeRopes.radius,
        params.stakeRopes.radius,
        seg.length,
        8,
      ),
      ropeMat,
    );
    rope.position.set(seg.midpoint[0], seg.midpoint[1], seg.midpoint[2]);
    // Default cylinder axis is Y; rotate to match the segment axis.
    if (seg.axis === "x") rope.rotation.z = Math.PI / 2;
    else rope.rotation.x = Math.PI / 2;
    scene.add(rope);
  }

  // Mooring disc (flat metal cylinder)
  const mooring = new three.Mesh(
    new three.CylinderGeometry(
      params.mooring.outerRadius,
      params.mooring.outerRadius,
      params.mooring.height,
      24,
    ),
    createMaterial(params.mooring.material),
  );
  mooring.position.set(0, params.mooring.height / 2, 0);
  scene.add(mooring);

  // Mooring bolt (small dark box on top of the mooring)
  const bolt = new three.Mesh(
    new three.BoxGeometry(
      params.bolt.width,
      params.bolt.height,
      params.bolt.width,
    ),
    createMaterial(params.bolt.material),
  );
  bolt.position.set(0, params.mooring.height + params.bolt.height / 2, 0);
  scene.add(bolt);

  // Deflated balloon — sphere squashed in Y, sitting on the mooring top.
  const balloon = new three.Mesh(
    new three.SphereGeometry(params.deflatedBalloon.radius, 24, 16),
    createMaterial(params.deflatedBalloon.material),
  );
  balloon.scale.set(1, params.deflatedBalloon.ySquash, 1);
  // Bottom of squashed sphere = yCenter − r·ySquash. Place that at the
  // mooring top (y = mooring.height) so the balloon rests on it.
  const half = params.deflatedBalloon.radius * params.deflatedBalloon.ySquash;
  balloon.position.set(0, params.mooring.height + half, 0);
  scene.add(balloon);
}

/**
 * Four horizontal rope segments between adjacent stakes (top-of-stake
 * height). Each entry: { from, to, length, midpoint, axis: 'x'|'z' }.
 */
export function stakeRopeSegments(
  params: BalloonBaseParams,
): StakeRopeSegment[] {
  const positions = stakePositions(params);
  const yTop = params.stakes.height;
  const segs: StakeRopeSegment[] = [];
  for (let i = 0; i < 4; i++) {
    const a = positions[i]!;
    const b = positions[(i + 1) % 4]!;
    const length = a.x === b.x ? Math.abs(b.z - a.z) : Math.abs(b.x - a.x);
    const axis: "x" | "z" = a.x === b.x ? "z" : "x";
    segs.push({
      from: a,
      to: b,
      length,
      axis,
      midpoint: [(a.x + b.x) / 2, yTop, (a.z + b.z) / 2],
    });
  }
  return segs;
}

/**
 * Stake corner positions (NW, NE, SE, SW) at world Y=0 ground.
 */
export function stakePositions(params: BalloonBaseParams): StakePosition[] {
  const f = params.stakes.footprintHalf;
  return [
    { name: "NW", x: -f, z: -f },
    { name: "NE", x: f, z: -f },
    { name: "SE", x: f, z: f },
    { name: "SW", x: -f, z: f },
  ];
}
