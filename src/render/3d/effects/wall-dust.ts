/**
 * Wall-destruction dust puff — vertical billboard per `DestroyedWall`
 * entry, faded by per-tile `wallDestroyAnimAt(age).dustOpacity` for
 * `impact`-cause and the global `crumblingWallsAnim.dustOpacity` for
 * `decay`-cause. Sizing/seeding is `tileSeed`-derived. Shared dust
 * layer for both causes; wall-burns stacks fire on impact entries.
 */

import * as THREE from "three";
import { GRID_COLS, TILE_SIZE } from "../../../shared/core/grid.ts";
import { wallDestroyAnimAt } from "../../../shared/core/wall-destroy-anim.ts";
import { ELEVATION_STACK, Z_FIGHT_MARGIN } from "../elevation.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import type { EffectManager } from "./fire-burst.ts";
import { tileSeed } from "./helpers.ts";

interface DustHost {
  group: THREE.Group;
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  scaleMul: number;
  heightOffset: number;
}

const DUST_COLOR = 0xc8b890;
const DUST_BASE_RADIUS = TILE_SIZE * 0.45;
const DUST_HEIGHT_BASE = TILE_SIZE * 0.4;
const DUST_HEIGHT_RANGE = TILE_SIZE * 0.5;
const DUST_SCALE_MIN = 0.7;
const DUST_SCALE_RANGE = 0.5;

export function createWallDustManager(scene: THREE.Scene): EffectManager {
  const root = new THREE.Group();
  root.name = "wall-dust";
  scene.add(root);

  // Vertical billboard plane — faces the camera (Y-up rotation only).
  const geometry = new THREE.PlaneGeometry(1, 1);
  const hosts = new Map<number, DustHost>();
  const seenThisFrame = new Set<number>();

  function buildHost(tileKey: number, row: number, col: number): DustHost {
    const seed = tileSeed(row, col);
    // Deterministic per-tile variation from tileSeed: scale, height,
    // tint jitter. Same per-tile values every frame — no randomness
    // bleeds into game state.
    const scaleMul =
      DUST_SCALE_MIN + (((seed >>> 4) & 0xff) / 255) * DUST_SCALE_RANGE;
    const heightOffset = ((seed >>> 12) & 0xff) / 255;

    const material = new THREE.MeshBasicMaterial({
      color: DUST_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);

    const group = new THREE.Group();
    group.position.set(
      (col + 0.5) * TILE_SIZE,
      ELEVATION_STACK.WALL_BURNS + Z_FIGHT_MARGIN,
      (row + 0.5) * TILE_SIZE,
    );
    group.add(mesh);
    root.add(group);

    const host: DustHost = {
      group,
      mesh,
      material,
      scaleMul,
      heightOffset,
    };
    hosts.set(tileKey, host);
    return host;
  }

  function disposeHost(host: DustHost): void {
    host.material.dispose();
    root.remove(host.group);
  }

  function update(ctx: FrameCtx): void {
    const decayAnim = ctx.overlay?.battle?.crumblingWallsAnim;
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
      const dustOpacity =
        wall.cause === "decay"
          ? (decayAnim?.dustOpacity ?? 0)
          : wallDestroyAnimAt(wall.age * 1000).dustOpacity;
      if (dustOpacity <= 0) continue;
      const tileKey = wall.row * GRID_COLS + wall.col;
      seenThisFrame.add(tileKey);
      const host = hosts.get(tileKey) ?? buildHost(tileKey, wall.row, wall.col);
      const radius = DUST_BASE_RADIUS * host.scaleMul;
      const height = DUST_HEIGHT_BASE + DUST_HEIGHT_RANGE * host.heightOffset;
      host.mesh.scale.set(radius * 2, height, 1);
      // Lift mesh so its base sits at host.group.position (so the puff
      // grows upward from the tile rather than centering through ground).
      host.mesh.position.y = height / 2;
      host.material.opacity = dustOpacity;
    }

    // Reap hosts whose tiles no longer have an active dust puff.
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
    geometry.dispose();
    scene.remove(root);
  }

  return { update, dispose };
}
