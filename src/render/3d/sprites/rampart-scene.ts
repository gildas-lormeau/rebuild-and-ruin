/**
 * Rampart "cannon" — a static wall-reinforcer (no barrel/bore/supports).
 * 2×2 sprite (canvasPx 64) with a "forge / reinforcer" silhouette: heavy
 * metal core, four corner pillars, stepped anvil cap, single green band
 * echoing the cannon palette. No swivel disc since the rampart never
 * rotates.
 */

import * as THREE from "three";
import type { StakesParams } from "./balloon-scene.ts";
import {
  type BoxShapeParams,
  cells,
  createMaterial,
  findVariant,
  type MaterialSpec,
} from "./sprite-kit.ts";
import { BAND_GREEN } from "./sprite-materials.ts";

type CoreParams = BoxShapeParams;

interface TopParams {
  width: number;
  depth: number;
  height: number;
  material: MaterialSpec;
}

interface BandParams {
  yPos: number;
  thickness: number;
  flare: number;
  material: MaterialSpec;
}

interface EmblemParams {
  barLength: number;
  barThickness: number;
  barHeight: number;
  material: MaterialSpec;
}

interface RampartParams {
  core: CoreParams;
  corners: StakesParams;
  top: TopParams;
  band?: BandParams;
  emblem?: EmblemParams;
}

interface RampartVariant {
  name: string;
  label: string;
  canvasPx: number;
  params: RampartParams;
}

// ---------- scene-local materials ----------
// BAND_GREEN (green accent ring around the metal core, also reused by
// cannon-rubble piles) is imported from sprite-materials.ts.
const CORE_METAL: MaterialSpec = {
  kind: "standard",
  color: 0x91918d,
  roughness: 0.45,
  metalness: 0.85,
};
const PILLAR_DARK: MaterialSpec = {
  kind: "standard",
  color: 0x52524e,
  roughness: 0.5,
  metalness: 0.8,
};
const TOP_LIGHT: MaterialSpec = {
  kind: "standard",
  color: 0xefefeb,
  roughness: 0.4,
  metalness: 0.85,
};
/** Cross emblem palette — drives the visible shield-hp tier on the top
 *  cap. The renderer's variant selector keys off `cannon.shieldHp` and
 *  picks the matching variant; this is the only authored difference. */
const EMBLEM_GREEN: MaterialSpec = {
  kind: "standard",
  color: 0x71b04e,
  roughness: 0.55,
  metalness: 0.4,
};
const EMBLEM_YELLOW: MaterialSpec = {
  kind: "standard",
  color: 0xd8b830,
  roughness: 0.55,
  metalness: 0.4,
};
const EMBLEM_ORANGE: MaterialSpec = {
  kind: "standard",
  color: 0xd86028,
  roughness: 0.55,
  metalness: 0.4,
};
const EMBLEM_GREY: MaterialSpec = {
  kind: "standard",
  color: 0x3a3a38,
  roughness: 0.55,
  metalness: 0.4,
};
/** Shared body params reused across every shield-tier variant — only the
 *  cross emblem material changes. Authoring once keeps the 4 variants in
 *  lockstep when the body needs a tweak. */
const BODY_PARAMS: Omit<RampartParams, "emblem"> = {
  core: {
    width: cells(13),
    depth: cells(13),
    height: cells(3),
    yBase: 0,
    material: CORE_METAL,
  },
  corners: {
    radius: 0.15,
    height: cells(4),
    footprintHalf: cells(6.5),
    material: PILLAR_DARK,
  },
  top: {
    width: cells(8),
    depth: cells(8),
    height: cells(1),
    material: TOP_LIGHT,
  },
  band: {
    yPos: cells(1.5),
    thickness: cells(0.5),
    flare: cells(0.5),
    material: BAND_GREEN,
  },
};
const EMBLEM_BASE = {
  barLength: cells(6),
  barThickness: cells(1),
  barHeight: cells(0.5),
};
// ---------- variant registry ------------------------------------------
// 2×2 sprite = 32 cells across (±16 cells around center). All shield-tier
// variants share body geometry — only the cross emblem color differs.
// `rampart_cannon` is the "full" alias retained for backward compatibility
// (callers that don't know the shield state can still resolve a variant).
export const VARIANTS: RampartVariant[] = [
  {
    name: "rampart_cannon",
    label: "rampart cannon",
    canvasPx: 64,
    params: {
      ...BODY_PARAMS,
      emblem: { ...EMBLEM_BASE, material: EMBLEM_GREEN },
    },
  },
  {
    name: "rampart_cannon_mid",
    label: "rampart cannon (mid shield)",
    canvasPx: 64,
    params: {
      ...BODY_PARAMS,
      emblem: { ...EMBLEM_BASE, material: EMBLEM_YELLOW },
    },
  },
  {
    name: "rampart_cannon_low",
    label: "rampart cannon (low shield)",
    canvasPx: 64,
    params: {
      ...BODY_PARAMS,
      emblem: { ...EMBLEM_BASE, material: EMBLEM_ORANGE },
    },
  },
  {
    name: "rampart_cannon_depleted",
    label: "rampart cannon (shield depleted)",
    canvasPx: 64,
    params: {
      ...BODY_PARAMS,
      emblem: { ...EMBLEM_BASE, material: EMBLEM_GREY },
    },
  },
];
// ---------- palette ---------------------------------------------------
// No blue — the base disc is gone. Just metal greys + the green
// accent band.
export const PALETTE: readonly [number, number, number][] = [
  // iron / metal greys (core, pillars, top)
  [0x2a, 0x2a, 0x28],
  [0x4a, 0x4a, 0x48],
  [0x7a, 0x7a, 0x78],
  // green band accent
  [0x3a, 0x5a, 0x28],
  // dark accent
  [0x0a, 0x0a, 0x0a],
];

/** Look up a rampart variant by name. Matches `getCannonVariant` / other
 *  scene file helpers — lets the entity manager fetch the params
 *  dictionary when variant selection is data-driven. */
export function getRampartVariant(name: string): RampartVariant | undefined {
  return findVariant(VARIANTS, name);
}

export function buildRampart(
  three: typeof THREE,
  scene: THREE.Scene | THREE.Group,
  params: RampartParams,
): void {
  const mat = (spec: MaterialSpec): THREE.Material => createMaterial(spec);

  // Core block.
  const core = new three.Mesh(
    new three.BoxGeometry(
      params.core.width,
      params.core.height,
      params.core.depth,
    ),
    mat(params.core.material),
  );
  core.position.set(0, params.core.yBase + params.core.height / 2, 0);
  scene.add(core);

  // Four corner reinforcement pillars (cylinders, axis = Y).
  const pillarMat = mat(params.corners.material);
  for (const [cornerX, cornerZ] of cornerPositions(params)) {
    const pillar = new three.Mesh(
      new three.CylinderGeometry(
        params.corners.radius,
        params.corners.radius,
        params.corners.height,
        16,
      ),
      pillarMat,
    );
    pillar.position.set(cornerX, params.corners.height / 2, cornerZ);
    scene.add(pillar);
  }

  // Optional accent band wrapping the core (thin oversized box).
  if (params.band) {
    const bandSpec = params.band;
    const bandMesh = new three.Mesh(
      new three.BoxGeometry(
        params.core.width + 2 * bandSpec.flare,
        bandSpec.thickness,
        params.core.depth + 2 * bandSpec.flare,
      ),
      mat(bandSpec.material),
    );
    bandMesh.position.set(0, bandSpec.yPos, 0);
    // Same hide-during-battle treatment as the regular cannons' ground
    // discs (see cannon-scene.ts groundShadow/groundAO) — the green
    // accent ring reads as decorative in build/select, distracting in
    // combat. Authoring-side tag; cannons.ts drives the visibility.
    bandMesh.userData.tags = ["battle-hidden"];
    scene.add(bandMesh);
  }

  // Stepped anvil cap on top of the core.
  const top = new three.Mesh(
    new three.BoxGeometry(
      params.top.width,
      params.top.height,
      params.top.depth,
    ),
    mat(params.top.material),
  );
  top.position.set(0, coreTopY(params) + params.top.height / 2, 0);
  scene.add(top);

  // Cross emblem sitting flush on the top cap — two thin bars making
  // a '+' shape. Reads clearly from the top-down camera.
  if (params.emblem) {
    const emblemSpec = params.emblem;
    const apexY = coreTopY(params) + params.top.height;
    const emblemMat = mat(emblemSpec.material);
    const barX = new three.Mesh(
      new three.BoxGeometry(
        emblemSpec.barLength,
        emblemSpec.barHeight,
        emblemSpec.barThickness,
      ),
      emblemMat,
    );
    barX.position.set(0, apexY + emblemSpec.barHeight / 2 + 0.0005, 0);
    scene.add(barX);
    const barZ = new three.Mesh(
      new three.BoxGeometry(
        emblemSpec.barThickness,
        emblemSpec.barHeight,
        emblemSpec.barLength,
      ),
      emblemMat,
    );
    barZ.position.set(0, apexY + emblemSpec.barHeight / 2 + 0.0005, 0);
    scene.add(barZ);
  }
}

function coreTopY(params: RampartParams): number {
  return params.core.yBase + params.core.height;
}

function cornerPositions(params: RampartParams): readonly [number, number][] {
  const f = params.corners.footprintHalf;
  return [
    [-f, -f],
    [+f, -f],
    [+f, +f],
    [-f, +f],
  ];
}
