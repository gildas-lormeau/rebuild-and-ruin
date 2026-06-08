/**
 * Shared aim-occlusion geometry: the camera-near ray-walk that both the
 * renderer's crosshair pick (`render/3d/elevation.ts` `pickHitWorld`) and the
 * sim-side AI aim (`game/aim-occlusion.ts`) delegate to. Under the battle tilt,
 * elevated geometry is drawn above its footprint and visually covers the tiles
 * behind it — you can't aim at a tile you can't see. Callers differ only in the
 * pitch source + height table they pass in (live camera vs fixed sim pitch).
 */

import { GRID_ROWS, TILE_SIZE } from "./grid.ts";

/** Walk the sight-ray from the camera-near side back toward `groundY` in
 *  integer-tile steps within `col` (pitch is X-only, no lateral shift) and
 *  return the snapped world-Y where the ray first crosses an elevated top
 *  surface, or `null` if nothing in range occludes the target.
 *
 *  `heightAt(row, col)` is the tallest occupant's top-Y at that tile (0 for
 *  open ground); `lookback` bounds how many tiles toward the camera to probe.
 *  The returned `groundY + h·tan(pitch)` keeps sub-tile precision inside the
 *  occluding tile so callers' `pxToTile` resolves to the correct row. */
export function rayWalkOccluder(
  groundY: number,
  col: number,
  pitch: number,
  heightAt: (row: number, col: number) => number,
  lookback: number,
): number | null {
  const tanP = Math.tan(pitch);
  if (tanP <= 0) return null;
  const groundRow = Math.floor(groundY / TILE_SIZE);
  const rMax = Math.min(GRID_ROWS - 1, groundRow + lookback);
  for (let row = rMax; row > groundRow; row--) {
    if (row < 0) continue;
    const height = heightAt(row, col);
    if (height <= 0) continue;
    // Ray enters tile `row`'s volume from the back and exits via the top face
    // iff the ray's Y at the tile's front edge is ≤ height — equivalently
    // `row * TILE_SIZE ≤ groundY + height · tan(pitch)`.
    if (row * TILE_SIZE <= groundY + height * tanP) {
      return groundY + height * tanP;
    }
  }
  return null;
}
