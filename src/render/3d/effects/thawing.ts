/**
 * 3D thawing-tile effect — Phase 6 of the 3D renderer migration.
 *
 * When a frozen-water tile thaws back to water, the 2D renderer plays a
 * short (~THAW_DURATION seconds) crack-and-fade animation: a soft radial
 * ice tint fades out, white crack rays burst outward from the tile
 * center, and a brief white flash pulses at the start.
 *
 * The 3D path reproduces this with three flat upward-facing meshes per
 * thawing tile: a fading blue disc, a white flash disc, and a cluster
 * of 6 thin white rays. Each frame scales/tints from the
 * `ThawingTile.age / THAW_DURATION` progress value — identical math to
 * `drawFrozenTiles` in render-effects.ts.
 *
 * Note: the base ICE_COLOR on frozen tiles is handled by `terrain.ts`
 * (it writes per-vertex colors for frozen water). This module only
 * handles the post-thaw break animation. The subtler per-frame shimmer
 * overlay on *still-frozen* tiles is deferred — terrain already shows
 * frozen water as flat ice and the shimmer was polish detail.
 */

import * as THREE from "three";
import {
  THAW_DURATION,
  type ThawingTile,
} from "../../../shared/core/battle-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import { ELEVATION_STACK, Z_FIGHT_MARGIN } from "../elevation.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import { createFlatDisc, tileSeed } from "./helpers.ts";

export interface ThawingManager {
  /** Per-frame update. Rebuilds the mesh pool only when the thawing tile
   *  count changes; per-frame animation drives scale/opacity from the
   *  game's `age` field. */
  update(ctx: FrameCtx): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

interface ThawHost {
  group: THREE.Group;
  fadeMesh: THREE.Mesh;
  fadeMaterial: THREE.MeshBasicMaterial;
  flashMesh: THREE.Mesh;
  flashMaterial: THREE.MeshBasicMaterial;
  rayMeshes: THREE.Mesh[];
  rayMaterial: THREE.MeshBasicMaterial;
  seed: number;
}

// Radial crack burst count + length — mirror render-effects.ts.
const THAW_CRACK_COUNT = 6;
const THAW_CRACK_LEN = 10;
// Lift above terrain to avoid z-fighting.
// Ice fade colour: rgba(165, 210, 230, …) → 0xa5d2e6
const ICE_FADE_COLOR = 0xa5d2e6;
const WHITE = 0xffffff;

export function createThawingManager(scene: THREE.Scene): ThawingManager {
  const root = new THREE.Group();
  root.name = "thawing";
  scene.add(root);

  const discGeometry = createFlatDisc();
  const rayGeometry = new THREE.PlaneGeometry(1, 1);
  rayGeometry.rotateX(-Math.PI / 2);

  const hosts: ThawHost[] = [];
  let lastCount = -1;

  function buildHost(): ThawHost {
    const group = new THREE.Group();
    const fadeMaterial = new THREE.MeshBasicMaterial({
      color: ICE_FADE_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const fadeMesh = new THREE.Mesh(discGeometry, fadeMaterial);
    group.add(fadeMesh);

    const flashMaterial = new THREE.MeshBasicMaterial({
      color: WHITE,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const flashMesh = new THREE.Mesh(discGeometry, flashMaterial);
    group.add(flashMesh);

    // One material for all 6 rays on this host — they share opacity/color
    // each frame and only differ in position/rotation.
    const rayMaterial = new THREE.MeshBasicMaterial({
      color: WHITE,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const rayMeshes: THREE.Mesh[] = [];
    for (let i = 0; i < THAW_CRACK_COUNT; i++) {
      const mesh = new THREE.Mesh(rayGeometry, rayMaterial);
      group.add(mesh);
      rayMeshes.push(mesh);
    }

    root.add(group);
    return {
      group,
      fadeMesh,
      fadeMaterial,
      flashMesh,
      flashMaterial,
      rayMeshes,
      rayMaterial,
      seed: 0,
    };
  }

  function disposeHost(host: ThawHost): void {
    host.fadeMaterial.dispose();
    host.flashMaterial.dispose();
    host.rayMaterial.dispose();
    root.remove(host.group);
  }

  function ensurePool(count: number): void {
    if (count === lastCount) return;
    while (hosts.length < count) hosts.push(buildHost());
    while (hosts.length > count) {
      const host = hosts.pop();
      if (host) disposeHost(host);
    }
    lastCount = count;
  }

  function animateHost(host: ThawHost, tile: ThawingTile): void {
    const progress = Math.min(1, Math.max(0, tile.age / THAW_DURATION));
    const centerX = tile.col * TILE_SIZE + TILE_SIZE / 2;
    const centerZ = tile.row * TILE_SIZE + TILE_SIZE / 2;
    host.group.position.set(centerX, ELEVATION_STACK.THAWING, centerZ);
    host.seed = tileSeed(tile.row, tile.col);

    // Fading ice tint — radial gradient falloff faked by a solid disc
    // that shrinks + fades.
    const fadeAlpha = (1 - progress) * 0.6;
    const fadeRadius = TILE_SIZE * (0.7 - progress * 0.4);
    if (fadeAlpha > 0.01 && fadeRadius > 0) {
      host.fadeMaterial.opacity = fadeAlpha;
      host.fadeMesh.scale.set(fadeRadius, 1, fadeRadius);
      host.fadeMesh.visible = true;
    } else {
      host.fadeMesh.visible = false;
    }

    // Crack rays — white lines radiating outward, length ramping to
    // THAW_CRACK_LEN as progress increases.
    const burstAlpha = Math.max(0, 1 - progress * 1.5);
    if (burstAlpha > 0) {
      host.rayMaterial.opacity = burstAlpha;
      const burstLen = THAW_CRACK_LEN * Math.min(1, progress * 2.5);
      for (let ray = 0; ray < THAW_CRACK_COUNT; ray++) {
        const angle =
          ((Math.PI * 2) / THAW_CRACK_COUNT) * ray +
          ((host.seed >> (ray % 8)) % 10) * 0.1;
        const mesh = host.rayMeshes[ray]!;
        const rayX = Math.cos(angle) * (burstLen / 2);
        const rayZ = Math.sin(angle) * (burstLen / 2);
        mesh.position.set(rayX, Z_FIGHT_MARGIN, rayZ);
        mesh.rotation.y = -angle;
        mesh.scale.set(burstLen, 1, 1);
        mesh.visible = true;
      }
    } else {
      for (const mesh of host.rayMeshes) mesh.visible = false;
    }

    // Brief white flash at the very start.
    if (progress < 0.15) {
      const flashAlpha = (1 - progress / 0.15) * 0.4;
      host.flashMaterial.opacity = flashAlpha;
      host.flashMesh.scale.set(TILE_SIZE * 0.6, 1, TILE_SIZE * 0.6);
      host.flashMesh.visible = true;
    } else {
      host.flashMesh.visible = false;
    }
  }

  function update(ctx: FrameCtx): void {
    const { overlay } = ctx;
    const thawing = overlay?.entities?.thawingTiles ?? [];
    ensurePool(thawing.length);
    for (let i = 0; i < thawing.length; i++) {
      animateHost(hosts[i]!, thawing[i]!);
    }
  }

  function dispose(): void {
    for (const host of hosts) disposeHost(host);
    hosts.length = 0;
    discGeometry.dispose();
    rayGeometry.dispose();
    scene.remove(root);
  }

  return { update, dispose };
}
