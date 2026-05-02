/**
 * 3D ice-formation reveal — `frozen_river` modifier. Per-tile frosty disc
 * grows + fades over ~1.1 s with a brief white flash ring at each tile's
 * stagger start. Decorative on top of the terrain bitmap, which already
 * paints these tiles as frozen at apply time.
 *
 * All animation logic lives in `createModifierRevealBurstManager`; this
 * file just supplies the per-modifier config.
 */

import type * as THREE from "three";
import { type EffectManager } from "./fire-burst.ts";
import { createModifierRevealBurstManager } from "./modifier-reveal-burst.ts";

export type IceFormationManager = EffectManager;

export function createIceFormationManager(
  scene: THREE.Scene,
): IceFormationManager {
  return createModifierRevealBurstManager(scene, {
    name: "ice-formation",
    paletteKey: "frozen_river",
    discColor: 0xc0e0ff,
    flashColor: 0xffffff,
    discDurationMs: 1100,
    flashDurationMs: 200,
    staggerSpanMs: 600,
    discPeakOpacity: 0.7,
    flashPeakOpacity: 0.5,
  });
}
