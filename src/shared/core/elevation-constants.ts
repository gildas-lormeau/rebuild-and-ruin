/**
 * Surface top-Y for every target kind (in world units). Shared between:
 *   - the 3D renderer (renders ball altitude on top of target geometry)
 *   - the sim's surface-elevation module (host-only impact sampling)
 *
 * The constants match the values derived in `render/3d/elevation.ts` for
 * the authored scene variants. They live here (shared/core) so sim code
 * can sample surface heights deterministically without depending on
 * three.js or the render layer.
 *
 * World units: 1 world unit = 1 game-1× pixel (scene.ts convention).
 */

import { TILE_SIZE } from "./grid.ts";

/** Top of the wall body (walk surface of a battlement). */
export const WALL_TOP_Y = 3.22 * (TILE_SIZE / 2);
/** Top of a regular cannon body (authored tier_1 variant). */
export const CANNON_TOP_Y = 14;
/** Top of a house (authored house variant). */
export const HOUSE_TOP_Y = 16;
/** Top of a grunt (authored grunt_n variant). */
export const GRUNT_TOP_Y = 10;
/** Tower silhouette height the trajectory solver tries to arc over —
 *  stone body + parapet, excluding the flagpole and pennant (those are
 *  too thin to convincingly stop a ball). Towers remain TRANSPARENT to
 *  cannonball *impact* (only grunts kill towers, see surface-elevation.ts);
 *  this constant is used purely as a "preferred clearance" hint by the
 *  ballistic clearance solver, which lifts the arc when feasible so the
 *  ball doesn't visually pass through tower mass. When clearance isn't
 *  feasible (slowdown floor exceeded), the ball still phases through
 *  per the impact-transparency rule. Diverges from the renderer's
 *  full-bounds tower height (~56 wu) which includes the flagpole. */
export const TOWER_TOP_Y = 40;
/** Vertical clearance the trajectory solver enforces above any obstacle
 *  along the path (world units). The lifted arc passes at least this
 *  much above the tallest in-path obstacle so a ball reading as
 *  "barely clearing" still visually clears. */
export const BALLISTIC_CLEARANCE_MARGIN = 4;
/** Maximum factor the trajectory solver may slow the ball below its
 *  natural horizontal speed in order to lift the arc over an obstacle.
 *  If the geometry would require slowing further than this, the solver
 *  gives up and the ball impacts the obstacle on its natural arc. */
export const BALLISTIC_MAX_SLOWDOWN = 4;
/** Muzzle exit altitude — the Y coordinate where a ball leaves the
 *  barrel tip. Slightly below CANNON_TOP_Y so the ball emerges from
 *  the bore rather than the decorative muzzle swell. */
export const MUZZLE_Y = 12;
/** Gravity in world-units per second². Sets the curvature of the
 *  ballistic arc for a given flight time. Tuned so a typical zone-to-
 *  zone shot (~400 px at speed 150 px/s → flightTime ~2.7s) peaks
 *  around 164 world units — tall enough to read as a real lob, low
 *  enough to stay inside the camera frustum. */
export const GRAVITY = 180;
