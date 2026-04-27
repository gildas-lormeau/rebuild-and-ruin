/**
 * Watcher-side runtime state — remote-human crosshair maps + host-migration
 * banner. Held by every peer (host or watcher) because every peer renders
 * remote humans and may receive a host-migration announcement.
 *
 * Tick functions and wall-clock phase-timer anchoring were removed when
 * the runtime collapsed to the clone-everywhere model — every peer runs
 * the same host phase ticks locally with dt-based timer decrement.
 */

import type { PixelPos } from "../shared/core/geometry-types.ts";
import type { WatcherNetworkState } from "./online-types.ts";

export interface WatcherState extends WatcherNetworkState {
  /** Interpolated visual positions shown to the watcher (smoothed toward remoteCrosshairs). */
  watcherCrosshairPos: Map<number, PixelPos>;
  /** Host-migration announcement: survives frame clears for the duration, then self-clears.
   *  Driven through `tickPersistentAnnouncement` from runtime-tick-context. */
  migrationBanner: { timer: number; text: string };
}

export function createWatcherState(): WatcherState {
  return {
    remoteCrosshairs: new Map(),
    watcherCrosshairPos: new Map(),
    migrationBanner: { timer: 0, text: "" },
  };
}

/** Full reset — clears all watcher state. Used when joining a new game or full-state recovery. */
export function resetWatcherState(watcherState: WatcherState): void {
  watcherState.remoteCrosshairs.clear();
  watcherState.watcherCrosshairPos.clear();
  watcherState.migrationBanner.timer = 0;
  watcherState.migrationBanner.text = "";
}

/**
 * Partial reset for host promotion — keeps remoteCrosshairs/crosshairPos
 * since the new host still uses those for remote human players via
 * extendCrosshairs. Phantoms live on each remote-controlled slot's
 * controller and are preserved across promotion alongside the controllers
 * themselves. Effectively a no-op now (kept for symmetry with
 * resetWatcherState in case future watcher-only state is added).
 */
export function resetWatcherTimingForHostPromotion(
  _watcherState: WatcherState,
): void {
  // No watcher-only timing state to reset.
}
