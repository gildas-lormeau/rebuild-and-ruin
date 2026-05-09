/**
 * `high_tide` reveal — decorative discs on top of the terrain bitmap,
 * which already paints the flooded tiles as water at apply time.
 */

import type * as THREE from "three";
import { MODIFIER_ID } from "../../../shared/core/game-constants.ts";
import { type EffectManager } from "./fire-burst.ts";
import { createModifierRevealBurstManager } from "./modifier-reveal-burst.ts";

export function createWaterSurgeManager(scene: THREE.Scene): EffectManager {
  return createModifierRevealBurstManager(scene, {
    name: "water-surge",
    modifierId: MODIFIER_ID.HIGH_TIDE,
    discColor: 0x3c8cf0,
    flashColor: 0xffffff,
    discDurationMs: 1100,
    flashDurationMs: 200,
    staggerSpanMs: 600,
    discPeakOpacity: 0.7,
    flashPeakOpacity: 0.5,
  });
}
