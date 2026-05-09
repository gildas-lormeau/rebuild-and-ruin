/**
 * Shared boilerplate for procedural `CanvasTexture` builders (stone
 * walls, wall-top allure, roof tiles). The helper bails on SSR, creates
 * a square canvas, hands the caller's `paint` callback an LCG-backed
 * seeded RNG for deterministic output, then wraps the result as a
 * repeating `THREE.CanvasTexture`.
 */

import type * as THREE from "three";

interface ProceduralTextureContext {
  readonly ctx: CanvasRenderingContext2D;
  readonly size: number;
  readonly rand: () => number;
}

/** Build a repeating `CanvasTexture` of `size`×`size` by running `paint`
 *  against a seeded canvas. Returns `undefined` on SSR or if the 2D
 *  context can't be acquired. */
export function createTiledCanvasTexture(
  three: typeof THREE,
  size: number,
  paint: (context: ProceduralTextureContext) => void,
): THREE.CanvasTexture | undefined {
  if (typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;

  let seed = 1;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  paint({ ctx, size, rand });

  const tex = new three.CanvasTexture(canvas);
  tex.wrapS = three.RepeatWrapping;
  tex.wrapT = three.RepeatWrapping;
  return tex;
}
