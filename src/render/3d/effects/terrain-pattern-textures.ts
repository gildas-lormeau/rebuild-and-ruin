/**
 * 3D terrain pattern textures — static 16×16 R32F DataTextures holding
 * signed sRGB-byte brightness offsets the terrain shader applies to grass
 * (default + battle) and cobblestone (owned interiors in battle) tiles.
 *
 * Replaces the per-pixel pattern baking that used to live in `render-map.ts`'s
 * `GRASS_TEX` lookup table and the 2D `drawCobblestone()` sprite (which
 * stamped mortar / highlights / shadows / dirt-specks on top of the
 * cobblestone base). The shader samples each texture once per fragment and
 * shifts the linear color back to sRGB to add the offset, matching the
 * byte-exact look of the originals.
 *
 * Cobblestone faithfulness: 4 of the 5 original layers (mortar, highlights,
 * shadows, vertical mortar fragments) alpha-blend against the cobblestone
 * base in player-independent ways, so each reduces to a constant per-pixel
 * sRGB-byte offset. The 3 dirt/moss specks pull from `tintColor × 0.3` and
 * are approximated with a single −10 darkening (≤2 byte error on 3 of 256
 * pixels — imperceptible).
 *
 * One module-level texture per pattern, baked at construction.
 * NearestFilter so the 16-pixel pattern stays pixel-art crisp when sampled
 * per-tile.
 */

import * as THREE from "three";
import { TILE_SIZE } from "../../../shared/core/grid.ts";

/** Local pixel offsets (lx, ly) that get a -12 sRGB-byte darkening in
 *  battle. Mirrors `render-map.ts`'s historical `BLADE_DARK`. */
const BLADE_DARK: readonly (readonly [number, number])[] = [
  [2, 1],
  [7, 3],
  [12, 0],
  [4, 6],
  [10, 7],
  [1, 10],
  [8, 11],
  [14, 9],
  [5, 13],
  [11, 14],
  [2, 2],
  [7, 4],
  [12, 1],
  [4, 7],
  [10, 8],
  [1, 11],
  [8, 12],
  [14, 10],
  [5, 14],
  [11, 15],
];
/** Local pixel offsets (lx, ly) that get a +10 sRGB-byte brightening. */
const BLADE_LIGHT: readonly (readonly [number, number])[] = [
  [3, 4],
  [9, 2],
  [13, 6],
  [6, 9],
  [0, 13],
  [11, 12],
];
const BLADE_DARK_OFFSET_SRGB = -12 / 255;
const BLADE_LIGHT_OFFSET_SRGB = 10 / 255;
/** Cobblestone mortar rectangles — 2 full-row horizontal joints (y=4, y=10)
 *  plus 7 staggered vertical mortar fragments. Mirrors the rect calls in
 *  the original 2D `drawCobblestone()`. Stored as `[x, y, w, h]`. */
const COBBLESTONE_MORTAR_RECTS: readonly (readonly [
  number,
  number,
  number,
  number,
])[] = [
  [0, 4, 16, 1],
  [0, 10, 16, 1],
  [5, 0, 1, 4],
  [11, 0, 1, 4],
  [3, 5, 1, 5],
  [8, 5, 1, 5],
  [14, 5, 1, 5],
  [6, 11, 1, 5],
  [12, 11, 1, 5],
];
/** Stone highlight rectangles — 6 small lighter spots. */
const COBBLESTONE_HIGHLIGHT_RECTS: readonly (readonly [
  number,
  number,
  number,
  number,
])[] = [
  [1, 1, 3, 1],
  [7, 1, 3, 1],
  [4, 6, 2, 1],
  [10, 6, 3, 1],
  [1, 12, 4, 1],
  [8, 12, 3, 1],
];
/** Stone shadow rectangles — 6 small darker spots. */
const COBBLESTONE_SHADOW_RECTS: readonly (readonly [
  number,
  number,
  number,
  number,
])[] = [
  [2, 3, 2, 1],
  [8, 3, 2, 1],
  [5, 9, 2, 1],
  [11, 9, 2, 1],
  [3, 15, 2, 1],
  [9, 15, 2, 1],
];
/** Dirt/moss speck pixels — 3 single-pixel hits. */
const COBBLESTONE_SPECK_PIXELS: readonly (readonly [number, number])[] = [
  [2, 7],
  [10, 2],
  [7, 13],
];
// Mortar: rgba(base-12, 0.25) over base → final = base - 3.
const COBBLESTONE_MORTAR_OFFSET_SRGB = -3 / 255;
// Highlights: rgba(base+10, 0.5) over base → final = base + 5.
const COBBLESTONE_HIGHLIGHT_OFFSET_SRGB = 5 / 255;
// Shadows: rgba(base-10, 0.4) over base → final = base - 4.
const COBBLESTONE_SHADOW_OFFSET_SRGB = -4 / 255;
// Specks: rgba(tint × 0.3, 0.15) — flat-darken approximation.
const COBBLESTONE_SPECK_OFFSET_SRGB = -10 / 255;

export function createGrassPatternTexture(): THREE.DataTexture {
  const data = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (const [lx, ly] of BLADE_DARK)
    data[ly * TILE_SIZE + lx] = BLADE_DARK_OFFSET_SRGB;
  for (const [lx, ly] of BLADE_LIGHT)
    data[ly * TILE_SIZE + lx] = BLADE_LIGHT_OFFSET_SRGB;
  return makePatternTexture(data);
}

export function createCobblestonePatternTexture(): THREE.DataTexture {
  const data = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (const [x, y, w, h] of COBBLESTONE_MORTAR_RECTS)
    fillOffsetRect(data, x, y, w, h, COBBLESTONE_MORTAR_OFFSET_SRGB);
  for (const [x, y, w, h] of COBBLESTONE_HIGHLIGHT_RECTS)
    fillOffsetRect(data, x, y, w, h, COBBLESTONE_HIGHLIGHT_OFFSET_SRGB);
  for (const [x, y, w, h] of COBBLESTONE_SHADOW_RECTS)
    fillOffsetRect(data, x, y, w, h, COBBLESTONE_SHADOW_OFFSET_SRGB);
  for (const [x, y] of COBBLESTONE_SPECK_PIXELS)
    data[y * TILE_SIZE + x] = COBBLESTONE_SPECK_OFFSET_SRGB;
  return makePatternTexture(data);
}

function fillOffsetRect(
  data: Float32Array,
  x: number,
  y: number,
  w: number,
  h: number,
  offset: number,
): void {
  for (let dy = 0; dy < h; dy++) {
    const rowStart = (y + dy) * TILE_SIZE + x;
    data.fill(offset, rowStart, rowStart + w);
  }
}

function makePatternTexture(
  data: Float32Array<ArrayBuffer>,
): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    data,
    TILE_SIZE,
    TILE_SIZE,
    THREE.RedFormat,
    THREE.FloatType,
  );
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
