/**
 * Wall-destruction dust puff — camera-facing sprite per `DestroyedWall`
 * entry, faded by per-tile `wallDestroyAnimAt(age).dustOpacity`. Sprite
 * (not Mesh) so the puff is always camera-facing and reads from the
 * game's tilted overhead view; sized + lifted so it blooms around the
 * wall body instead of sitting buried at its base.
 */

import * as THREE from "three";
import {
  GRID_COLS,
  TILE_SIZE,
  type TileKey,
} from "../../../shared/core/grid.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import { wallDestroyAnimAt } from "../wall-destroy-anim.ts";
import { type EffectManager, getSharedSmokeTexture } from "./fire-burst.ts";
import { tileSeed } from "./helpers.ts";

interface DustHost {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  baseSize: number;
  centerY: number;
}

const DUST_COLOR = 0xc8b890;
/** Wall body top in world units (matches `WALL_TOP_Y` in elevation.ts:
 *  authored 3.22 sprite units × `TILE_SIZE / 2 = 8`). Dust is centered
 *  around half of this so the puff straddles the wall body — readable
 *  on either side under camera tilt instead of buried inside it. */
const WALL_TOP_Y = 3.22 * (TILE_SIZE / 2);
/** Sprite center Y. Slightly under wall mid-height so the puff reads as
 *  kicking up from the base rather than crowning the wall. */
const DUST_CENTER_Y_BASE = WALL_TOP_Y * 0.45;
const DUST_CENTER_Y_RANGE = WALL_TOP_Y * 0.15;
/** Base sprite size (world units). 1.6× tile so the puff visibly blooms
 *  past the wall's footprint on both sides under tilt. */
const DUST_SIZE_BASE = TILE_SIZE * 1.6;
const DUST_SIZE_RANGE = TILE_SIZE * 0.4;

export function createWallDustManager(scene: THREE.Scene): EffectManager {
  const root = new THREE.Group();
  root.name = "wall-dust";
  scene.add(root);

  const texture = getSharedSmokeTexture();
  const hosts = new Map<TileKey, DustHost>();
  const seenThisFrame = new Set<TileKey>();

  function buildHost(tileKey: TileKey, row: number, col: number): DustHost {
    const seed = tileSeed(row, col);
    const sizeRand = ((seed >>> 4) & 0xff) / 255;
    const centerRand = ((seed >>> 12) & 0xff) / 255;
    const baseSize = DUST_SIZE_BASE + DUST_SIZE_RANGE * sizeRand;
    const centerY = DUST_CENTER_Y_BASE + DUST_CENTER_Y_RANGE * centerRand;

    const material = new THREE.SpriteMaterial({
      color: DUST_COLOR,
      map: texture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(
      (col + 0.5) * TILE_SIZE,
      centerY,
      (row + 0.5) * TILE_SIZE,
    );
    root.add(sprite);

    const host: DustHost = { sprite, material, baseSize, centerY };
    hosts.set(tileKey, host);
    return host;
  }

  function disposeHost(host: DustHost): void {
    host.material.dispose();
    root.remove(host.sprite);
  }

  function update(ctx: FrameCtx): void {
    const destroyedWalls = ctx.overlay?.battle?.destroyedWalls;
    if (!destroyedWalls) {
      if (hosts.size > 0) {
        for (const host of hosts.values()) disposeHost(host);
        hosts.clear();
      }
      return;
    }

    seenThisFrame.clear();
    for (const wall of destroyedWalls) {
      const dustOpacity = wallDestroyAnimAt(wall.age * 1000).dustOpacity;
      if (dustOpacity <= 0) continue;
      const tileKey = (wall.row * GRID_COLS + wall.col) as TileKey;
      seenThisFrame.add(tileKey);
      const host = hosts.get(tileKey) ?? buildHost(tileKey, wall.row, wall.col);
      host.sprite.scale.set(host.baseSize, host.baseSize, 1);
      host.material.opacity = dustOpacity;
    }

    for (const [tileKey, host] of hosts) {
      if (!seenThisFrame.has(tileKey)) {
        disposeHost(host);
        hosts.delete(tileKey);
      }
    }
  }

  function dispose(): void {
    for (const host of hosts.values()) disposeHost(host);
    hosts.clear();
    scene.remove(root);
  }

  return { update, dispose };
}
