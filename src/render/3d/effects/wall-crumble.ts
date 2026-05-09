/**
 * `crumbling_walls` reveal — disc burst layered on top of the
 * runtime-driven cross-fade (`overlay.battle.crumblingWallsFade`); the
 * disc punctuates *where* walls vanished while the fade handles *what*.
 */

import type * as THREE from "three";
import { MODIFIER_ID } from "../../../shared/core/game-constants.ts";
import { type EffectManager } from "./fire-burst.ts";
import { createModifierRevealBurstManager } from "./modifier-reveal-burst.ts";

export function createWallCrumbleManager(scene: THREE.Scene): EffectManager {
  return createModifierRevealBurstManager(scene, {
    name: "wall-crumble",
    modifierId: MODIFIER_ID.CRUMBLING_WALLS,
    discColor: 0xa07030,
    flashColor: 0xffffff,
    discDurationMs: 1100,
    flashDurationMs: 200,
    staggerSpanMs: 600,
    discPeakOpacity: 0.7,
    flashPeakOpacity: 0.5,
  });
}
