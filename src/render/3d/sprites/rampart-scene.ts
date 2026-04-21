/**
 * rampart-scene.ts — rampart "cannon" (wall reinforcer).
 *
 * TypeScript conversion of the original `rampart-scene.mjs`. Despite the
 * name it isn't a cannon — it's a static structure that makes nearby
 * walls indestructible within a radius around it. So no barrel, no
 * bore, no carriage supports. The geometry leans into a "forge /
 * reinforcer" silhouette: heavy metal core on the standard blue base,
 * four corner reinforcement pillars hugging the core's outer corners,
 * and a stepped anvil-style cap on top. A single green band wraps the
 * core to echo the cannon palette.
 *
 * 2×2 tile sprite (canvasPx 64), same scale as the regular cannons.
 * Unlike actual cannons there's no blue base disc — the rampart never
 * rotates, so the swivel base would be visual dead weight.
 *
 * THREE is injected to `buildRampart(THREE, scene, params)` so this
 * module stays free of three.js as a static dependency — matches the
 * convention of the other `*-scene.ts` files.
 */

import type * as THREE from "three";
import { BOUND_EPS, FRUSTUM_HALF, fmtBound } from "./sprite-bounds.ts";
import {
  cells,
  createMaterial,
  findVariant,
  type MaterialSpec,
} from "./sprite-kit.ts";
import { BAND_GREEN } from "./sprite-materials.ts";

export interface CoreParams {
  width: number;
  depth: number;
  height: number;
  yBase: number;
  material: MaterialSpec;
}

export interface CornersParams {
  radius: number;
  height: number;
  footprintHalf: number;
  material: MaterialSpec;
}

export interface TopParams {
  width: number;
  depth: number;
  height: number;
  material: MaterialSpec;
}

export interface BandParams {
  yPos: number;
  thickness: number;
  flare: number;
  material: MaterialSpec;
}

export interface ShieldParams {
  halfSide: number;
  yPos: number;
  material: MaterialSpec;
}

export interface EmblemParams {
  barLength: number;
  barThickness: number;
  barHeight: number;
  material: MaterialSpec;
}

export interface RampartParams {
  core: CoreParams;
  corners: CornersParams;
  top: TopParams;
  band?: BandParams;
  shield?: ShieldParams;
  emblem?: EmblemParams;
}

export interface RampartVariant {
  name: string;
  label: string;
  canvasPx: number;
  params: RampartParams;
}

export interface RampartVariantReport {
  name: string;
  coreTop: number;
  apex: number;
  warnings: string[];
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
const EMBLEM_GREEN: MaterialSpec = {
  kind: "standard",
  color: 0x71b04e,
  roughness: 0.55,
  metalness: 0.4,
};
// Translucent "shield" field projected on the ground. Green echoes the
// band/emblem so the palette stays compact.
const SHIELD_AURA: MaterialSpec = {
  kind: "basic",
  color: 0x71b04e,
  side: "double",
  opacity: 0.32,
};
// ---------- variant registry ------------------------------------------
export const VARIANTS: RampartVariant[] = [
  {
    name: "rampart_cannon",
    label: "rampart cannon",
    canvasPx: 64,
    params: {
      // 2×2 sprite = 32 cells across (±16 cells around center). All
      // dimensions in `cells(n)` so we can talk in integer pixel coords
      // ("widen the core by 1 cell"). Two intentional off-grid values
      // are kept as raw floats with comments below.
      core: {
        width: cells(13), // 13 cells = 1.625 world
        depth: cells(13),
        height: cells(3), // 3 cells = 0.375 world
        yBase: 0,
        material: CORE_METAL,
      },
      corners: {
        // Centered at the core's corners (footprintHalf = core/2);
        // radius extends them outward by 0.15 world (1.2 cells —
        // intentionally off-grid so the cylinder curve reads smoothly
        // rather than locking to the nearest pixel boundary).
        radius: 0.15,
        height: cells(4),
        footprintHalf: cells(6.5),
        material: PILLAR_DARK,
      },
      top: {
        // Stepped cap noticeably smaller than the core so the core's
        // shoulders show around it from above.
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
      // Shield field on the ground: 5×5-tile square (Chebyshev radius
      // 2 from rampart center, matching RAMPART_SHIELD_RADIUS in
      // game-constants.ts). 1 tile = 1 sprite unit (2×2 sprite covers
      // ±1), so half-side = 2.5 sprite units = 20 cells. Extends far
      // outside the native ±1 frustum — visible in assembly, clipped
      // in the standalone build-rampart-3d preview.
      shield: {
        halfSide: cells(20),
        // Off-grid by design: a tiny lift (~0.016 cells) above the
        // ground plane to prevent z-fighting with the terrain.
        yPos: 0.002,
        material: SHIELD_AURA,
      },
      // Simple cross emblem sitting flush on the top cap. Two thin
      // bars: length 6 cells (cap.width − 2 cells of margin), thickness
      // 1 cell, height 0.5 cell.
      emblem: {
        barLength: cells(6),
        barThickness: cells(1),
        barHeight: cells(0.5),
        material: EMBLEM_GREEN,
      },
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

export function variantReport(variant: RampartVariant): RampartVariantReport {
  const warnings: string[] = [];
  const params = variant.params;
  // Corner pillars must stay inside the ±1 canvas.
  const cornerOuter = params.corners.footprintHalf + params.corners.radius;
  if (cornerOuter > FRUSTUM_HALF + BOUND_EPS) {
    warnings.push(fmtBound("corner pillars", cornerOuter));
  }
  // Core should sit inside the corner ring.
  const coreHalf = Math.max(params.core.width, params.core.depth) / 2;
  if (coreHalf > params.corners.footprintHalf + BOUND_EPS) {
    warnings.push(
      `core (half=${coreHalf.toFixed(3)}) extends past the corner pillars (` +
        `footprintHalf=${params.corners.footprintHalf})`,
    );
  }
  // Top cap should be smaller than the core.
  const topHalf = Math.max(params.top.width, params.top.depth) / 2;
  if (topHalf > coreHalf + BOUND_EPS) {
    warnings.push(`top cap extends past the core`);
  }
  return {
    name: variant.name,
    coreTop: coreTopY(params),
    apex: coreTopY(params) + params.top.height,
    warnings,
  };
}

export function buildRampart(
  three: typeof THREE,
  scene: THREE.Scene | THREE.Group,
  params: RampartParams,
): void {
  const mat = (spec: MaterialSpec): THREE.Material => createMaterial(spec);

  // Shield aura — flat green square projected on the ground. Drawn
  // FIRST so later opaque meshes render over it with no z-fight.
  // renderOrder=-1 is a belt-and-braces hint for the transparent sort.
  if (params.shield) {
    const shieldSpec = params.shield;
    const side = shieldSpec.halfSide * 2;
    const auraGeom = new three.PlaneGeometry(side, side);
    const aura = new three.Mesh(auraGeom, mat(shieldSpec.material));
    aura.rotation.x = -Math.PI / 2;
    aura.position.set(0, shieldSpec.yPos, 0);
    aura.renderOrder = -1;
    scene.add(aura);
  }

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

export function coreTopY(params: RampartParams): number {
  return params.core.yBase + params.core.height;
}

export function cornerPositions(
  params: RampartParams,
): readonly [number, number][] {
  const f = params.corners.footprintHalf;
  return [
    [-f, -f],
    [+f, -f],
    [+f, +f],
    [-f, +f],
  ];
}
