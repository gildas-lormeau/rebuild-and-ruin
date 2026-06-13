/**
 * Sustained-desync detector. Counts stale wire stamps — arriving lockstep
 * actions whose `applyAt <= simTick` (the fork condition flagged by
 * `warnIfStaleWireStamp`) — in a sliding window; a burst past `threshold`
 * fires `onTooMuchLag` once. Wall-clock-driven and outside the sim (never
 * touches `state.rng`), so two peers on different links trip independently.
 */

export interface LagDetector {
  /** Feed one stale-stamp event stamped at wall-clock `nowMs` (expected
   *  monotonically non-decreasing, as `TimingApi.now` is). Fires
   *  `onTooMuchLag` once if this pushes the in-window count to the
   *  threshold; latched afterwards (further stamps are ignored). */
  readonly recordStaleStamp: (nowMs: number) => void;
}

/** Sliding window for the stale-stamp burst test (ms). */
export const LAG_DISCONNECT_WINDOW_MS = 2000;
/** Stale stamps within the window that trip a disconnect. Tolerant by design:
 *  a one-off jitter spike (a stamp or two) rides out via the sliding-window
 *  eviction; only a sustained burst — the link persistently past the 8-tick
 *  SAFETY window — disconnects. Tune here. */
export const LAG_DISCONNECT_STALE_STAMP_COUNT = 5;

export function createLagDetector(opts: {
  readonly onTooMuchLag: () => void;
  readonly windowMs?: number;
  readonly threshold?: number;
}): LagDetector {
  const windowMs = opts.windowMs ?? LAG_DISCONNECT_WINDOW_MS;
  const threshold = opts.threshold ?? LAG_DISCONNECT_STALE_STAMP_COUNT;
  // Ascending wall-clock times of the stamps still inside the window.
  const recent: number[] = [];
  let tripped = false;

  return {
    recordStaleStamp(nowMs) {
      if (tripped) return;
      recent.push(nowMs);
      const cutoff = nowMs - windowMs;
      // Evict stamps that have aged out of the window. `recent` stays sorted
      // because `nowMs` is monotonic, so a front-drain is correct.
      while (recent.length > 0 && recent[0]! < cutoff) recent.shift();
      if (recent.length >= threshold) {
        tripped = true;
        recent.length = 0;
        opts.onTooMuchLag();
      }
    },
  };
}
