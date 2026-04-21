/**
 * Shared setup for the full-map 2D canvas overlays the 3D renderer
 * composites over the terrain (currently: the terrain-bitmap upload and
 * the water-waves highlight pass). Both need the same canvas dimensions,
 * the same `NearestFilter` + sRGB-tagged `CanvasTexture`, and the same
 * `MeshBasicMaterial` shape; the only differences are the Y lift and
 * whether the mesh starts visible.
 */

import * as THREE from "three";
import { MAP_PX_H, MAP_PX_W } from "../../../shared/core/grid.ts";

interface LayerCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  readonly mesh: THREE.Mesh;
}

interface MapLayerOpts {
  readonly yLift: number;
  /** `true` for overlays that composite on top (water-waves);
   *  `false` for the opaque base bitmap (terrain-bitmap). */
  readonly transparent: boolean;
}

/** Build a map-sized flat canvas + CanvasTexture + plane mesh centered
 *  on the map ground plane at `opts.yLift`. Texture is sRGB-tagged so
 *  sRGB canvas bytes decode correctly through the PBR pipeline;
 *  otherwise colors wash out. `rotateX(-π/2)` + default `flipY=true`
 *  means canvas row 0 lines up with world Z=0 (map north). */
export function createMapLayerCanvas(
  scene: THREE.Scene,
  opts: MapLayerOpts,
): LayerCanvas {
  const canvas = document.createElement("canvas");
  canvas.width = MAP_PX_W;
  canvas.height = MAP_PX_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: false })!;
  ctx.imageSmoothingEnabled = false;

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;

  const geometry = new THREE.PlaneGeometry(MAP_PX_W, MAP_PX_H);
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: opts.transparent,
    depthWrite: !opts.transparent,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(MAP_PX_W / 2, opts.yLift, MAP_PX_H / 2);
  scene.add(mesh);

  return { canvas, ctx, texture, mesh };
}

/** Tear down a `LayerCanvas` — removes the mesh from the scene and
 *  disposes the geometry, material, and texture. */
export function disposeMapLayerCanvas(
  scene: THREE.Scene,
  layer: LayerCanvas,
): void {
  scene.remove(layer.mesh);
  layer.mesh.geometry.dispose();
  (layer.mesh.material as THREE.Material).dispose();
  layer.texture.dispose();
}
