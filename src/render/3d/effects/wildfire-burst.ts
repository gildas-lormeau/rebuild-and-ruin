/**
 * 3D wildfire-burst reveal — `wildfire` modifier. Per-tile orange disc
 * grows + fades on each burn-scar tile. Decorative on top of the
 * burning-pit meshes already drawn at apply time.
 *
 * Disc tint matches the `wildfire` palette pulseColor for parity with
 * the legacy 2D reveal indicator. Renderer-deeper effects (pulsing the
 * pit's own flame intensity) are deferred — see the descriptor-pattern
 * refactor follow-up.
 */

import type * as THREE from "three";
import { type EffectManager } from "./fire-burst.ts";
import { createModifierRevealBurstManager } from "./modifier-reveal-burst.ts";

export function createWildfireBurstManager(scene: THREE.Scene): EffectManager {
  return createModifierRevealBurstManager(scene, {
    name: "wildfire-burst",
    paletteKey: "wildfire",
    discColor: 0xff6414,
    flashColor: 0xffffff,
    discDurationMs: 1100,
    flashDurationMs: 200,
    staggerSpanMs: 600,
    discPeakOpacity: 0.7,
    flashPeakOpacity: 0.5,
  });
}
