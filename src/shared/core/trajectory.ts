/**
 * Closed-form ballistic trajectory math for cannonballs.
 *
 * The simulation treats horizontal motion as linear (constant `speed` in
 * the xz plane) and vertical motion as parabolic under constant gravity.
 * At fire time `computeTrajectoryParams` solves for the initial vertical
 * velocity that makes the ball land on `targetAltitude` at `flightTime`;
 * each tick `altitudeAt` evaluates the parabola at the ball's current
 * progress.
 *
 * Closed-form (vs per-tick velocity integration) is the deterministic
 * choice: identical inputs produce identical outputs across host,
 * watcher, replay, and any sub-stepping the dev-speed mechanism does.
 * No accumulated FP error.
 */

import { GRAVITY } from "./game-constants.ts";

interface TrajectoryParams {
  /** Initial vertical velocity at t=0, in world units / sec. */
  readonly vy0: number;
  /** Total horizontal flight duration (= horizDist / speed), in seconds. */
  readonly flightTime: number;
}

/** Solve for the trajectory params that take a ball from
 *  (launchX, launchY, launchAltitude) to (targetX, targetY, targetAltitude)
 *  at horizontal speed `speed`. Returns flightTime + initial vertical
 *  velocity; gravity is the global GRAVITY constant. */
export function computeTrajectoryParams(
  launchX: number,
  launchY: number,
  launchAltitude: number,
  targetX: number,
  targetY: number,
  targetAltitude: number,
  speed: number,
): TrajectoryParams {
  const dx = targetX - launchX;
  const dy = targetY - launchY;
  const horizDist = Math.sqrt(dx * dx + dy * dy);
  // Degenerate case: muzzle is at the target tile already (eg dust-storm
  // jitter pushed the target back onto the cannon). Return a one-frame
  // trajectory so the impact resolves immediately on the next tick.
  if (horizDist === 0 || speed <= 0) {
    return { vy0: 0, flightTime: 1e-6 };
  }
  const flightTime = horizDist / speed;
  // launchAltitude + vy0*T - 0.5*g*T² = targetAltitude
  // => vy0 = (Δalt + 0.5*g*T²) / T
  const vy0 =
    (targetAltitude -
      launchAltitude +
      0.5 * GRAVITY * flightTime * flightTime) /
    flightTime;
  return { vy0, flightTime };
}

/** Altitude at horizontal `progress` (0 = launch, 1 = impact). Pure
 *  closed-form lookup — no dependency on any prior tick's state. */
export function altitudeAt(
  launchAltitude: number,
  vy0: number,
  flightTime: number,
  progress: number,
): number {
  const t = progress * flightTime;
  return launchAltitude + vy0 * t - 0.5 * GRAVITY * t * t;
}
