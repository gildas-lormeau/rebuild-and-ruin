/**
 * Ballistic trajectory math — closed-form 3D projectile under gravity.
 * Pure: given launch/impact endpoints + horizontal speed, solve initial vy
 * and flight time. Host and watcher run identical inputs for frame-perfect
 * sync. Coords: (x, y) world-pixels horizontal; altitude world-units
 * vertical; gravity positive (pulls altitude toward 0).
 */

/** Trajectory parameters solved at fire time. */

interface TrajectoryParams {
  /** Total horizontal distance (world-pixels). */
  readonly horizontalDist: number;
  /** Seconds from launch to impact. */
  readonly flightTime: number;
  /** Initial vertical velocity (world-units per second). Positive =
   *  upward at launch. */
  readonly vy0: number;
}

/** Solve trajectory parameters so a ball launched at `(launchX, launchY)`
 *  with altitude `launchAlt` at the given horizontal `speed` reaches
 *  `(impactX, impactY)` at altitude `impactAlt` on a pure parabola.
 *
 *  - Horizontal component: constant `speed` along the (launch→impact)
 *    vector. `flightTime = horizontalDist / speed`.
 *  - Vertical component: altitude(t) = launchAlt + vy0·t − 0.5·g·t².
 *    `vy0` is solved so altitude(flightTime) == impactAlt.
 *
 *  When launch == impact horizontally (zero distance), returns a
 *  zero-length trajectory with `vy0 = 0`. Caller should spawn an
 *  instant impact instead of pushing the ball.
 */
export function solveTrajectory(
  launchX: number,
  launchY: number,
  launchAlt: number,
  impactX: number,
  impactY: number,
  impactAlt: number,
  speed: number,
  gravity: number,
): TrajectoryParams {
  const dx = impactX - launchX;
  const dy = impactY - launchY;
  const horizontalDist = Math.sqrt(dx * dx + dy * dy);
  if (horizontalDist === 0 || speed <= 0) {
    return { horizontalDist, flightTime: 0, vy0: 0 };
  }
  const flightTime = horizontalDist / speed;
  const vy0 = (impactAlt - launchAlt) / flightTime + 0.5 * gravity * flightTime;
  return { horizontalDist, flightTime, vy0 };
}

/** Sample the ball's horizontal position at time `elapsed` since launch.
 *  Linear interpolation along (launch → impact). Extrapolates past
 *  `flightTime` if elapsed > flightTime (caller should not advance past
 *  the landing frame — impact is detected at elapsed >= flightTime). */
export function horizontalAt(
  launchX: number,
  launchY: number,
  impactX: number,
  impactY: number,
  flightTime: number,
  elapsed: number,
): { x: number; y: number } {
  if (flightTime <= 0) return { x: impactX, y: impactY };
  const progress = elapsed / flightTime;
  return {
    x: launchX + (impactX - launchX) * progress,
    y: launchY + (impactY - launchY) * progress,
  };
}

/** Sample the ball's altitude at time `elapsed` since launch. */
export function altitudeAt(
  launchAlt: number,
  vy0: number,
  gravity: number,
  elapsed: number,
): number {
  return launchAlt + vy0 * elapsed - 0.5 * gravity * elapsed * elapsed;
}
