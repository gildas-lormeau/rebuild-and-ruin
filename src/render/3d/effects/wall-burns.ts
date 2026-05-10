/**
 * Impact-destruction fire burst — plays AFTER the sink + dust + tail-
 * fade window. Filters impact entries to the post-sink window and
 * re-bases age to fire-relative time. Sequence: wall collapses
 * (0..0.4s), then explosion flash from rubble (0.4..0.65s).
 * Decay-cause entries get no fire layer.
 */

import type * as THREE from "three";
import {
  type DestroyedWall,
  WALL_BURN_DURATION,
} from "../../../shared/core/battle-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import { WALL_DESTROY_ANIM_DURATION } from "../../../shared/core/wall-destroy-anim.ts";
import {
  createTileBurstManager,
  type EffectManager,
  type FireBurstConfig,
  makeFlameLayers,
} from "./fire-burst.ts";

export type WallBurnsManager = EffectManager;

const WALL_BURST_CONFIG: FireBurstConfig = {
  clusterCount: 3,
  sparkCount: 12,
  smokePuffCount: 5,
  halfSize: TILE_SIZE / 2,
  flameHeight: TILE_SIZE / 2,
  flashBaseRadius: 0.55 * TILE_SIZE,
  flameOriginY: 0,
  sparkSpawnRadius: 0,
  smokeJitter: TILE_SIZE * 0.15,
  clusterSpread: 1,
  clusterOffsetBase: 0.15,
  clusterOffsetRange: 0.35,
  flameWidthMulBase: 0.7,
  flameWidthMulRange: 0.4,
  flameHeightMulBase: 0.7,
  flameHeightMulRange: 0.5,
  sparkHorizMin: 1.0,
  sparkHorizRange: 1.3,
  sparkVertMin: 2.1,
  sparkVertRange: 1.4,
  sparkSizeMin: 0.16,
  sparkSizeRange: 0.12,
  smokeBaseRadius: 0.225,
  smokeRiseBase: 1.1,
  smokeRiseStep: 0.16,
  smokePuffDelay: 0.08,
  smokeBaseScaleStart: 0.6,
  smokeScaleGrowth: 1.3,
  flameLayers: makeFlameLayers(1),
};

export function createWallBurnsManager(scene: THREE.Scene): WallBurnsManager {
  return createTileBurstManager(scene, {
    name: "wall-burns",
    config: WALL_BURST_CONFIG,
    duration: WALL_BURN_DURATION,
    selectEntries: (ctx) => {
      const all = ctx.overlay?.battle?.destroyedWalls;
      if (!all) return undefined;
      const out: DestroyedWall[] = [];
      for (const wall of all) {
        if (wall.cause !== "impact") continue;
        const fireAge = wall.age - WALL_DESTROY_ANIM_DURATION;
        if (fireAge < 0 || fireAge >= WALL_BURN_DURATION) continue;
        // Re-base age to fire-relative time so the kernel's animation
        // pipeline sees a standard 0..duration timeline.
        out.push({ ...wall, age: fireAge });
      }
      return out;
    },
  });
}
