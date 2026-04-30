/**
 * Shared math + geometry helpers for the 3D renderer's effects cluster.
 * Factored out of bonus-squares, impacts, fog, thawing, water-waves — the
 * sinusoidal pulse, per-tile seed hash, tile-set fingerprint, and flat
 * XZ-oriented disc geometry were all repeated verbatim across those
 * modules.
 */

import * as THREE from "three";

const TILE_SEED_ROW_MULT = 41;
const TILE_SEED_COL_MULT = 17;

/** Stable per-tile seed used by effects that want deterministic
 *  randomness across (row, col) — e.g. per-tile phase offsets, per-tile
 *  sprite picks. Combines row and col via two co-prime multipliers. */
export function tileSeed(row: number, col: number): number {
  return row * TILE_SEED_ROW_MULT + col * TILE_SEED_COL_MULT;
}

/** Fingerprint a set of tile-positioned entries as `"c:r|c:r|..."` so
 *  a manager can early-out when positions haven't changed. Used by
 *  bonus-squares + impacts. */
export function tileSignature(
  tiles: readonly { col: number; row: number }[] | undefined,
): string {
  if (!tiles || tiles.length === 0) return "";
  const parts: string[] = [];
  for (const tile of tiles) parts.push(`${tile.col}:${tile.row}`);
  return parts.join("|");
}

/** Create a flat disc (CircleGeometry rotated into XZ) for
 *  ground-plane effects. Returned geometry is shared; call sites are
 *  expected to dispose it in their own dispose path. */
export function createFlatDisc(): THREE.CircleGeometry {
  const geometry = new THREE.CircleGeometry(1, 24);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}
