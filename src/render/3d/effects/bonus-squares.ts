/**
 * 3D bonus-square indicators — flashing green discs that hover over each
 * `overlay.entities.bonusSquares` tile outside of battle.
 *
 * Mirrors the 2D `drawBonusSquares`: alpha pulses on the same
 * `BONUS_FLASH_MS` cadence, tile-diameter circle fill, no outline,
 * `BONUS_CIRCLE_COLOR` fill. The terrain mesh deliberately leaves
 * bonus tiles transparent (see terrain.ts) so the checker grass under
 * the disc still reads as grass through the edges and the disc looks
 * like a pickup sitting on the ground.
 *
 * Mesh strategy: one shared CircleGeometry rotated flat onto the XZ
 * plane, one MeshBasicMaterial whose opacity we rewrite per frame with
 * the pulse, and a pool of Meshes matched to the bonus-tile count.
 * `renderOrder` is set high and `depthTest` is off so the disc is
 * never occluded by the terrain mesh, walls, or entities.
 */

import * as THREE from "three";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import type { RenderOverlay } from "../../../shared/ui/overlay-types.ts";
import {
  BONUS_CIRCLE_COLOR,
  BONUS_FLASH_MS,
} from "../../../shared/ui/theme.ts";
import { ELEVATION_STACK, RENDER_ORDER } from "../elevation.ts";

export interface BonusSquaresManager {
  update(overlay: RenderOverlay | undefined, now: number): void;
  dispose(): void;
}

/** Segment count for the disc. 32 is plenty for a tile-sized circle
 *  and keeps the vertex count trivial. */
const BONUS_CIRCLE_SEGMENTS = 32;

export function createBonusSquaresManager(
  scene: THREE.Scene,
): BonusSquaresManager {
  const root = new THREE.Group();
  root.name = "bonusSquares";
  scene.add(root);

  // One disc geometry shared across all bonus tiles. Radius 1; each
  // mesh is scaled by TILE_SIZE/2 so it fills a single tile.
  const geometry = new THREE.CircleGeometry(1, BONUS_CIRCLE_SEGMENTS);
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.MeshBasicMaterial({
    color: rgbTupleToHex(BONUS_CIRCLE_COLOR),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: false,
  });

  const meshes: THREE.Mesh[] = [];
  let activeCount = 0;
  let lastSignature: string | undefined;

  function reconcile(
    tiles: readonly { row: number; col: number }[] | undefined,
  ): void {
    const signature = computeSignature(tiles);
    if (signature === lastSignature) return;
    lastSignature = signature;
    activeCount = tiles?.length ?? 0;
    for (let i = 0; i < activeCount; i++) {
      const bonus = tiles![i]!;
      let mesh = meshes[i];
      if (!mesh) {
        mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        mesh.renderOrder = RENDER_ORDER.EFFECT;
        mesh.scale.setScalar(TILE_SIZE / 2);
        meshes.push(mesh);
        root.add(mesh);
      }
      mesh.position.set(
        bonus.col * TILE_SIZE + TILE_SIZE / 2,
        ELEVATION_STACK.BONUS_DISCS,
        bonus.row * TILE_SIZE + TILE_SIZE / 2,
      );
      mesh.visible = true;
    }
    for (let i = activeCount; i < meshes.length; i++) {
      meshes[i]!.visible = false;
    }
  }

  function update(overlay: RenderOverlay | undefined, now: number): void {
    const inBattle = !!overlay?.battle?.inBattle;
    const tiles = inBattle ? undefined : overlay?.entities?.bonusSquares;
    reconcile(tiles);
    if (activeCount === 0) {
      material.opacity = 0;
      return;
    }
    // Same 0.70–1.00 sin pulse as the 2D path.
    material.opacity = Math.sin(now / BONUS_FLASH_MS) * 0.15 + 0.85;
  }

  function dispose(): void {
    for (const mesh of meshes) root.remove(mesh);
    meshes.length = 0;
    geometry.dispose();
    material.dispose();
    scene.remove(root);
  }

  return { update, dispose };
}

function computeSignature(
  tiles: readonly { row: number; col: number }[] | undefined,
): string {
  if (!tiles || tiles.length === 0) return "";
  const parts: string[] = [];
  for (const bonus of tiles) parts.push(`${bonus.col}:${bonus.row}`);
  return parts.join("|");
}

function rgbTupleToHex(rgb: readonly [number, number, number]): number {
  return ((rgb[0] & 0xff) << 16) | ((rgb[1] & 0xff) << 8) | (rgb[2] & 0xff);
}
