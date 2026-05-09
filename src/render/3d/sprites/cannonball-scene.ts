/**
 * In-flight cannonball sprites (1×1 tile, transparent bg, canvasPx=32).
 * Three visually distinct variants — `cannonball_iron` (plain),
 * `cannonball_fire` (super-gun, glowing + creates pit), `cannonball_mortar`
 * (steel-banded, larger, splash + pit) — so players can tell shots apart
 * in flight. The renderer scales each sprite by altitude per frame.
 */

import type * as THREE from "three";
import {
  cells,
  createMaterial,
  findVariant,
  type MaterialSpec,
} from "./sprite-kit.ts";

interface BallParams {
  radius: number;
  material: MaterialSpec;
  widthSegments?: number;
  heightSegments?: number;
}

interface BandParams {
  radius: number;
  tube: number;
  material: MaterialSpec;
}

interface FlamePuffParams {
  radius: number;
  pos: readonly [number, number, number];
  material: MaterialSpec;
}

interface CannonballParams {
  ball: BallParams;
  /** Optional equatorial band (mortar only). */
  band?: BandParams;
  /** Optional small glowing spheres trailing the ball (fire only). */
  flamePuffs?: readonly FlamePuffParams[];
}

interface CannonballVariant {
  name: string;
  label: string;
  canvasPx: number;
  params: CannonballParams;
}

// Iron ball — standard shot. Mid-metalness so it reads as cast iron.
const IRON_BODY: MaterialSpec = {
  kind: "standard",
  color: 0x3a3a3a,
  roughness: 0.45,
  metalness: 0.75,
};
// Darker iron for mortar — bigger, heavier-looking.
const IRON_DARK: MaterialSpec = {
  kind: "standard",
  color: 0x201a18,
  roughness: 0.5,
  metalness: 0.75,
};
// Thin metal band wrapping the mortar ball — a visual "this one is
// different" cue rather than historical accuracy.
const BAND_STEEL: MaterialSpec = {
  kind: "standard",
  color: 0x686868,
  roughness: 0.35,
  metalness: 0.8,
};
// Fire ball — red body with strong emissive so it reads as hot even
// under low scene light. Palette-safe (stays within the red/orange
// entries already in the game's color quantizer).
const FIRE_BODY: MaterialSpec = {
  kind: "standard",
  color: 0xc04018,
  emissive: 0x802010,
  roughness: 0.5,
  metalness: 0.1,
};
// Tiny flame puffs trailing the fire ball — bright yellow/orange.
const FLAME_PUFF: MaterialSpec = {
  kind: "standard",
  color: 0xffa040,
  emissive: 0xe05018,
  roughness: 0.55,
  metalness: 0.0,
};
export const VARIANTS: CannonballVariant[] = [
  {
    name: "cannonball_iron",
    label: "iron (tier 1–3)",
    canvasPx: 32,
    params: {
      ball: {
        radius: 0.4375,
        material: IRON_BODY,
        widthSegments: 24,
        heightSegments: 18,
      },
    },
  },
  {
    name: "cannonball_fire",
    label: "fire (super gun)",
    canvasPx: 32,
    params: {
      ball: {
        radius: 0.4375,
        material: FIRE_BODY,
        widthSegments: 24,
        heightSegments: 18,
      },
      flamePuffs: [
        // Three small puffs offset around the ball — picks up the
        // "something is burning off it" vibe at 1×1 resolution.
        { radius: 0.125, pos: [cells(3.5), cells(3), 0], material: FLAME_PUFF },
        {
          radius: 0.1,
          pos: [-cells(2.5), cells(3.5), cells(2)],
          material: FLAME_PUFF,
        },
        {
          radius: 0.0875,
          pos: [cells(1), cells(4), -cells(2.5)],
          material: FLAME_PUFF,
        },
      ],
    },
  },
  {
    name: "cannonball_mortar",
    label: "mortar",
    canvasPx: 32,
    params: {
      // Larger + darker than a standard shot. The equatorial band
      // makes it read as a distinct projectile class at 1×1.
      ball: {
        radius: 0.5625,
        material: IRON_DARK,
        widthSegments: 24,
        heightSegments: 18,
      },
      band: { radius: 0.5625, tube: 0.0625, material: BAND_STEEL },
    },
  },
];
export const PALETTE: [number, number, number][] = [
  // iron greys
  [0x20, 0x1a, 0x18],
  [0x3a, 0x3a, 0x3a],
  [0x68, 0x68, 0x68],
  // fire reds / oranges / highlight
  [0x80, 0x20, 0x10],
  [0xc0, 0x40, 0x18],
  [0xe0, 0x50, 0x18],
  [0xff, 0xa0, 0x40],
  // dark accent
  [0x0a, 0x0a, 0x0a],
];

/** Look up a cannonball variant by name. */
export function getCannonballVariant(
  name: string,
): CannonballVariant | undefined {
  return findVariant(VARIANTS, name);
}

export function buildCannonball(
  three: typeof THREE,
  scene: THREE.Scene | THREE.Group,
  params: CannonballParams,
): void {
  // Ball — main sphere centered at origin. Renderer positions the
  // sprite in-world; we just provide the reference shape.
  const ball = new three.Mesh(
    new three.SphereGeometry(
      params.ball.radius,
      params.ball.widthSegments ?? 24,
      params.ball.heightSegments ?? 18,
    ),
    createMaterial(params.ball.material),
  );
  scene.add(ball);

  // Optional equatorial band (mortar). Torus flat around the ball.
  if (params.band) {
    const bandGeom = new three.TorusGeometry(
      params.band.radius,
      params.band.tube,
      8,
      32,
    );
    bandGeom.rotateX(Math.PI / 2);
    const band = new three.Mesh(bandGeom, createMaterial(params.band.material));
    scene.add(band);
  }

  // Optional flame puffs (fire). Small spheres offset from the ball.
  if (params.flamePuffs) {
    for (const puff of params.flamePuffs) {
      const mesh = new three.Mesh(
        new three.SphereGeometry(puff.radius, 10, 8),
        createMaterial(puff.material),
      );
      mesh.position.set(puff.pos[0], puff.pos[1], puff.pos[2]);
      scene.add(mesh);
    }
  }
}
