/**
 * 3D water-surge reveal — `high_tide` modifier. Per-tile blue disc grows
 * + fades as river-bank grass tiles flood with water. Decorative on top
 * of the terrain bitmap, which already paints these tiles as water at
 * apply time.
 *
 * Disc tint matches the `high_tide` palette pulseColor for parity with
 * the legacy 2D reveal indicator.
 */

import type * as THREE from "three";
import { type EffectManager } from "./fire-burst.ts";
import { createModifierRevealBurstManager } from "./modifier-reveal-burst.ts";

export type WaterSurgeManager = EffectManager;

export function createWaterSurgeManager(scene: THREE.Scene): WaterSurgeManager {
  return createModifierRevealBurstManager(scene, {
    name: "water-surge",
    paletteKey: "high_tide",
    discColor: 0x3c8cf0,
    flashColor: 0xffffff,
    discDurationMs: 1100,
    flashDurationMs: 200,
    staggerSpanMs: 600,
    discPeakOpacity: 0.7,
    flashPeakOpacity: 0.5,
  });
}
