/**
 * 3D spawn-burst reveal — `grunt_surge` modifier. Per-tile red disc
 * grows + fades on each tile where a surge grunt just spawned.
 *
 * Disc tint matches the `grunt_surge` palette pulseColor for parity
 * with the legacy 2D reveal indicator. The grunts themselves are
 * already on the map at apply time; this is the announcement burst on
 * each spawn tile.
 */

import type * as THREE from "three";
import { type EffectManager } from "./fire-burst.ts";
import { createModifierRevealBurstManager } from "./modifier-reveal-burst.ts";

export function createSpawnBurstManager(scene: THREE.Scene): EffectManager {
  return createModifierRevealBurstManager(scene, {
    name: "spawn-burst",
    paletteKey: "grunt_surge",
    discColor: 0xdc3232,
    flashColor: 0xffffff,
    discDurationMs: 1100,
    flashDurationMs: 200,
    staggerSpanMs: 600,
    discPeakOpacity: 0.7,
    flashPeakOpacity: 0.5,
  });
}
