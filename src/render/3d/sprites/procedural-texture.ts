/**
 * Shared boilerplate for procedural `CanvasTexture` builders used by
 * sprite scenes (stone walls, wall-top allure, roof tiles). Each caller
 * paints a different pattern, but every one of them:
 *
 *   1. Returns `undefined` on SSR (no `document`).
 *   2. Creates a square canvas of the requested size.
 *   3. Runs an LCG to keep the output deterministic across browsers.
 *   4. Wraps the canvas as a repeating `THREE.CanvasTexture`.
 *
 * The helper takes a `paint` callback that receives the 2D context, the
 * canvas size, and the seeded random generator. Callers hand back no
 * value — the texture is built from the painted canvas.
 */

import type * as THREE from "three";

export interface ProceduralTextureContext {
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
