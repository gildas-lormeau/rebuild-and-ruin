/**
 * Impact-destruction fire burst on the 1×1 fire-burst kernel. Filters
 * `destroyedWalls` to `cause === "impact"` AND `age < WALL_BURN_DURATION`:
 * fire ends at 0.7s while the entry continues sinking + dusting + tail-
 * fading until 1.2s. `decay`-cause entries get the shared base only.
 * Per-burn variation is `tileSeed`-derived.
 */

import type * as THREE from "three";
import { WALL_BURN_DURATION } from "../../../shared/core/battle-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
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
    selectEntries: (ctx) =>
      ctx.overlay?.battle?.destroyedWalls?.filter(
        (destroyedWall) =>
          destroyedWall.cause === "impact" &&
          destroyedWall.age < WALL_BURN_DURATION,
      ),
  });
}
