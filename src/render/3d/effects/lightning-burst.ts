/**
 * 3D lightning-burst reveal — `dry_lightning` modifier. Per-tile yellow
 * disc grows + fades on each newly ignited grass tile. Decorative on
 * top of the burning-pit meshes already drawn at apply time.
 *
 * Disc tint matches the `dry_lightning` palette pulseColor for parity
 * with the legacy 2D reveal indicator.
 */

import type * as THREE from "three";
import { type EffectManager } from "./fire-burst.ts";
import { createModifierRevealBurstManager } from "./modifier-reveal-burst.ts";

export function createLightningBurstManager(scene: THREE.Scene): EffectManager {
  return createModifierRevealBurstManager(scene, {
    name: "lightning-burst",
    paletteKey: "dry_lightning",
    discColor: 0xf0d060,
    flashColor: 0xffffff,
    discDurationMs: 1100,
    flashDurationMs: 200,
    staggerSpanMs: 600,
    discPeakOpacity: 0.7,
    flashPeakOpacity: 0.5,
  });
}
