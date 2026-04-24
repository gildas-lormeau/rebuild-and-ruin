/**
 * 3D house-destroy burst — fire / smoke / sparks when a house is hit
 * by a cannonball. Reconciles `overlay.battle.houseDestroys` into
 * per-tile fire-burst hosts via the shared 1×1 factory in
 * `fire-burst.ts` (`createTileBurstManager`).
 *
 * Houses are 1×1-tile wooden buildings — the footprint matches
 * wall-burns, but the flame is taller and smokier (roof timbers
 * burning) and the life is slightly longer so the collapse reads as a
 * building coming down rather than a brick breaking.
 *
 * Lifetime is `HOUSE_DESTROY_DURATION` (~0.75 s). Aging happens in
 * `ageImpacts` on the runtime side.
 */

import type * as THREE from "three";
import { HOUSE_DESTROY_DURATION } from "../../../shared/core/battle-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import {
  createTileBurstManager,
  type EffectManager,
  type FireBurstConfig,
  makeFlameLayers,
} from "./fire-burst.ts";

export type HouseBurnsManager = EffectManager;

const HOUSE_BURST_CONFIG: FireBurstConfig = {
  clusterCount: 3,
  sparkCount: 10,
  smokePuffCount: 6,
  halfSize: TILE_SIZE / 2,
  flameHeight: TILE_SIZE * 0.7,
  flashBaseRadius: 0.55 * TILE_SIZE,
  flameOriginY: 0,
  sparkSpawnRadius: TILE_SIZE * 0.12,
  smokeJitter: TILE_SIZE * 0.2,
  clusterSpread: 1,
  clusterOffsetBase: 0.15,
  clusterOffsetRange: 0.4,
  flameWidthMulBase: 0.8,
  flameWidthMulRange: 0.4,
  flameHeightMulBase: 0.9,
  flameHeightMulRange: 0.5,
  sparkHorizMin: 0.9,
  sparkHorizRange: 1.2,
  sparkVertMin: 2.0,
  sparkVertRange: 1.3,
  sparkSizeMin: 0.15,
  sparkSizeRange: 0.12,
  smokeBaseRadius: 0.3,
  smokeRiseBase: 0.95,
  smokeRiseStep: 0.14,
  smokePuffDelay: 0.09,
  smokeBaseScaleStart: 0.65,
  smokeScaleGrowth: 1.5,
  flameLayers: makeFlameLayers(1),
};

export function createHouseBurnsManager(scene: THREE.Scene): HouseBurnsManager {
  return createTileBurstManager(scene, {
    name: "house-burns",
    config: HOUSE_BURST_CONFIG,
    duration: HOUSE_DESTROY_DURATION,
    selectEntries: (ctx) => ctx.overlay?.battle?.houseDestroys,
  });
}
