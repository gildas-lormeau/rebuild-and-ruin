/**
 * 3D rubble-cleared reveal — `rubble_clearing` modifier. Per-tile green
 * disc grows + fades on each tile where dead-cannon debris or burning
 * pits were just removed.
 *
 * Disc tint matches the `rubble_clearing` palette pulseColor for parity
 * with the legacy 2D reveal indicator. Conceptual mismatch flagged: this
 * factory asserts presence (a thing appears) while the modifier removes
 * things — may want a fade-out variant in a follow-up.
 */

import type * as THREE from "three";
import { type EffectManager } from "./fire-burst.ts";
import { createModifierRevealBurstManager } from "./modifier-reveal-burst.ts";

export type RubbleClearedManager = EffectManager;

export function createRubbleClearedManager(
  scene: THREE.Scene,
): RubbleClearedManager {
  return createModifierRevealBurstManager(scene, {
    name: "rubble-cleared",
    paletteKey: "rubble_clearing",
    discColor: 0x8cc878,
    flashColor: 0xffffff,
    discDurationMs: 1100,
    flashDurationMs: 200,
    staggerSpanMs: 600,
    discPeakOpacity: 0.7,
    flashPeakOpacity: 0.5,
  });
}
