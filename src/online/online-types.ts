/** Shared types and utilities for online multiplayer sub-modules. */

import { CANNON_MODES, CannonMode } from "../shared/battle-types.ts";
import type { PixelPos } from "../shared/geometry-types.ts";
import type { CannonPhantom, PiecePhantom } from "../shared/phantom-types.ts";
import {
  CROSSHAIR_SPEED,
  type OrbitParams,
} from "../shared/system-interfaces.ts";
import type { WatcherTimingState } from "../shared/tick-context.ts";

/** Subset of watcher state containing network-received data (phantoms, crosshairs).
 *  Defined here (L10) so both "online infrastructure" and "online logic" consumers
 *  can reference it without importing from the higher-layer watcher module. */
export interface WatcherNetworkState {
  remoteCrosshairs: Map<number, PixelPos>;
  remoteCannonPhantoms: readonly CannonPhantom[];
  remotePiecePhantoms: readonly PiecePhantom[];
  watcherOrbitParams: Map<number, OrbitParams>;
}

/** Speed multiplier for interpolating remote crosshairs (faster than local to reduce visual lag).
 *  Shared between host (online-host-crosshairs) and watcher (online-watcher-battle). */
const REMOTE_CROSSHAIR_MULTIPLIER = 2;
/** Pre-computed remote crosshair speed (base speed × remote multiplier). */
export const REMOTE_CROSSHAIR_SPEED =
  CROSSHAIR_SPEED * REMOTE_CROSSHAIR_MULTIPLIER;

/** Start tracking a new phase timer. Call at the moment a phase begins on the watcher side.
 *  The watcher reconstructs `state.timer` each frame from `(now - phaseStartTime)`. */
export function setWatcherPhaseTimer(
  timing: WatcherTimingState,
  now: number,
  phaseDuration: number,
): void {
  timing.phaseStartTime = now;
  timing.phaseDuration = phaseDuration;
}

/** Reset phase timing to idle (no active phase timer). */
export function clearWatcherPhaseTimer(timing: WatcherTimingState): void {
  timing.phaseStartTime = 0;
  timing.phaseDuration = 0;
}

/** Parse a string as a CannonMode, defaulting to NORMAL if invalid. */
export function toCannonMode(value: string | undefined): CannonMode {
  if (value && (CANNON_MODES as ReadonlySet<string>).has(value))
    return value as CannonMode;
  return CannonMode.NORMAL;
}

/** Move `vis` toward `(tx, ty)` at `speed` pixels/s. Mutates `vis` in place. */
export function interpolateToward(
  vis: PixelPos,
  tx: number,
  ty: number,
  speed: number,
  dt: number,
): void {
  const dx = tx - vis.x,
    dy = ty - vis.y;
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
