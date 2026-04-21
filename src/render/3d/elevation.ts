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

import type { GameMap } from "../../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "../../shared/core/grid.ts";
import { isCannonAlive, isSuperCannon } from "../../shared/core/spatial.ts";
import type {
  CastleData,
  RenderOverlay,
} from "../../shared/ui/overlay-types.ts";

/** Wall body top in world units. wall-scene.ts authors walls with body
 *  height `H = 3.22` sprite units; `entities/walls.ts` scales each cell
 *  by `TILE_SIZE / 2 = 8`, so the body's top sits at 3.22 × 8 ≈ 25.76
 *  world units. We aim at the BODY top (the walk surface), not the
 *  decorative merlon tops, because balls & crosshairs should land on
 *  the battlement walk. */
const WALL_TOP_Y = 3.22 * (TILE_SIZE / 2);
/** Approximate top-Y of the various 3D entities, in world units. Used
 *  only by the crosshair cursor so its glow sits ON the target rather
 *  than on the flat ground plane underneath. Tuned by eye — exact
 *  sprite apex isn't critical. */
const TOWER_TOP_Y = 56;
const CANNON_TOP_Y = 14;
const HOUSE_TOP_Y = 16;
const GRUNT_TOP_Y = 10;
/** Global lift applied on top of the aim-elevation so the crosshair
 *  doesn't get buried under the terrain mesh's opaque interior /
 *  bonus / frozen tiles (which sit at Y=0.01). 2 world units = 2
 *  game-1× pixels. */
const CROSSHAIR_MARGIN_Y = 2;

/** Top-Y of the tallest thing at `(x, y)` — for the crosshair cursor
 *  to sit on top of its target (wall, tower, cannon, house, grunt).
 *  Unlike `elevationAt`, this considers entity geometry (not just
 *  walls) and falls back to the flat ground plane when nothing is
 *  there. Dead towers resolve to ground (their debris piles are
 *  flat-ish). */
export function aimElevationAt(
  x: number,
  y: number,
  overlay: RenderOverlay | undefined,
  map: GameMap | undefined,
): number {
  return aimTopAt(x, y, overlay, map) + CROSSHAIR_MARGIN_Y;
}

function aimTopAt(
  x: number,
  y: number,
  overlay: RenderOverlay | undefined,
  map: GameMap | undefined,
): number {
  const col = Math.floor(x / TILE_SIZE);
  const row = Math.floor(y / TILE_SIZE);
  if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return 0;

  const wallY = elevationAt(x, y, overlay?.castles);
  if (wallY > 0) return wallY;

  if (map?.towers) {
    const aliveMask = overlay?.entities?.towerAlive;
    for (let index = 0; index < map.towers.length; index++) {
      const tower = map.towers[index]!;
      if (aliveMask && aliveMask[index] === false) continue;
      if (
        col >= tower.col &&
        col < tower.col + 2 &&
        row >= tower.row &&
        row < tower.row + 2
      )
        return TOWER_TOP_Y;
    }
  }

  if (overlay?.castles) {
    for (const castle of overlay.castles) {
      for (const cannon of castle.cannons) {
        if (!isCannonAlive(cannon)) continue;
        const size = isSuperCannon(cannon) ? 3 : 2;
        if (
          col >= cannon.col &&
          col < cannon.col + size &&
          row >= cannon.row &&
          row < cannon.row + size
        )
          return CANNON_TOP_Y;
      }
    }
  }

  if (map?.houses) {
    for (const house of map.houses) {
      if (!house.alive) continue;
      if (house.col === col && house.row === row) return HOUSE_TOP_Y;
    }
  }

  const grunts = overlay?.entities?.grunts;
  if (grunts) {
    for (const grunt of grunts) {
      if (grunt.col === col && grunt.row === row) return GRUNT_TOP_Y;
    }
  }

  return 0;
}

/** Elevation of the solid geometry at the given world-pixel position.
 *  Returns `WALL_TOP_Y` when `(x, y)` falls on a wall tile of any
 *  castle in `castles`, otherwise 0 (flat ground). Out-of-bounds
 *  coordinates return 0. Used by cannonballs for their landing floor. */
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
