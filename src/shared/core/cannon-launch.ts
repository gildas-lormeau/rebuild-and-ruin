/**
 * Cannon launch geometry — where in 3D each cannon variant's muzzle tip
 * sits relative to its center, used by the trajectory calculator at fire
 * time and (mirrored) by the renderer for the visual ball spawn point.
 *
 * Numbers are derived once from the authored sprite specs in
 * `render/3d/sprites/cannon-scene.ts` (see `barrelWorldPoints`):
 *
 *   muzzleY        = barrel.yPos + (barrel.length / 2) × cos(barrel.elevation)
 *   muzzleForward  = -(barrel.zOffset + (barrel.length / 2) × sin(barrel.elevation))
 *
 * (The negation on muzzleForward flips scene-Z to "forward in firing
 * direction" — scene barrels point along -Z so cosθ rotates them
 * up/forward; positive game forward is the cannon's facing direction.)
 *
 * Per scene-cell × scene-scale: cells × 0.125 (CELL) × 16 (TILE_SIZE)
 * = cells × 2 worldUnits. Computed values land at:
 *
 *   tier_1 (NORMAL):   muzzleY ≈ 18.5,  muzzleForward ≈ 10.5
 *   super_gun (SUPER): muzzleY ≈ 16.0,  muzzleForward ≈  8.7
 *   mortar (flag):     muzzleY ≈ 25.7,  muzzleForward ≈  1.7
 *
 * BALLOON / RAMPART don't fire cannonballs; they have no entry here.
 *
 * tier_2 / tier_3 use the same NORMAL entry — their muzzleY differs by
 * ~3 wu (~0.2 tile) which is below visual perception for impact-altitude
 * purposes. If tier-aware launch becomes important, fork into a
 * `(mode, tier)` lookup.
 */

import { type Cannon, CannonMode } from "./battle-types.ts";

interface LaunchGeometry {
  /** Muzzle tip altitude in world units, measured from cannon's ground plane. */
  readonly muzzleY: number;
  /** Distance from cannon center to muzzle tip along the firing direction,
   *  in world units. Same coord system as cannon `x` / `y` (game pixels). */
  readonly muzzleForward: number;
}

const NORMAL_LAUNCH: LaunchGeometry = { muzzleY: 18.5, muzzleForward: 10.5 };
const SUPER_LAUNCH: LaunchGeometry = { muzzleY: 16, muzzleForward: 8.7 };
const MORTAR_LAUNCH: LaunchGeometry = { muzzleY: 25.7, muzzleForward: 1.7 };

/** Resolve the launch geometry for a cannon. Mortar flag wins over the
 *  cannon's mode (an elected mortar uses NORMAL placement but fires from
 *  the steep mortar barrel). Balloon/Rampart never fire cannonballs and
 *  fall through to NORMAL as a safe default — callers should never reach
 *  here for those modes. */
export function launchGeometryFor(
  cannon: Pick<Cannon, "mode" | "mortar">,
): LaunchGeometry {
  if (cannon.mortar) return MORTAR_LAUNCH;
  switch (cannon.mode) {
    case CannonMode.SUPER:
      return SUPER_LAUNCH;
    case CannonMode.NORMAL:
    case CannonMode.BALLOON:
    case CannonMode.RAMPART:
      return NORMAL_LAUNCH;
  }
}
