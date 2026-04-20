/**
 * Ground elevation helpers for the 3D renderer.
 *
 * Cannonballs and crosshair cursors treat the world as a flat Y=0 ground
 * plane by default, but the 3D scene has real geometric height for walls.
 * Players aim at the tops of walls (and expect balls to land there), so
 * sprites whose tile happens to sit on a wall need to be lifted to that
 * wall's top — otherwise they visually pass through the wall and hit the
 * ground below.
 *
 * This module keeps the elevation constants + per-(x,y) lookup in one
 * place so both `crosshairs` and `cannonballs` read the same numbers.
 * Only walls are modelled for now — towers/cannons/houses sit on top of
 * their own geometry and aren't common aim targets for projectiles.
 */

import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "../../shared/core/grid.ts";
import type { CastleData } from "../../shared/ui/overlay-types.ts";

/** Wall body top in world units. wall-scene.ts authors walls with body
 *  height `H = 3.22` sprite units; `entities/walls.ts` scales each cell
 *  by `TILE_SIZE / 2 = 8`, so the body's top sits at 3.22 × 8 ≈ 25.76
 *  world units. We aim at the BODY top (the walk surface), not the
 *  decorative merlon tops, because balls & crosshairs should land on
 *  the battlement walk. */
const WALL_TOP_Y = 3.22 * (TILE_SIZE / 2);

/** Elevation of the solid geometry at the given world-pixel position.
 *  Returns `WALL_TOP_Y` when `(x, y)` falls on a wall tile of any
 *  castle in `castles`, otherwise 0 (flat ground). Out-of-bounds
 *  coordinates return 0. */
export function elevationAt(
  x: number,
  y: number,
  castles: readonly CastleData[] | undefined,
): number {
  if (!castles || castles.length === 0) return 0;
  const col = Math.floor(x / TILE_SIZE);
  const row = Math.floor(y / TILE_SIZE);
  if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return 0;
  const key = row * GRID_COLS + col;
  for (const castle of castles) {
    if (castle.walls.has(key)) return WALL_TOP_Y;
  }
  return 0;
}
