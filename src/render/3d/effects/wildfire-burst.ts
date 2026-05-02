/**
 * 3D wildfire-burst reveal — `wildfire` modifier. Per-tile orange disc
 * grows + fades on each burn-scar tile, ordered as a left-to-right wave
 * across the affected columns so the reveal reads as fire propagating
 * with the wind rather than a uniform burst field.
 *
 * Disc tint matches the `wildfire` palette pulseColor for parity with
 * the legacy 2D reveal indicator.
 */

import type * as THREE from "three";
import { GRID_COLS } from "../../../shared/core/grid.ts";
import { type EffectManager } from "./fire-burst.ts";
import { createModifierRevealBurstManager } from "./modifier-reveal-burst.ts";

export function createWildfireBurstManager(scene: THREE.Scene): EffectManager {
  return createModifierRevealBurstManager(scene, {
    name: "wildfire-burst",
    paletteKey: "wildfire",
    discColor: 0xff6414,
    flashColor: 0xffffff,
    discDurationMs: 1100,
    flashDurationMs: 200,
    staggerSpanMs: 600,
    discPeakOpacity: 0.7,
    flashPeakOpacity: 0.5,
    computeDelays: wildfireWaveDelays,
  });
}

function wildfireWaveDelays(
  tiles: readonly number[],
  staggerSpanMs: number,
): readonly number[] {
  if (tiles.length === 0) return [];
  let minCol = Infinity;
  let maxCol = -Infinity;
  for (const key of tiles) {
    const col = key % GRID_COLS;
    if (col < minCol) minCol = col;
    if (col > maxCol) maxCol = col;
  }
  const span = Math.max(1, maxCol - minCol);
  const result: number[] = [];
  for (const key of tiles) {
    const col = key % GRID_COLS;
    const t = (col - minCol) / span;
    result.push(t * staggerSpanMs);
  }
  return result;
}
