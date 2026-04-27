/**
 * Online presence state — remote-human crosshair tracking + host-migration
 * banner. Held by every peer (clone-everywhere model: each peer renders
 * remote humans and may receive a host-migration announcement).
 */

import type { PixelPos } from "../shared/core/geometry-types.ts";
import type { RemoteCrosshairTargets } from "./online-types.ts";

export interface OnlinePresenceState extends RemoteCrosshairTargets {
  /** Interpolated visual positions, smoothed each frame toward the
   *  latest `remoteCrosshairs` target — what the renderer displays. */
  smoothedCrosshairPos: Map<number, PixelPos>;
  /** Host-migration announcement: survives frame clears for the duration, then self-clears.
   *  Driven through `tickPersistentAnnouncement` from runtime-tick-context. */
  migrationBanner: { timer: number; text: string };
}

export function createOnlinePresenceState(): OnlinePresenceState {
  return {
    remoteCrosshairs: new Map(),
    smoothedCrosshairPos: new Map(),
    migrationBanner: { timer: 0, text: "" },
  };
}

/** Full reset — clears all presence state. Used when joining a new game or full-state recovery. */
export function resetOnlinePresenceState(state: OnlinePresenceState): void {
  state.remoteCrosshairs.clear();
  state.smoothedCrosshairPos.clear();
  state.migrationBanner.timer = 0;
  state.migrationBanner.text = "";
}

/**
 * Partial reset for host promotion — keeps `remoteCrosshairs` /
 * `smoothedCrosshairPos` since the new host still uses those for remote
 * human players via `extendCrosshairs`. Phantoms live on each remote-
 * controlled slot's controller and are preserved across promotion
 * alongside the controllers themselves. Effectively a no-op now (kept
 * for symmetry with `resetOnlinePresenceState` in case future
 * promotion-only state is added).
 */
export function resetPresenceForHostPromotion(
  _state: OnlinePresenceState,
): void {
  // No promotion-only state to reset.
}
