/** Shared types and utilities for online multiplayer sub-modules. */

import type { WatcherTimingState } from "../runtime/runtime-tick-context.ts";
import { CannonMode } from "../shared/core/battle-types.ts";
import { CANNON_MODE_IDS } from "../shared/core/cannon-mode-defs.ts";
import type { PixelPos } from "../shared/core/geometry-types.ts";
import type {
  CannonPhantom,
  PiecePhantom,
} from "../shared/core/phantom-types.ts";
import {
  CROSSHAIR_SPEED,
  type OrbitParams,
} from "../shared/core/system-interfaces.ts";

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

/** Anchor the watcher phase timer to the current wall clock. Call from inside
 *  the banner onComplete callback — `performance.now()` at that instant is the
 *  moment the banner animation finished on this client, which is the logical
 *  moment the phase begins (mirroring the host's `resetAccum` at the end of
 *  the same transition recipe).
 *
 *  Use this helper for every phase whose watcher timer starts after a banner:
 *  cannon-start and build-start both call it. Do NOT pre-compute the origin
 *  as `bannerStartedAt + bannerDuration * 1000` — that relies on the banner
 *  animation matching its nominal duration exactly, which frame drops or
 *  browser throttling can violate. A dialog (upgrade-pick) that plays BEFORE
 *  the banner is fine: the dialog finishes before `showBanner()` is called,
 *  so the callback still fires at true banner-end. */
export function setWatcherPhaseTimerAtBannerEnd(
  timing: WatcherTimingState,
  phaseDuration: number,
  now: number,
): void {
  setWatcherPhaseTimer(timing, now, phaseDuration);
}

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
  if (value && (CANNON_MODE_IDS as ReadonlySet<string>).has(value))
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
