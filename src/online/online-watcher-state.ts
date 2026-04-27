/**
 * Watcher-side runtime state — remote-human crosshair maps + per-phase
 * timing anchor + host-migration banner. Held by every peer (host or
 * watcher) because every peer renders remote humans and may receive a
 * host-migration announcement.
 *
 * State lives here; reset/lifecycle helpers live with it. Tick functions
 * (per-phase battle/build/cannon) were removed when the runtime collapsed
 * to the clone-everywhere model — every peer runs the same host phase
 * ticks locally.
 */

import {
  clearWatcherPhaseTimer,
  type WatcherTimingState,
} from "../runtime/runtime-tick-context.ts";
import type { PixelPos } from "../shared/core/geometry-types.ts";
import type { WatcherNetworkState } from "./online-types.ts";

export interface WatcherState extends WatcherNetworkState {
  timing: WatcherTimingState;
  /** Interpolated visual positions shown to the watcher (smoothed toward remoteCrosshairs). */
  watcherCrosshairPos: Map<number, PixelPos>;
  /** Host-migration announcement: survives frame clears for the duration, then self-clears.
   *  Driven through `tickPersistentAnnouncement` from runtime-tick-context. */
  migrationBanner: { timer: number; text: string };
}

export function createWatcherState(): WatcherState {
  return {
    timing: {
      phaseStartTime: 0,
      phaseDuration: 0,
      countdownStartTime: 0,
      countdownDuration: 0,
    },
    remoteCrosshairs: new Map(),
    watcherCrosshairPos: new Map(),
    migrationBanner: { timer: 0, text: "" },
  };
}

/** Full reset — clears all watcher state. Used when joining a new game or full-state recovery. */
export function resetWatcherState(watcherState: WatcherState): void {
  watcherState.remoteCrosshairs.clear();
  watcherState.watcherCrosshairPos.clear();
  clearWatcherPhaseTimer(watcherState.timing);
  watcherState.timing.countdownStartTime = 0;
  watcherState.timing.countdownDuration = 0;
  watcherState.migrationBanner.timer = 0;
  watcherState.migrationBanner.text = "";
}

/**
 * Partial reset for host promotion. Clears timing
 * but keeps remoteCrosshairs/crosshairPos — the new host still
 * uses those for remote human players via extendCrosshairs.
 * Phantoms live on each remote-controlled slot's controller and are
 * preserved across promotion alongside the controllers themselves.
 */
export function resetWatcherTimingForHostPromotion(
  watcherState: WatcherState,
): void {
  clearWatcherPhaseTimer(watcherState.timing);
  watcherState.timing.countdownStartTime = 0;
  watcherState.timing.countdownDuration = 0;
}
