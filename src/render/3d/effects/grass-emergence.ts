/**
 * 3D grass-emergence reveal — `low_water` modifier. Per-tile green disc
 * grows + fades as river-edge water tiles convert to grass. Decorative
 * on top of the terrain bitmap, which already paints these tiles as
 * grass at apply time.
 *
 * Disc tint matches the `low_water` palette pulseColor for parity with
 * the legacy 2D reveal indicator.
 */

import type * as THREE from "three";
import { type EffectManager } from "./fire-burst.ts";
import { createModifierRevealBurstManager } from "./modifier-reveal-burst.ts";

export type GrassEmergenceManager = EffectManager;

export function createGrassEmergenceManager(
  scene: THREE.Scene,
): GrassEmergenceManager {
  return createModifierRevealBurstManager(scene, {
    name: "grass-emergence",
    paletteKey: "low_water",
    discColor: 0x78c890,
    flashColor: 0xffffff,
    discDurationMs: 1100,
    flashDurationMs: 200,
    staggerSpanMs: 600,
    discPeakOpacity: 0.7,
    flashPeakOpacity: 0.5,
  });
}
