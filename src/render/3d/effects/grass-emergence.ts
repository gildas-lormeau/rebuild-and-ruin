/**
 * `low_water` reveal — decorative discs on top of the terrain bitmap,
 * which already paints the converted tiles as grass at apply time.
 */

import type * as THREE from "three";
import { MODIFIER_ID } from "../../../shared/core/game-constants.ts";
import { type EffectManager } from "./fire-burst.ts";
import { createModifierRevealBurstManager } from "./modifier-reveal-burst.ts";

export function createGrassEmergenceManager(scene: THREE.Scene): EffectManager {
  return createModifierRevealBurstManager(scene, {
    name: "grass-emergence",
    modifierId: MODIFIER_ID.LOW_WATER,
    discColor: 0x78c890,
    flashColor: 0xffffff,
    discDurationMs: 1100,
    flashDurationMs: 200,
    staggerSpanMs: 600,
    discPeakOpacity: 0.7,
    flashPeakOpacity: 0.5,
  });
}
