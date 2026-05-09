/**
 * `frozen_river` reveal — decorative discs on top of the terrain
 * bitmap, which already paints the frozen tiles at apply time.
 */

import type * as THREE from "three";
import { MODIFIER_ID } from "../../../shared/core/game-constants.ts";
import { type EffectManager } from "./fire-burst.ts";
import { createModifierRevealBurstManager } from "./modifier-reveal-burst.ts";

export function createIceFormationManager(scene: THREE.Scene): EffectManager {
  return createModifierRevealBurstManager(scene, {
    name: "ice-formation",
    modifierId: MODIFIER_ID.FROZEN_RIVER,
    discColor: 0xc0e0ff,
    flashColor: 0xffffff,
    discDurationMs: 1100,
    flashDurationMs: 200,
    staggerSpanMs: 600,
    discPeakOpacity: 0.7,
    flashPeakOpacity: 0.5,
  });
}
