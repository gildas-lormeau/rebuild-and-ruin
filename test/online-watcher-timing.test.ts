/**
 * Watcher timing tests: setWatcherPhaseTimer, clearWatcherPhaseTimer.
 *
 * Verifies that watcher-side phase timer reconstruction from wall-clock
 * produces correct values and handles edge cases.
 *
 * Run with: bun test/online-watcher-timing.test.ts
 */

import {
  clearWatcherPhaseTimer,
  setWatcherPhaseTimer,
  type WatcherTimingState,
} from "../src/online-types.ts";
import { assert, runTests, test } from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshTiming(): WatcherTimingState {
  return {
    phaseStartTime: 0,
    phaseDuration: 0,
    countdownStartTime: 0,
    countdownDuration: 0,
  };
}

/** Reconstruct the timer value as a watcher would each frame.
 *  Formula: timer = max(0, phaseDuration - (now - phaseStartTime)) */
function reconstructTimer(timing: WatcherTimingState, now: number): number {
  if (timing.phaseDuration === 0) return 0;
  return Math.max(0, timing.phaseDuration - (now - timing.phaseStartTime));
}

// ---------------------------------------------------------------------------
// setWatcherPhaseTimer
// ---------------------------------------------------------------------------

test("setWatcherPhaseTimer sets phaseStartTime and phaseDuration", () => {
  const timing = freshTiming();
  setWatcherPhaseTimer(timing, 1000, 30000);

  assert(timing.phaseStartTime === 1000, `expected phaseStartTime=1000, got ${timing.phaseStartTime}`);
  assert(timing.phaseDuration === 30000, `expected phaseDuration=30000, got ${timing.phaseDuration}`);
});

test("watcher timer reconstruction at various elapsed times", () => {
  const timing = freshTiming();
  setWatcherPhaseTimer(timing, 1000, 30000);

  // At start: 0ms elapsed → timer = 30000
  const t0 = reconstructTimer(timing, 1000);
  assert(t0 === 30000, `at start: expected 30000, got ${t0}`);

  // 10 seconds in → timer = 20000
  const t10 = reconstructTimer(timing, 11000);
  assert(t10 === 20000, `at 10s: expected 20000, got ${t10}`);

  // 25 seconds in → timer = 5000
  const t25 = reconstructTimer(timing, 26000);
  assert(t25 === 5000, `at 25s: expected 5000, got ${t25}`);

  // 30 seconds (exact end) → timer = 0
  const t30 = reconstructTimer(timing, 31000);
  assert(t30 === 0, `at 30s: expected 0, got ${t30}`);
});

test("watcher timer does not go negative past phase end", () => {
  const timing = freshTiming();
  setWatcherPhaseTimer(timing, 1000, 15000);

  // 20 seconds past start (5s over) → clamped to 0
  const t = reconstructTimer(timing, 21000);
  assert(t === 0, `expected 0 (clamped), got ${t}`);
});

test("setWatcherPhaseTimer overwrites previous phase", () => {
  const timing = freshTiming();
  setWatcherPhaseTimer(timing, 1000, 30000);
  setWatcherPhaseTimer(timing, 5000, 15000);

  assert(timing.phaseStartTime === 5000, `expected phaseStartTime=5000, got ${timing.phaseStartTime}`);
  assert(timing.phaseDuration === 15000, `expected phaseDuration=15000, got ${timing.phaseDuration}`);

  // Verify reconstruction uses new values
  const t = reconstructTimer(timing, 10000); // 5s into 15s phase → 10000
  assert(t === 10000, `expected 10000, got ${t}`);
});

// ---------------------------------------------------------------------------
// clearWatcherPhaseTimer
// ---------------------------------------------------------------------------

test("clearWatcherPhaseTimer zeros out phase timing", () => {
  const timing = freshTiming();
  setWatcherPhaseTimer(timing, 5000, 30000);
  clearWatcherPhaseTimer(timing);

  assert(timing.phaseStartTime === 0, `expected phaseStartTime=0, got ${timing.phaseStartTime}`);
  assert(timing.phaseDuration === 0, `expected phaseDuration=0, got ${timing.phaseDuration}`);
});

test("clearWatcherPhaseTimer leaves countdown fields untouched", () => {
  const timing = freshTiming();
  timing.countdownStartTime = 2000;
  timing.countdownDuration = 5000;
  setWatcherPhaseTimer(timing, 5000, 30000);
  clearWatcherPhaseTimer(timing);

  assert(timing.countdownStartTime === 2000, `countdown start should be preserved, got ${timing.countdownStartTime}`);
  assert(timing.countdownDuration === 5000, `countdown duration should be preserved, got ${timing.countdownDuration}`);
});

test("reconstructTimer returns 0 after reset", () => {
  const timing = freshTiming();
  setWatcherPhaseTimer(timing, 1000, 30000);
  clearWatcherPhaseTimer(timing);

  const t = reconstructTimer(timing, 5000);
  assert(t === 0, `expected 0 after reset, got ${t}`);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("zero-duration phase timer reads as 0 immediately", () => {
  const timing = freshTiming();
  setWatcherPhaseTimer(timing, 1000, 0);

  const t = reconstructTimer(timing, 1000);
  assert(t === 0, `zero-duration phase should have timer=0, got ${t}`);
});

test("very large phase duration works correctly", () => {
  const timing = freshTiming();
  const duration = 600000; // 10 minutes
  setWatcherPhaseTimer(timing, 0, duration);

  const t = reconstructTimer(timing, 300000); // 5 min elapsed
  assert(t === 300000, `expected 300000, got ${t}`);
});

await runTests("Online watcher timing");
