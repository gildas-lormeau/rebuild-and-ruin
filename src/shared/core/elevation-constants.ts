/**
 * Top-Y constants for entities on the 3D map, in world units.
 *
 * Single source of truth shared by:
 *   - the simulation (cannonball trajectory + impact altitude)
 *   - the 3D renderer (crosshair / aim helper)
 *
 * The 3D renderer additionally derives top-Y values from the authored
 * sprite geometry via `boundsYOf` and falls back to these constants if
 * the sprite isn't available — keep the two aligned (the constants here
 * are the hand-tuned fallbacks in render/3d/elevation.ts).
 */

import { TILE_SIZE } from "./grid.ts";

/** Wall battlement walk-surface top. Walls are authored at body height
 *  H = 3.22 sprite units, scaled by TILE_SIZE / 2 in the wall manager. */
export const WALL_TOP_Y = 3.22 * (TILE_SIZE / 2);
/** Tower top — the parapet roofline. */
export const TOWER_TOP_Y = 56;
/** Cannon top — barrel/breech vertical extent for tier_1. tier_2 / tier_3
 *  differ by ~3 wu but are close enough that one constant covers all
 *  regular cannons for impact-altitude purposes. */
export const CANNON_TOP_Y = 14;
/** House roof top. */
export const HOUSE_TOP_Y = 16;
/** Grunt body top. */
export const GRUNT_TOP_Y = 10;
