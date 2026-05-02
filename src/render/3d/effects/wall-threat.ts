/**
 * 3D wall-threat reveal — `sapper` modifier. Per-tile copper-brown disc
 * grows + fades on each wall a sapper grunt will attack
 * (`grunt.targetedWall`, surfaced via `overlay.ui.modifierReveal.tiles`).
 *
 * Disc tint matches the `sapper` palette pulseColor for parity with the
 * legacy 2D reveal indicator.
 */

import type * as THREE from "three";
import { type EffectManager } from "./fire-burst.ts";
import { createModifierRevealBurstManager } from "./modifier-reveal-burst.ts";

export type WallThreatManager = EffectManager;

export function createWallThreatManager(scene: THREE.Scene): WallThreatManager {
  return createModifierRevealBurstManager(scene, {
    name: "wall-threat",
    paletteKey: "sapper",
    discColor: 0xa07050,
    flashColor: 0xffffff,
    discDurationMs: 1100,
    flashDurationMs: 200,
    staggerSpanMs: 600,
    discPeakOpacity: 0.7,
    flashPeakOpacity: 0.5,
  });
}
