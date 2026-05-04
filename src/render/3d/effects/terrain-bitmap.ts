/**
 * 3D terrain bitmap base layer — uploads the 2D renderer's baked terrain
 * ImageData (grass + water + SDF bank + frozen ice + grass-blade noise +
 * battle wave texture) as a CanvasTexture on a flat plane at Y=0 so 3D
 * terrain visuals stay pixel-identical with the 2D bake.
 *
 * The 2D path renders terrain per-pixel via an SDF (smooth water/grass
 * transitions with a red-brown bank band) into an `ImageData` cache keyed
 * by `(map, inBattle)`. This module fronts that cache for the 3D scene:
 * fingerprint on `(mapVersion, inBattle)`, fetch the cached ImageData,
 * `putImageData` it onto a reused offscreen canvas, flag the texture
 * dirty. The terrain mesh sits at Y=ELEVATION_STACK.TERRAIN_MESH (0.01)
 * — its opaque pixels (castle interiors etc.) cover this base, while
 * transparent pixels at raw grass/water tiles let the bitmap show through.
 */

import * as THREE from "three";
import type { GameMap } from "../../../shared/core/geometry-types.ts";
import { MAP_PX_H, MAP_PX_W } from "../../../shared/core/grid.ts";
import { ELEVATION_STACK } from "../elevation.ts";
import type { FrameCtx } from "../frame-ctx.ts";

export interface TerrainBitmapManager {
  /** Rebake the terrain texture when the fingerprint
   *  `(map.mapVersion, overlay.battle.inBattle)` has changed since
   *  the last call. No-op on steady-state frames. */
  update(ctx: FrameCtx): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

export type GetTerrainBitmap = (
  map: GameMap,
  inBattle: boolean,
  frozenTiles?: ReadonlySet<number>,
) => ImageData;

export function createTerrainBitmapManager(
  scene: THREE.Scene,
  getTerrainBitmap: GetTerrainBitmap,
): TerrainBitmapManager {
  // Map-sized offscreen canvas + sRGB-tagged CanvasTexture + flat plane
  // mesh at the ground plane. NearestFilter preserves the pixel-art look;
  // sRGB tag makes three.js convert canvas bytes correctly through the
  // PBR pipeline. `rotateX(-π/2)` + default `flipY=true` aligns canvas
  // row 0 with world Z=0 (map north).
  const canvas = document.createElement("canvas");
  canvas.width = MAP_PX_W;
  canvas.height = MAP_PX_H;
  const canvasCtx = canvas.getContext("2d", { willReadFrequently: false })!;
  canvasCtx.imageSmoothingEnabled = false;

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;

  const geometry = new THREE.PlaneGeometry(MAP_PX_W, MAP_PX_H);
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: false,
    depthWrite: true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(MAP_PX_W / 2, ELEVATION_STACK.TERRAIN_BITMAP, MAP_PX_H / 2);
  mesh.visible = false;
  scene.add(mesh);

  let bakedVersion: number | undefined;
  let bakedInBattle: boolean | undefined;

  function update(ctx: FrameCtx): void {
    const { overlay, map } = ctx;
    if (!map) {
      mesh.visible = false;
      return;
    }
    const inBattle = !!overlay?.battle?.inBattle;
    // mapVersion bumps on freeze/thaw (see frozen-river.ts), so it alone
    // covers cache invalidation — no separate frozenTiles fingerprint needed.
    if (bakedVersion === map.mapVersion && bakedInBattle === inBattle) return;
    bakedVersion = map.mapVersion;
    bakedInBattle = inBattle;

    const bitmap = getTerrainBitmap(
      map,
      inBattle,
      overlay?.entities?.frozenTiles,
    );
    canvasCtx.putImageData(bitmap, 0, 0);
    texture.needsUpdate = true;
    mesh.visible = true;
  }

  function dispose(): void {
    scene.remove(mesh);
    geometry.dispose();
    material.dispose();
    texture.dispose();
  }

  return { update, dispose };
}
