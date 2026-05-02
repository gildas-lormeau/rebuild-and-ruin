/**
 * 3D grunt-frost reveal — `frostbite` modifier. Per-tile light-blue disc
 * grows + fades on each grunt tile that just froze into an ice cube.
 *
 * Disc tint matches the `frostbite` palette pulseColor for parity with
 * the legacy 2D reveal indicator. The actual frostbite tint on the
 * grunt entities is owned by `entities/grunts.ts`; this is the
 * announcement burst, not the per-grunt material change.
 */

import type * as THREE from "three";
import { type EffectManager } from "./fire-burst.ts";
import { createModifierRevealBurstManager } from "./modifier-reveal-burst.ts";

export type GruntFrostManager = EffectManager;

export function createGruntFrostManager(scene: THREE.Scene): GruntFrostManager {
  return createModifierRevealBurstManager(scene, {
    name: "grunt-frost",
    paletteKey: "frostbite",
    discColor: 0x88d0f0,
    flashColor: 0xffffff,
    discDurationMs: 1100,
    flashDurationMs: 200,
    staggerSpanMs: 600,
    discPeakOpacity: 0.7,
    flashPeakOpacity: 0.5,
  });
}
