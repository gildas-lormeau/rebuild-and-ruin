/**
 * 3D cannon-destroy burst — heavier cousin of wall-burns. Reconciles
 * `overlay.battle.cannonDestroys: CannonDestroy[]` into per-cannon
 * fire-burst hosts sized to the cannon's footprint (2×2 normal /
 * balloon / rampart, 3×3 super gun).
 *
 * Same primitive bundle as wall-burns (see `fire-burst.ts`) but ~1.5×
 * scale and density — 5 flame clusters / 18 sparks / 7 smoke puffs,
 * sparks spawn from a small ring inside the footprint instead of a
 * single point, and the burst lives a hair longer
 * (`CANNON_DESTROY_DURATION`) so the heavier blast has room to read.
 *
 * Per-burst variation derives deterministically from `tileSeed(row,
 * col)` of the cannon's top-left tile.
 */

import * as THREE from "three";
import {
  CANNON_DESTROY_DURATION,
  type CannonDestroy,
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
import { tileSeed } from "./helpers.ts";

export type CannonBurnsManager = EffectManager;

interface SizedHost {
  host: FireBurstHost;
  size: number;
}

const CANNON_FLAME_LAYERS = makeFlameLayers(1.15);

export function createCannonBurnsManager(
  scene: THREE.Scene,
): CannonBurnsManager {
  const root = new THREE.Group();
  root.name = "cannon-burns";
  scene.add(root);

  const hosts: SizedHost[] = [];
  let lastSignature: string | undefined;

  function rebuild(destroys: readonly CannonDestroy[]): void {
    for (const slot of hosts) disposeFireBurstHost(root, slot.host);
    hosts.length = 0;
    for (const destroy of destroys) {
      const footprintPx = destroy.size * TILE_SIZE;
      const config = makeConfig(footprintPx);
      const host = createFireBurstHost(
        root,
        destroy.col * TILE_SIZE + footprintPx / 2,
        ELEVATION_STACK.WALL_BURNS,
        destroy.row * TILE_SIZE + footprintPx / 2,
        tileSeed(destroy.row, destroy.col),
        config,
      );
      hosts.push({ host, size: destroy.size });
    }
  }

  return {
    update(ctx) {
      const destroys = ctx.overlay?.battle?.cannonDestroys ?? [];
      const signature = signatureOf(destroys);
      if (signature !== lastSignature) {
        lastSignature = signature;
        rebuild(destroys);
      }
      if (destroys.length === 0) return;
      for (let i = 0; i < destroys.length; i++) {
        const slot = hosts[i];
        const destroy = destroys[i];
        if (!slot || !destroy) continue;
        animateFireBurst(slot.host, destroy.age, CANNON_DESTROY_DURATION);
      }
    },
    dispose() {
      for (const slot of hosts) disposeFireBurstHost(root, slot.host);
      hosts.length = 0;
      scene.remove(root);
    },
  };
}

function makeConfig(footprintPx: number): FireBurstConfig {
  return {
    clusterCount: 5,
    sparkCount: 18,
    smokePuffCount: 7,
    halfSize: footprintPx / 2,
    flameHeight: TILE_SIZE * 0.75,
    flashBaseRadius: 0.55 * footprintPx,
    flameOriginY: footprintPx * 0.05,
    sparkSpawnRadius: footprintPx * 0.25,
    smokeJitter: footprintPx * 0.275,
    clusterSpread: 1.2,
    clusterOffsetBase: 0.15,
    clusterOffsetRange: 0.55,
    flameWidthMulBase: 0.8,
    flameWidthMulRange: 0.4,
    flameHeightMulBase: 0.8,
    flameHeightMulRange: 0.5,
    sparkHorizMin: 1.5,
    sparkHorizRange: 1.95,
    sparkVertMin: 3.15,
    sparkVertRange: 2.1,
    sparkSizeMin: 0.24,
    sparkSizeRange: 0.18,
    smokeBaseRadius: 0.34,
    smokeRiseBase: 1.1,
    smokeRiseStep: 0.16,
    smokePuffDelay: 0.07,
    smokeBaseScaleStart: 0.7,
    smokeScaleGrowth: 1.4,
    flameLayers: CANNON_FLAME_LAYERS,
  };
}

function signatureOf(destroys: readonly CannonDestroy[]): string {
  if (destroys.length === 0) return "";
  const parts: string[] = [];
  for (const destroy of destroys) {
    parts.push(`${destroy.col}:${destroy.row}:${destroy.size}`);
  }
  return parts.join("|");
}
