/**
 * Host-only surface sampling for ballistic trajectory shaping.
 *
 * Given the full game state, returns the top altitude (in world units)
 * at any (x, y) position, treating walls, cannons, houses, and grunts
 * as solid obstacles. Used at fire time to:
 *
 *   1. Pin the cannonball's aim altitude (the surface top of the target
 *      tile) so the ball lands on the thing the player aimed at.
 *   2. Walk the trajectory and either lift the arc to clear obstacles
 *      OR — when lifting isn't feasible — pin an early impact at the
 *      first obstacle the natural arc intercepts.
 *
 * **Why host-only:** state reads here happen exactly once per shot (at
 * fire time), then the resulting trajectory is pinned onto the Cannonball
 * and shipped over the wire via `CannonFiredMessage`. The watcher never
 * calls this module — it replays the pinned trajectory deterministically.
 * State divergence between host and watcher therefore cannot leak into
 * the ball's flight path or impact point.
 *
 * **Tower rule:** towers are TRANSPARENT to cannonball *impact* (only
 * grunts kill towers). They are, however, OPAQUE to the *clearance solver*
 * — when the solver can lift the arc over a tower without exceeding the
 * slowdown floor, it will. This keeps the ball from visually phasing
 * through tower mass on shots where a higher arc is cheap. When the lift
 * would exceed `BALLISTIC_MAX_SLOWDOWN`, the solver gives up and the
 * ball flies its natural arc through the tower (impact still skipped).
 *
 * **Shooter-own rule:** the shooter's own walls and cannons are
 * TRANSPARENT during flight (the ball arcs over them) but OPAQUE at the
 * pinned aim tile — this preserves deliberate self-targeting (a player
 * aiming at their own cannon still destroys it).
 */

import {
  BALLISTIC_CLEARANCE_MARGIN,
  BALLISTIC_MAX_SLOWDOWN,
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
  isTowerTile,
  packTile,
  pxToTile,
} from "../shared/core/spatial.ts";
import {
  altitudeAt,
  horizontalAt,
  solveTrajectory,
} from "../shared/core/trajectory.ts";
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
  /** Whether towers should report their silhouette altitude. The
   *  clearance solver passes `true` so it will try to arc over them;
   *  the impact path passes `false` so towers stay transparent and
   *  cannonballs phase through. */
  readonly includeTowers: boolean;
}

/** Number of sample points along a trajectory when searching for impact.
 *  Dense enough to catch wall-sized obstacles (~16 world units wide)
 *  even on long flights (~700 world units / 16 ≈ 44 samples worst case;
 *  we round up to 64 for safety margin at mortar speeds). */
const IMPACT_SAMPLES = 64;

/** Sample the surface under the aim tile. Returns the target altitude
 *  the trajectory solver should land on — wall top if aimed at a wall,
 *  ground (0) for an open tile, etc. Towers are NOT included (they
 *  remain transparent to impact — see module header). Respects the
 *  shooter-at-aim rule so players can still deliberately target their
 *  own walls or cannons. */
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
    includeTowers: false,
  });
}

/** Resolve the full ballistic trajectory at fire time.
 *
 *  Algorithm:
 *    1. Solve the natural arc that lands at the aim point with the given
 *       baseline horizontal speed.
 *    2. Walk the path, computing for each in-path obstacle the minimum
 *       flight time `T` whose arc would clear it by `BALLISTIC_CLEARANCE_MARGIN`.
 *       Track the maximum across all obstacles. Towers are included
 *       here so the solver tries to arc over them.
 *    3. If the max required `T` is at most the natural `T`, the natural
 *       arc already clears everything — return it unchanged.
 *    4. If the max required `T` is within `BALLISTIC_MAX_SLOWDOWN`× the
 *       natural `T`, lift the arc to that flight time (slower ball,
 *       higher peak) and return the lifted trajectory.
 *    5. Otherwise the obstacle can't be cleared affordably — fall back
 *       to the natural arc and pin impact at the first obstacle the
 *       natural arc would intercept (towers excluded; they stay
 *       transparent).
 *
 *  Closed-form trajectory altitude identity (used for the lift solve):
 *      alt(f) = lerp(launchAlt, impactAlt, f) + 0.5·g·T²·f·(1−f)
 *  where f = t/T. Setting `alt(f) ≥ obstacle + margin` and solving for T²
 *  gives the per-obstacle clearance constraint.
 */
export function solveBallisticClearing(
  state: GameState,
  launchX: number,
  launchY: number,
  launchAlt: number,
  aimX: number,
  aimY: number,
  aimAlt: number,
  baselineSpeed: number,
  gravity: number,
  shooterId: ValidPlayerSlot,
): {
  flightTime: number;
  vy0: number;
  impactX: number;
  impactY: number;
  impactAlt: number;
} {
  const naturalSolve = solveTrajectory(
    launchX,
    launchY,
    launchAlt,
    aimX,
    aimY,
    aimAlt,
    baselineSpeed,
    gravity,
  );
  const tNatural = naturalSolve.flightTime;
  if (tNatural <= 0) {
    return {
      flightTime: 0,
      vy0: 0,
      impactX: aimX,
      impactY: aimY,
      impactAlt: aimAlt,
    };
  }

  const aimRow = pxToTile(aimY);
  const aimCol = pxToTile(aimX);
  const altDelta = aimAlt - launchAlt;
  let tRequiredSq = 0;
  let firstInterception:
    | {
        time: number;
        x: number;
        y: number;
        alt: number;
      }
    | undefined;

  for (let sample = 1; sample < IMPACT_SAMPLES; sample++) {
    const fraction = sample / IMPACT_SAMPLES;
    const elapsed = fraction * tNatural;
    const { x, y } = horizontalAt(
      launchX,
      launchY,
      aimX,
      aimY,
      tNatural,
      elapsed,
    );
    const sampleRow = pxToTile(y);
    const sampleCol = pxToTile(x);
    if (sampleRow === aimRow && sampleCol === aimCol) continue;

    const surfaceForLift = surfaceAltitudeAt(state, x, y, {
      shooterId,
      includeTowers: true,
    });
    if (surfaceForLift > 0) {
      const lerpAlt = launchAlt + altDelta * fraction;
      const need = surfaceForLift + BALLISTIC_CLEARANCE_MARGIN - lerpAlt;
      if (need > 0) {
        const denom = gravity * fraction * (1 - fraction);
        if (denom > 0) {
          const tSq = (2 * need) / denom;
          if (tSq > tRequiredSq) tRequiredSq = tSq;
        }
      }
    }

    if (firstInterception === undefined) {
      const surfaceForImpact = surfaceAltitudeAt(state, x, y, {
        shooterId,
        includeTowers: false,
      });
      if (surfaceForImpact > 0) {
        const altAtSample = altitudeAt(
          launchAlt,
          naturalSolve.vy0,
          gravity,
          elapsed,
        );
        if (altAtSample <= surfaceForImpact) {
          firstInterception = {
            time: elapsed,
            x,
            y,
            alt: altAtSample,
          };
        }
      }
    }
  }

  const tRequired = Math.sqrt(tRequiredSq);
  if (tRequired <= tNatural) {
    return {
      flightTime: tNatural,
      vy0: naturalSolve.vy0,
      impactX: aimX,
      impactY: aimY,
      impactAlt: aimAlt,
    };
  }

  const tCeiling = tNatural * BALLISTIC_MAX_SLOWDOWN;
  if (tRequired <= tCeiling) {
    const tChosen = tRequired;
    const liftedVy0 = altDelta / tChosen + 0.5 * gravity * tChosen;
    return {
      flightTime: tChosen,
      vy0: liftedVy0,
      impactX: aimX,
      impactY: aimY,
      impactAlt: aimAlt,
    };
  }

  if (firstInterception !== undefined) {
    return {
      flightTime: firstInterception.time,
      vy0: naturalSolve.vy0,
      impactX: firstInterception.x,
      impactY: firstInterception.y,
      impactAlt: firstInterception.alt,
    };
  }

  return {
    flightTime: tNatural,
    vy0: naturalSolve.vy0,
    impactX: aimX,
    impactY: aimY,
    impactAlt: aimAlt,
  };
}

/** Top-Y of the tallest occupant at `(x, y)`. Mirrors the renderer's
 *  `targetTopAt` but runs against the authoritative GameState — no
 *  overlay, no castle view snapshot. Returns 0 when nothing is there
 *  (flat ground plane).
 *
 *  Shooter-own-walls rule: if the sample tile is owned by `opts.shooterId`
 *  and differs from the aim tile, shooter's own walls / cannons return
 *  altitude 0 so the ball arcs over them. At the aim tile they remain
 *  opaque.
 *
 *  Tower rule: towers are reported only when `opts.includeTowers` is
 *  true. The clearance solver passes `true`; the impact path passes
 *  `false` so towers stay transparent to impact. */
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

  // Towers (silhouette-only — never an impact target; see module header).
  if (opts.includeTowers) {
    for (let towerIdx = 0; towerIdx < state.map.towers.length; towerIdx++) {
      if (state.towerAlive[towerIdx] === false) continue;
      const tower = state.map.towers[towerIdx]!;
      if (isTowerTile(tower, row, col)) return TOWER_TOP_Y;
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
