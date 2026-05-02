/**
 * 3D ground-collapse reveal — `sinkhole` modifier. Per-tile dark brown
 * disc grows + fades as grass tiles permanently collapse into water.
 * Decorative on top of the terrain bitmap, which already paints these
 * tiles as water at apply time.
 *
 * Disc tint matches the `sinkhole` palette pulseColor for parity with
 * the legacy 2D reveal indicator.
 */

import type * as THREE from "three";
import { type EffectManager } from "./fire-burst.ts";
import { createModifierRevealBurstManager } from "./modifier-reveal-burst.ts";

export function createGroundCollapseManager(scene: THREE.Scene): EffectManager {
  return createModifierRevealBurstManager(scene, {
    name: "ground-collapse",
    paletteKey: "sinkhole",
    discColor: 0xa05a28,
    flashColor: 0xffffff,
    discDurationMs: 1100,
    flashDurationMs: 200,
    staggerSpanMs: 600,
    discPeakOpacity: 0.7,
    flashPeakOpacity: 0.5,
  });
}
