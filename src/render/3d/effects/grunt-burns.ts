/**
 * 3D grunt-kill burst — fire / smoke / sparks when a grunt (tank) is
 * killed by a cannonball. Reconciles `overlay.battle.gruntKills` into
 * per-tile fire-burst hosts via the shared 1×1 factory in
 * `fire-burst.ts` (`createTileBurstManager`).
 *
 * Grunts are 1×1-tile tanks — the footprint matches wall-burns, but
 * the palette bumps the emissive glow (fuel cooking off) and the spark
 * count / velocity sits between a wall and a cannon so the blast reads
 * as "tank brewed up" rather than "brick broke".
 *
 * Lifetime is `GRUNT_KILL_DURATION` (~0.55 s). Aging happens in
 * `ageImpacts` on the runtime side.
 */

import type * as THREE from "three";
import { GRUNT_KILL_DURATION } from "../../../shared/core/battle-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import {
  createTileBurstManager,
  type EffectManager,
  type FireBurstConfig,
  makeFlameLayers,
} from "./fire-burst.ts";

export type GruntBurnsManager = EffectManager;

const GRUNT_BURST_CONFIG: FireBurstConfig = {
  clusterCount: 3,
  sparkCount: 14,
  smokePuffCount: 4,
  halfSize: TILE_SIZE / 2,
  flameHeight: TILE_SIZE * 0.6,
  flashBaseRadius: 0.6 * TILE_SIZE,
  flameOriginY: 0,
  sparkSpawnRadius: TILE_SIZE * 0.15,
  smokeJitter: TILE_SIZE * 0.18,
  clusterSpread: 1,
  clusterOffsetBase: 0.1,
  clusterOffsetRange: 0.4,
  flameWidthMulBase: 0.75,
  flameWidthMulRange: 0.4,
  flameHeightMulBase: 0.8,
  flameHeightMulRange: 0.5,
  sparkHorizMin: 1.2,
  sparkHorizRange: 1.6,
  sparkVertMin: 2.5,
  sparkVertRange: 1.6,
  sparkSizeMin: 0.18,
  sparkSizeRange: 0.14,
  smokeBaseRadius: 0.26,
  smokeRiseBase: 1.15,
  smokeRiseStep: 0.16,
  smokePuffDelay: 0.08,
  smokeBaseScaleStart: 0.6,
  smokeScaleGrowth: 1.35,
  flameLayers: makeFlameLayers(1.15),
};

export function createGruntBurnsManager(scene: THREE.Scene): GruntBurnsManager {
  return createTileBurstManager(scene, {
    name: "grunt-burns",
    config: GRUNT_BURST_CONFIG,
    duration: GRUNT_KILL_DURATION,
    selectEntries: (ctx) => ctx.overlay?.battle?.gruntKills,
  });
}
