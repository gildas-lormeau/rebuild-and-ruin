/** Per-frame visual interpolation for remote crosshairs.
 *
 *  Both online roles (host + watcher) animate remote-player crosshairs the
 *  same way: lazy-init a visual-position cache, lerp toward the latest
 *  network target at a fixed speed, and sync each player's cannons to the
 *  visual point. Local controllers animate natively via getCrosshair() —
 *  only remote crosshairs go through this loop.
 *
 *  Lives in runtime/ rather than online/ because it's render-prep, not
 *  networking — both roles call it identically; only `online/` happens to
 *  hold the maps that feed it. */

import { aimCannons, canPlayerFire } from "../game/index.ts";
import type { PixelPos } from "../shared/core/geometry-types.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import {
  type BattleViewState,
  CROSSHAIR_SPEED,
} from "../shared/core/system-interfaces.ts";

/** Remote crosshairs lerp at this multiple of base speed to mask wire-rate
 *  staleness — local controllers update every frame, remote targets arrive
 *  at the dedup cadence. */
const REMOTE_CROSSHAIR_MULTIPLIER = 2;
const REMOTE_CROSSHAIR_SPEED = CROSSHAIR_SPEED * REMOTE_CROSSHAIR_MULTIPLIER;

/** Eligibility + lerp + cannon-aim sync for one remote crosshair entry.
 *
 *  Returns the interpolated visual position, or `null` if the player should
 *  be skipped (eliminated, can't fire). The caller decides where to push
 *  the resulting Crosshair (host-side merged array vs watcher-side
 *  frame.crosshairs) and what `cannonReady` flag to attach.
 *
 *  Side effects: lazy-initializes `visualPosCache[pid]`, mutates the cached
 *  visualPos in place, calls `aimCannons` to keep cannons tracking. */
export function tickRemoteCrosshair(
  pid: ValidPlayerSlot,
  target: PixelPos,
  state: BattleViewState,
  dt: number,
  visualPosCache: Map<number, PixelPos>,
): PixelPos | null {
  if (isPlayerEliminated(state.players[pid])) return null;
  if (!canPlayerFire(state, pid)) return null;

  let visualPos = visualPosCache.get(pid);
  if (!visualPos) {
    visualPos = { x: target.x, y: target.y };
    visualPosCache.set(pid, visualPos);
  }
  interpolateToward(visualPos, target.x, target.y, REMOTE_CROSSHAIR_SPEED, dt);
  aimCannons(state, pid, visualPos.x, visualPos.y, dt);
  return visualPos;
}

/** Move `vis` toward `(tx, ty)` at `speed` pixels/s. Mutates `vis` in place. */
function interpolateToward(
  vis: PixelPos,
  tx: number,
  ty: number,
  speed: number,
  dt: number,
): void {
  const dx = tx - vis.x;
  const dy = ty - vis.y;
  const dist = Math.hypot(dx, dy);
  const move = speed * dt;
  if (dist <= move) {
    vis.x = tx;
    vis.y = ty;
  } else {
    vis.x += (dx / dist) * move;
    vis.y += (dy / dist) * move;
  }
}
