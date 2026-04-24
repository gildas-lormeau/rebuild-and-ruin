/**
 * 3D wall-burn effect — fire / smoke / sparks burst when a wall is
 * destroyed. Reconciles `overlay.battle.wallBurns: WallBurn[]` into per-tile
 * fire-burst hosts (see `fire-burst.ts` for the shared primitive bundle
 * + animation kernel).
 *
 * Effect lifetime is `WALL_BURN_DURATION` (~0.7 s). Aging happens in
 * `ageImpacts` on the runtime side; expired entries drop out of
 * `battleAnim.wallBurns` and the host is disposed on the next reconcile.
 *
 * Per-burn variation derives deterministically from `tileSeed(row, col)`
 * — same wall always animates identically — so no spawn-time random
 * state lives on `WallBurn` itself.
 */

import * as THREE from "three";
import {
  WALL_BURN_DURATION,
  type WallBurn,
} from "../../../shared/core/battle-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import { ELEVATION_STACK } from "../elevation.ts";
import {
  animateFireBurst,
  createFireBurstHost,
  disposeFireBurstHost,
  type EffectManager,
  type FireBurstConfig,
  type FireBurstHost,
  makeFlameLayers,
} from "./fire-burst.ts";
import { tileSeed, tileSignature } from "./helpers.ts";

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
  const root = new THREE.Group();
  root.name = "wall-burns";
  scene.add(root);

  const hosts: FireBurstHost[] = [];
  let lastSignature: string | undefined;

  function rebuild(burns: readonly WallBurn[]): void {
    for (const host of hosts) disposeFireBurstHost(root, host);
    hosts.length = 0;
    for (const burn of burns) {
      hosts.push(
        createFireBurstHost(
          root,
          burn.col * TILE_SIZE + TILE_SIZE / 2,
          ELEVATION_STACK.WALL_BURNS,
          burn.row * TILE_SIZE + TILE_SIZE / 2,
          tileSeed(burn.row, burn.col),
          WALL_BURST_CONFIG,
        ),
      );
    }
  }

  return {
    update(ctx) {
      const burns = ctx.overlay?.battle?.wallBurns ?? [];
      const signature = tileSignature(burns);
      if (signature !== lastSignature) {
        lastSignature = signature;
        rebuild(burns);
      }
      if (burns.length === 0) return;
      for (let i = 0; i < burns.length; i++) {
        const host = hosts[i];
        const burn = burns[i];
        if (!host || !burn) continue;
        animateFireBurst(host, burn.age, WALL_BURN_DURATION);
      }
    },
    dispose() {
      for (const host of hosts) disposeFireBurstHost(root, host);
      hosts.length = 0;
      scene.remove(root);
    },
  };
}
