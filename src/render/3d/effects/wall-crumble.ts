/**
 * 3D wall-crumble reveal — `crumbling_walls` modifier. Per-tile tan disc
 * grows + fades on each outer wall tile that just crumbled into nothing.
 *
 * Disc tint matches the `crumbling_walls` palette pulseColor for parity
 * with the legacy 2D reveal indicator. The wall geometry was already
 * removed at apply time; this is the announcement burst on the now-empty
 * tile.
 */

import type * as THREE from "three";
import { type EffectManager } from "./fire-burst.ts";
import { createModifierRevealBurstManager } from "./modifier-reveal-burst.ts";

export function createWallCrumbleManager(scene: THREE.Scene): EffectManager {
  return createModifierRevealBurstManager(scene, {
    name: "wall-crumble",
    paletteKey: "crumbling_walls",
    discColor: 0xb48c50,
    flashColor: 0xffffff,
    discDurationMs: 1100,
    flashDurationMs: 200,
    staggerSpanMs: 600,
    discPeakOpacity: 0.7,
    flashPeakOpacity: 0.5,
  });
}
