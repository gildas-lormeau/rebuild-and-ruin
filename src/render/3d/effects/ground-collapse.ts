/**
 * `sinkhole` reveal — decorative discs on top of the terrain bitmap,
 * which already paints the collapsed tiles as water at apply time.
 */

import type * as THREE from "three";
import { MODIFIER_ID } from "../../../shared/core/game-constants.ts";
import { type EffectManager } from "./fire-burst.ts";
import { createModifierRevealBurstManager } from "./modifier-reveal-burst.ts";

export function createGroundCollapseManager(scene: THREE.Scene): EffectManager {
  return createModifierRevealBurstManager(scene, {
    name: "ground-collapse",
    modifierId: MODIFIER_ID.SINKHOLE,
    discColor: 0xa05a28,
    flashColor: 0xffffff,
    discDurationMs: 1100,
    flashDurationMs: 200,
    staggerSpanMs: 600,
    discPeakOpacity: 0.7,
    flashPeakOpacity: 0.5,
  });
}
