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
 *
 *  `targetTop` is the elevation of the aim target itself (0 for a ground-plane
 *  pick). Occlusion is tested against the target's *top*, not its footprint
 *  ground: a front object only hides the target when it rises ABOVE the
 *  sight-line to that top, i.e. when its excess height `(h − targetTop)` lifts
 *  the ray past the tile's front edge. With `targetTop = 0` this reduces to
 *  the old ground-plane test (the renderer's screen-tap pick); passing the
 *  target's own height makes an equal-height neighbour (a wall behind a wall,
 *  a cannon behind a cannon) correctly NOT occlude — its top is level and
 *  stays visible.
 *
 *  The returned `groundY + (h − targetTop)·tan(pitch)` keeps sub-tile
 *  precision inside the occluding tile so callers' `pxToTile` resolves to the
 *  correct row. */
export function rayWalkOccluder(
  groundY: number,
  col: number,
  pitch: number,
  heightAt: (row: number, col: number) => number,
  lookback: number,
  targetTop = 0,
): number | null {
  const tanP = Math.tan(pitch);
  if (tanP <= 0) return null;
  const groundRow = Math.floor(groundY / TILE_SIZE);
  const rMax = Math.min(GRID_ROWS - 1, groundRow + lookback);
  for (let row = rMax; row > groundRow; row--) {
    if (row < 0) continue;
    // Height in excess of the target's own top — only this excess can hide
    // the target's top surface. A shorter-or-equal occupant (excess ≤ 0)
    // never occludes, however close.
    const excess = heightAt(row, col) - targetTop;
    if (excess <= 0) continue;
    // Ray enters tile `row`'s volume from the back and exits via the top face
    // iff the ray's Y at the tile's front edge is ≤ the excess lift —
    // equivalently `row * TILE_SIZE ≤ groundY + excess · tan(pitch)`.
    if (row * TILE_SIZE <= groundY + excess * tanP) {
      return groundY + excess * tanP;
    }
  }
  return null;
}
