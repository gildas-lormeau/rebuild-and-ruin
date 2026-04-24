/**
 * Host-only surface sampling for ballistic impact detection.
 *
 * Given the full game state, returns the top altitude (in world units)
 * at any (x, y) position, treating walls, towers, cannons, houses, and
 * grunts as solid obstacles. Used exclusively at fire time to pin the
 * cannonball's impact tile — sampling walks the trajectory forward and
 * finds the first point where the ball's altitude dips below the
 * surface top at that position.
 *
 * **Why host-only:** state reads here happen exactly once per shot (at
 * fire time), then the result is pinned onto the Cannonball and shipped
 * over the wire via `CannonFiredMessage`. The watcher never calls this
 * module — it replays the pinned trajectory deterministically. State
 * divergence between host and watcher therefore cannot leak into the
 * ball's flight path or impact point.
 *
 * Shooter-own-walls rule: the shooter's own walls and cannons are
 * TRANSPARENT during flight (the ball arcs over them) but OPAQUE at the
 * pinned aim tile — this preserves deliberate self-targeting (a player
 * aiming at their own cannon still destroys it).
 */

import {
  CANNON_TOP_Y,
  GRUNT_TOP_Y,
  HOUSE_TOP_Y,
  TOWER_TOP_Y,
  WALL_TOP_Y,
} from "../shared/core/elevation-constants.ts";
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "../shared/core/grid.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import {
  isAtTile,
  isCannonAlive,
  isCannonTile,
  packTile,
  pxToTile,
} from "../shared/core/spatial.ts";
import { altitudeAt, horizontalAt } from "../shared/core/trajectory.ts";
import type { GameState } from "../shared/core/types.ts";

/** Options threaded through surface sampling. */
interface SurfaceOpts {
  /** Id of the player firing the shot. Their walls / cannons are
   *  transparent during flight (treated as altitude 0) except at the
   *  pinned aim tile, where they remain opaque. */
  readonly shooterId: ValidPlayerSlot;
  /** The aim tile — where shooter-owned walls / cannons stay opaque.
   *  Undefined during trajectory sweep (every in-flight sample treats
   *  shooter-owned geometry as transparent); set by the impact finder
   *  only when testing the final target tile. */
  readonly aimTile?: { readonly row: number; readonly col: number };
}

/** Number of sample points along a trajectory when searching for impact.
 *  Dense enough to catch wall-sized obstacles (~16 world units wide)
 *  even on long flights (~700 world units / 16 ≈ 44 samples worst case;
 *  we round up to 64 for safety margin at mortar speeds). */
const IMPACT_SAMPLES = 64;

/** Walk the parametric trajectory sample-by-sample and return the first
 *  time the ball's altitude meets or crosses the surface top below it.
 *
 *  Returns:
 *    - `{ impactTime, impactX, impactY }` — first obstacle interception
 *      (may be a wall / tower / cannon / house / grunt the ball flies
 *      into while arcing toward its aim point)
 *    - `null` — the trajectory reaches the aim point without collision;
 *      caller should use the nominal aim impact.
 *
 *  Samples include neither t=0 (muzzle clearance is assumed) nor t>=
 *  flightTime (the aim point itself is evaluated separately by the
 *  caller to allow shooter-own-at-aim opacity). Caller is expected to
 *  handle those endpoints.
 */
export function findTrajectoryImpact(
  state: GameState,
  launchX: number,
  launchY: number,
  launchAlt: number,
  aimX: number,
  aimY: number,
  vy0: number,
  gravity: number,
  flightTime: number,
  shooterId: ValidPlayerSlot,
): { impactTime: number; impactX: number; impactY: number } | null {
  if (flightTime <= 0) return null;
  // Walk from just past muzzle to just before the aim point.
  for (let sample = 1; sample < IMPACT_SAMPLES; sample++) {
    const elapsed = (sample / IMPACT_SAMPLES) * flightTime;
    const { x, y } = horizontalAt(
      launchX,
      launchY,
      aimX,
      aimY,
      flightTime,
      elapsed,
    );
    const altitude = altitudeAt(launchAlt, vy0, gravity, elapsed);
    const surface = surfaceAltitudeAt(state, x, y, { shooterId });
    if (surface > 0 && altitude <= surface) {
      return { impactTime: elapsed, impactX: x, impactY: y };
    }
  }
  return null;
}

/** Sample the surface under the aim tile. Returns the target altitude
 *  the trajectory solver should land on — tower top if aimed at a
 *  tower, ground (0) for an open tile, etc. Respects the shooter-at-aim
 *  rule so players can still deliberately target their own walls or
 *  cannons. Purely a convenience wrapper around `surfaceAltitudeAt`
 *  with `aimTile` set. */
export function aimSurfaceAltitude(
  state: GameState,
  aimX: number,
  aimY: number,
  shooterId: ValidPlayerSlot,
): number {
  const row = pxToTile(aimY);
  const col = pxToTile(aimX);
  return surfaceAltitudeAt(state, aimX, aimY, {
    shooterId,
    aimTile: { row, col },
  });
}

/** Top-Y of the tallest occupant at `(x, y)`. Mirrors the renderer's
 *  `targetTopAt` but runs against the authoritative GameState — no
 *  overlay, no castle view snapshot. Returns 0 when nothing is there
 *  (flat ground plane).
 *
 *  Shooter-own-walls rule: if the sample tile is owned by `opts.shooterId`
 *  and differs from the aim tile, shooter's own walls / cannons return
 *  altitude 0 so the ball arcs over them. At the aim tile they remain
 *  opaque. */
function surfaceAltitudeAt(
  state: GameState,
  x: number,
  y: number,
  opts: SurfaceOpts,
): number {
  const col = pxToTile(x);
  const row = pxToTile(y);
  if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return 0;
  const atAim =
    opts.aimTile !== undefined &&
    opts.aimTile.row === row &&
    opts.aimTile.col === col;

  // Walls
  const key = packTile(row, col);
  for (const player of state.players) {
    if (!player.walls.has(key)) continue;
    if (player.id === opts.shooterId && !atAim) continue;
    return WALL_TOP_Y;
  }

  // Towers (2×2)
  for (let index = 0; index < state.map.towers.length; index++) {
    const tower = state.map.towers[index]!;
    if (state.towerAlive[index] === false) continue;
    if (
      col >= tower.col &&
      col < tower.col + 2 &&
      row >= tower.row &&
      row < tower.row + 2
    ) {
      return TOWER_TOP_Y;
    }
  }

  // Cannons (2×2 or 3×3)
  for (const player of state.players) {
    for (const cannon of player.cannons) {
      if (!isCannonAlive(cannon)) continue;
      if (!isCannonTile(cannon, row, col)) continue;
      if (player.id === opts.shooterId && !atAim) continue;
      return CANNON_TOP_Y;
    }
  }

  // Houses
  for (const house of state.map.houses) {
    if (!house.alive) continue;
    if (isAtTile(house, row, col)) return HOUSE_TOP_Y;
  }

  // Grunts
  for (const grunt of state.grunts) {
    if (isAtTile(grunt, row, col)) return GRUNT_TOP_Y;
  }

  return 0;
}

void TILE_SIZE;
