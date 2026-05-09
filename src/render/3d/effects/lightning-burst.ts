/**
 * `dry_lightning` reveal — tiles fire one-by-one in reading order with
 * delays evenly spaced across the stagger window so each strike reads
 * as its own discrete bolt rather than blending into a burst field.
 */

import type * as THREE from "three";
import { MODIFIER_ID } from "../../../shared/core/game-constants.ts";
import { type EffectManager } from "./fire-burst.ts";
import { createModifierRevealBurstManager } from "./modifier-reveal-burst.ts";

export function createLightningBurstManager(scene: THREE.Scene): EffectManager {
  return createModifierRevealBurstManager(scene, {
    name: "lightning-burst",
    modifierId: MODIFIER_ID.DRY_LIGHTNING,
    discColor: 0xf0d060,
    flashColor: 0xffffff,
    discDurationMs: 600,
    flashDurationMs: 380,
    staggerSpanMs: 1300,
    discPeakOpacity: 0.5,
    flashPeakOpacity: 0.95,
    computeDelays: lightningSequentialDelays,
  });
}

function lightningSequentialDelays(
  tiles: readonly number[],
  staggerSpanMs: number,
): readonly number[] {
  if (tiles.length === 0) return [];
  if (tiles.length === 1) return [0];
  const order = tiles.map((_, idx) => idx);
  order.sort((a, b) => tiles[a]! - tiles[b]!);
  const step = staggerSpanMs / (tiles.length - 1);
  const result: number[] = new Array(tiles.length);
  for (let rank = 0; rank < order.length; rank++) {
    result[order[rank]!] = rank * step;
  }
  return result;
}
