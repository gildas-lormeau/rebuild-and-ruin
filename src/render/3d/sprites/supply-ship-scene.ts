/**
 * Supply-ship scene — neutral wooden cargo boat for the `supply_ship`
 * modifier. Single variant (`supply_ship_basic`); all motion is owned
 * by the effect manager via root-group transforms. Footprint: 1 tile
 * wide × 2 tiles long, long axis = local +Z. Geometry sits in
 * X ∈ [−0.5, +0.5], Z ∈ [−1, +1]; mast extends Y above 1 (matching
 * balloon-scene's tall-sprite ±aspect pattern). THREE injected.
 */

import type * as THREE from "three";
import { cells, createMaterial, type MaterialSpec } from "./sprite-kit.ts";
import { buildTexturedMaterial, type TexturedSpec } from "./sprite-textures.ts";

interface HullParams {
  /** Width along local X (short axis). Cell-aligned. */
  width: number;
  /** Length along local Z (long axis). Cell-aligned. */
  length: number;
  /** Total hull body height (waterline to deck top). Cell-aligned. */
  height: number;
  /** Y-center of the hull box; the body straddles the waterline so
   *  ~40% sits below Y=0 (draft) and ~60% above (freeboard). */
  yCenter: number;
  /** Bow/stern taper inset along local X at the endcaps, expressed as
   *  a fraction of `width`. 0.25 = each endcap narrows by 25% per side.
   *  Free-valued (curve-defining; the taper is a chamfered prism). */
  taperFrac: number;
  /** Length of the bow + stern chamfers along Z, cell-aligned. */
  taperLength: number;
  /** Plank-deck textured material (top face). */
  deckMaterial: TexturedSpec;
  /** Painted-wood hull-side material (untextured weathered planks). */
  sideMaterial: MaterialSpec;
  /** Dark trim along the gunwale (top edge of the hull sides). */
  trimMaterial: MaterialSpec;
}

interface MastParams {
  /** Mast radius (free-valued cylinder). */
  radius: number;
  /** Mast height above the deck top, cell-aligned. */
  height: number;
  material: MaterialSpec;
}

interface SailParams {
  /** Sail width along local X, cell-aligned. */
  width: number;
  /** Sail height along local Y, cell-aligned. */
  height: number;
  /** Thickness — paper-thin slab; rendered double-sided. */
  thickness: number;
  /** Y of the sail's center, relative to the mast base. Cell-aligned. */
  yCenter: number;
  /** Local Z offset of the sail relative to the mast (0 = wrapped around
   *  mast axis). Cell-aligned. */
  zOffset: number;
  material: MaterialSpec;
  /** Yard / boom — short cross-piece at the top of the sail. */
  yardMaterial: MaterialSpec;
}

interface CargoCrateParams {
  /** Box dims, cell-aligned. */
  width: number;
  depth: number;
  height: number;
  /** Crate sits on the deck, offset toward the bow on local +Z. */
  zOffset: number;
  /** Y of the crate's bottom face (deck top). */
  yBottom: number;
  material: MaterialSpec;
  /** Cross-strap rim (dark wood band around the crate). */
  strapMaterial: MaterialSpec;
}

interface SupplyShipParams {
  hull: HullParams;
  mast: MastParams;
  sail: SailParams;
  crate: CargoCrateParams;
}

interface SupplyShipVariant {
  name: "supply_ship_basic";
  label: string;
  canvasPx: number;
  canvasPxH: number;
  params: SupplyShipParams;
}

const HULL_PLANK_DECK: TexturedSpec = {
  kind: "standard",
  color: 0xc8a577,
  roughness: 0.88,
  metalness: 0.0,
  texture: "cannon_wood",
};
const HULL_SIDE_WOOD: MaterialSpec = {
  kind: "standard",
  color: 0x8b6433,
  roughness: 0.95,
  metalness: 0.05,
};
const HULL_TRIM_DARK: MaterialSpec = {
  kind: "standard",
  color: 0x3a2410,
  roughness: 0.9,
  metalness: 0.05,
};
const MAST_WOOD: MaterialSpec = {
  kind: "standard",
  color: 0x9c7a3e,
  roughness: 0.92,
  metalness: 0.0,
};
const SAIL_OFFWHITE: MaterialSpec = {
  kind: "standard",
  color: 0xe5dcc0,
  roughness: 0.85,
  metalness: 0.0,
  side: "double",
};
const SAIL_YARD: MaterialSpec = {
  kind: "standard",
  color: 0x4a3220,
  roughness: 0.95,
  metalness: 0.0,
};
const CRATE_WOOD: MaterialSpec = {
  kind: "standard",
  color: 0xb98a4a,
  roughness: 0.95,
  metalness: 0.0,
};
const CRATE_STRAP: MaterialSpec = {
  kind: "standard",
  color: 0x5a3c1a,
  roughness: 0.9,
  metalness: 0.15,
};
export const VARIANTS: SupplyShipVariant[] = [
  {
    name: "supply_ship_basic",
    label: "supply ship",
    // 1 tile wide × 2 tiles long → canvas 32 × 64 (game 2×). Height
    // extends above 1 (mast), per CONVENTIONS' tall-sprite rule.
    canvasPx: 32,
    canvasPxH: 64,
    params: {
      // Hull: 6 cells wide × 14 cells long (X ∈ [−0.375, +0.375];
      // Z ∈ [−0.875, +0.875]). Sits a hair inside the ±1 frustum on Z
      // so bow/stern chamfers don't extend past the sprite frame.
      // Height 3 cells; yCenter at cells(0.6) lands the bottom at
      // cells(−0.9) ≈ −0.1125 world units (draft, below waterline) and
      // the deck top at cells(2.1) ≈ +0.2625 (freeboard above).
      hull: {
        width: cells(6),
        length: cells(14),
        height: cells(3),
        yCenter: cells(0.6),
        // Taper: 25% inset per side at the chamfered endcaps. Free-valued.
        taperFrac: 0.25,
        // Endcap length 2 cells of the 14-cell total.
        taperLength: cells(2),
        deckMaterial: HULL_PLANK_DECK,
        sideMaterial: HULL_SIDE_WOOD,
        trimMaterial: HULL_TRIM_DARK,
      },
      // Mast: radius 0.04 (thin cylinder, free-valued); height 7 cells
      // above the deck top (deck top at cells(2.1), so mast peak at
      // cells(9.1) ≈ 1.1375 — within ±aspect for a 1×2 ship). Centered
      // amidships (local origin).
      mast: {
        radius: 0.04,
        height: cells(7),
        material: MAST_WOOD,
      },
      // Sail: 5 cells wide × 4 cells tall, thin slab on Y. Hangs below
      // the masthead, with cells(0.5) Z-offset so the leading edge isn't
      // wrapped around the mast cylinder.
      sail: {
        width: cells(5),
        height: cells(4),
        thickness: 0.015,
        yCenter: cells(4.5),
        zOffset: cells(0.5),
        material: SAIL_OFFWHITE,
        yardMaterial: SAIL_YARD,
      },
      // Cargo crate: 3×3×3 cells, on the deck, offset toward the stern
      // (local −Z) so the mast/sail amidships stays visible from the
      // top-down view. The crate is the visible "bonus" — hidden type,
      // so identical across all spawned ships.
      crate: {
        width: cells(3),
        depth: cells(3),
        height: cells(3),
        zOffset: cells(-4),
        yBottom: cells(2.1),
        material: CRATE_WOOD,
        strapMaterial: CRATE_STRAP,
      },
    },
  },
];
// Weathered wood + off-white sail + dark trim. Brass-ish accents kept
// out of the explicit palette; the existing dark-metal tones already
// cover the trim/strap end of the range.
export const PALETTE: [number, number, number][] = [
  // hull / mast / crate (warm browns + oak)
  [0x3a, 0x24, 0x10],
  [0x5a, 0x3c, 0x1a],
  [0x8b, 0x64, 0x33],
  [0x9c, 0x7a, 0x3e],
  [0xb9, 0x8a, 0x4a],
  [0xc8, 0xa5, 0x77],
  // sail (off-white)
  [0xc8, 0xc0, 0xa5],
  [0xe5, 0xdc, 0xc0],
  // trim accents
  [0x4a, 0x32, 0x20],
];

/** Return the single supply-ship variant. Parameterless because only
 *  one variant exists today — promote to `(name: string)` + `findVariant`
 *  if additional variants are introduced. */
export function getSupplyShipVariant(): SupplyShipVariant {
  return VARIANTS[0]!;
}

export function buildSupplyShip(
  three: typeof THREE,
  scene: THREE.Scene | THREE.Group,
  params: SupplyShipParams,
): void {
  buildHull(three, scene, params.hull);
  buildMast(three, scene, params.mast, params.hull);
  buildSail(three, scene, params.sail, params.hull, params.mast);
  buildCargoCrate(three, scene, params.crate);
}

function buildHull(
  three: typeof THREE,
  scene: THREE.Scene | THREE.Group,
  params: HullParams,
): void {
  // Mid hull: rectangular prism spanning Z ∈ [−mid/2, +mid/2] where
  // mid = length − 2·taperLength. Width = full hull width.
  const midLength = params.length - 2 * params.taperLength;
  const sideMat = createMaterial(params.sideMaterial);
  const trimMat = createMaterial(params.trimMaterial);

  const midSides = new three.Mesh(
    new three.BoxGeometry(params.width, params.height, midLength),
    sideMat,
  );
  midSides.position.set(0, params.yCenter, 0);
  scene.add(midSides);

  // Bow + stern chamfered endcaps — wedge prisms tapering to a narrow
  // edge at the tip. ExtrudeGeometry could do this, but a custom
  // BufferGeometry from 8 vertices keeps the geometry budget low and
  // matches the cell-aligned silhouette exactly.
  const tipWidth = params.width * (1 - params.taperFrac * 2);
  for (const sign of [1, -1] as const) {
    const cap = makeTaperedCap(three, {
      baseWidth: params.width,
      tipWidth,
      length: params.taperLength,
      height: params.height,
      material: sideMat,
    });
    cap.position.set(
      0,
      params.yCenter,
      sign * (midLength / 2 + params.taperLength / 2),
    );
    // The cap is authored with its taper pointing toward +Z; flip for
    // the stern. Local rotation only — no mirror needed since the
    // geometry is symmetric on X.
    if (sign < 0) cap.rotation.y = Math.PI;
    scene.add(cap);
  }

  // Deck plane (top face) — separate textured slab sitting at the deck
  // top so the plank texture reads cleanly from the overhead view.
  // Slightly inset on X/Z so the gunwale trim (next) stands proud of it.
  const deckMat = buildTexturedMaterial(three, params.deckMaterial);
  const deckThickness = 0.02;
  const deckTop = params.yCenter + params.height / 2;
  const deck = new three.Mesh(
    new three.BoxGeometry(
      params.width - cells(0.5),
      deckThickness,
      midLength + params.taperLength - cells(0.5),
    ),
    deckMat,
  );
  deck.position.set(0, deckTop - deckThickness / 2, 0);
  scene.add(deck);

  // Gunwale trim — thin dark band along the top edge of the hull sides,
  // running the full hull silhouette (mid + chamfered endcaps). Modeled
  // as a slab matching the deck footprint at the deck top, slightly
  // oversized so it reads as a raised edge.
  const trimH = 0.04;
  const trim = new three.Mesh(
    new three.BoxGeometry(
      params.width + 0.02,
      trimH,
      midLength + 2 * params.taperLength * 0.6 + 0.02,
    ),
    trimMat,
  );
  trim.position.set(0, deckTop + trimH / 2, 0);
  scene.add(trim);
}

function buildMast(
  three: typeof THREE,
  scene: THREE.Scene | THREE.Group,
  params: MastParams,
  hull: HullParams,
): void {
  const deckTop = hull.yCenter + hull.height / 2;
  const mast = new three.Mesh(
    new three.CylinderGeometry(params.radius, params.radius, params.height, 8),
    createMaterial(params.material),
  );
  mast.position.set(0, deckTop + params.height / 2, 0);
  scene.add(mast);
}

function buildSail(
  three: typeof THREE,
  scene: THREE.Scene | THREE.Group,
  params: SailParams,
  hull: HullParams,
  mast: MastParams,
): void {
  const deckTop = hull.yCenter + hull.height / 2;

  // Yard: short horizontal cross-piece at the top of the sail.
  const yardH = 0.04;
  const yardLength = params.width + cells(1);
  const yard = new three.Mesh(
    new three.BoxGeometry(yardLength, yardH, yardH),
    createMaterial(params.yardMaterial),
  );
  yard.position.set(
    0,
    deckTop + params.yCenter + params.height / 2 + yardH / 2,
    params.zOffset,
  );
  scene.add(yard);

  // Sail: thin slab hanging from the yard. Double-sided so it reads from
  // either face under camera roll.
  const sail = new three.Mesh(
    new three.BoxGeometry(params.width, params.height, params.thickness),
    createMaterial(params.material),
  );
  sail.position.set(0, deckTop + params.yCenter, params.zOffset);
  scene.add(sail);

  // Suppress unused-param warning — `mast` is in the signature so future
  // halyard/standing-rigging additions can anchor against the mast
  // height without a signature change. Currently the sail is positioned
  // purely from hull + sail params.
  void mast;
}

function buildCargoCrate(
  three: typeof THREE,
  scene: THREE.Scene | THREE.Group,
  params: CargoCrateParams,
): void {
  const yCenter = params.yBottom + params.height / 2;

  // Crate body
  const body = new three.Mesh(
    new three.BoxGeometry(params.width, params.height, params.depth),
    createMaterial(params.material),
  );
  body.position.set(0, yCenter, params.zOffset);
  scene.add(body);

  // Cross-strap rims — two dark bands wrapping around the crate (one on
  // each horizontal axis). Slightly oversized so they read as raised
  // straps rather than painted lines.
  const strapMat = createMaterial(params.strapMaterial);
  const strapH = 0.025;
  const strapInset = 0.015;

  // X-axis strap (wraps around X — visible on +Z / −Z / +Y / −Y faces).
  const strapX = new three.Mesh(
    new three.BoxGeometry(
      params.width + strapInset,
      strapH,
      params.depth + strapInset,
    ),
    strapMat,
  );
  strapX.position.set(0, yCenter, params.zOffset);
  scene.add(strapX);

  // Z-axis strap (wraps around Z — visible on +X / −X / +Y / −Y faces).
  const strapZ = new three.Mesh(
    new three.BoxGeometry(
      params.width + strapInset,
      params.height + strapInset,
      strapH,
    ),
    strapMat,
  );
  strapZ.position.set(0, yCenter, params.zOffset);
  scene.add(strapZ);
}

/** Build a wedge-prism endcap whose +Z face is `tipWidth` wide and
 *  whose −Z face is `baseWidth` wide. 8 vertices, 12 triangles
 *  (6 quad faces: +X taper, −X taper, +Y top, −Y bottom, +Z tip, −Z
 *  base). Vertex layout:
 *
 *      6───────7   (top, +Y)
 *     /│      /│
 *    4─┼─────5 │   (top, +Y; tip narrower than base)
 *    │ 2─────│─3   (bottom, −Y)
 *    │/      │/
 *    0───────1     (bottom, −Y)
 *
 *  Coordinates: 0–3 are the base (z = −length/2, full baseWidth),
 *  4–7 are the tip (z = +length/2, narrower tipWidth).
 */
function makeTaperedCap(
  three: typeof THREE,
  params: {
    baseWidth: number;
    tipWidth: number;
    length: number;
    height: number;
    material: THREE.Material;
  },
): THREE.Mesh {
  const halfBase = params.baseWidth / 2;
  const halfTip = params.tipWidth / 2;
  const halfH = params.height / 2;
  const halfL = params.length / 2;

  const vertices = new Float32Array([
    // Base quad (z = −halfL)
    -halfBase,
    -halfH,
    -halfL, // 0: base bottom-left
    halfBase,
    -halfH,
    -halfL, // 1: base bottom-right
    -halfBase,
    halfH,
    -halfL, // 2: base top-left
    halfBase,
    halfH,
    -halfL, // 3: base top-right
    // Tip quad (z = +halfL)
    -halfTip,
    -halfH,
    halfL, // 4: tip bottom-left
    halfTip,
    -halfH,
    halfL, // 5: tip bottom-right
    -halfTip,
    halfH,
    halfL, // 6: tip top-left
    halfTip,
    halfH,
    halfL, // 7: tip top-right
  ]);

  // Triangle indices: each face is 2 tris with CCW winding when viewed
  // from outside the prism.
  // prettier-ignore
  const indices = new Uint16Array([
    // Bottom (−Y, viewed from below: 0, 1, 5, 4 CCW from underneath)
    0, 1, 5, 0, 5, 4,
    // Top (+Y, viewed from above: 2, 3, 7, 6 CCW from above)
    2, 6, 7, 2, 7, 3,
    // Base (−Z, viewed from −Z direction: 0, 2, 3, 1)
    0, 2, 3, 0, 3, 1,
    // Tip (+Z, viewed from +Z direction: 4, 5, 7, 6)
    4, 5, 7, 4, 7, 6,
    // −X taper (viewed from −X: 0, 4, 6, 2)
    0, 4, 6, 0, 6, 2,
    // +X taper (viewed from +X: 1, 3, 7, 5)
    1, 3, 7, 1, 7, 5,
  ]);

  const geom = new three.BufferGeometry();
  geom.setAttribute("position", new three.BufferAttribute(vertices, 3));
  geom.setIndex(new three.BufferAttribute(indices, 1));
  geom.computeVertexNormals();

  return new three.Mesh(geom, params.material);
}
