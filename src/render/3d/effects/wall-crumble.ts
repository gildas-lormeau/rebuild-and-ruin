/**
 * 3D wall-crumble reveal — `crumbling_walls` modifier. Per-tile tan disc
 * grows + fades on each destroyed wall tile. Layered on top of the
 * runtime-driven cross-fade (walls fade out, debris fades in via
 * `overlay.battle.crumblingWallsFade`); the disc-burst punctuates *where*
 * walls vanished while the fade handles the *what*.
 *
 * Disc tint matches the `crumbling_walls` banner border for parity.
 */

import type * as THREE from "three";
import { type EffectManager } from "./fire-burst.ts";
import { createModifierRevealBurstManager } from "./modifier-reveal-burst.ts";

export function createWallCrumbleManager(scene: THREE.Scene): EffectManager {
  return createModifierRevealBurstManager(scene, {
    name: "wall-crumble",
    paletteKey: "crumbling_walls",
    discColor: 0xa07030,
    flashColor: 0xffffff,
    discDurationMs: 1100,
    flashDurationMs: 200,
    staggerSpanMs: 600,
    discPeakOpacity: 0.7,
    flashPeakOpacity: 0.5,
  });
}
