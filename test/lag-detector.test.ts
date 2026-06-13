/**
 * Unit tests for the sustained-desync lag detector. Pure logic, driven by
 * explicit wall-clock timestamps (no mock clock needed) — the detector is a
 * wall-clock observer outside the sim, so it's tested in isolation here; the
 * stale-stamp → detector wiring lives in `online/runtime/deps.ts`
 * (`warnIfStaleWireStamp`).
 */

import { assertEquals } from "@std/assert";
import {
  createLagDetector,
  LAG_DISCONNECT_STALE_STAMP_COUNT,
  LAG_DISCONNECT_WINDOW_MS,
} from "../src/online/online-lag-detector.ts";

Deno.test("fires once when threshold stamps land inside the window", () => {
  let fired = 0;
  const det = createLagDetector({
    onTooMuchLag: () => fired++,
    windowMs: 1000,
    threshold: 5,
  });
  // 5 stamps, each 100ms apart → all within the 1000ms window.
  for (let i = 0; i < 5; i++) det.recordStaleStamp(i * 100);
  assertEquals(fired, 1, "should disconnect on the 5th in-window stamp");

  // Latched: further stamps do not re-fire.
  for (let i = 0; i < 10; i++) det.recordStaleStamp(1000 + i * 100);
  assertEquals(fired, 1, "should fire exactly once, then stay latched");
});

Deno.test("does NOT fire when stamps are spread wider than the window", () => {
  let fired = 0;
  const det = createLagDetector({
    onTooMuchLag: () => fired++,
    windowMs: 1000,
    threshold: 5,
  });
  // One stamp every 2000ms — only ever 1 in any 1000ms window.
  for (let i = 0; i < 20; i++) det.recordStaleStamp(i * 2000);
  assertEquals(fired, 0, "isolated jitter spikes must not disconnect");
});

Deno.test("stamps that age out of the window stop counting", () => {
  let fired = 0;
  const det = createLagDetector({
    onTooMuchLag: () => fired++,
    windowMs: 1000,
    threshold: 5,
  });
  // 4 stamps early, then a long quiet gap, then 4 more — neither cluster
  // alone reaches 5, and the first cluster has aged out before the second.
  det.recordStaleStamp(0);
  det.recordStaleStamp(100);
  det.recordStaleStamp(200);
  det.recordStaleStamp(300);
  det.recordStaleStamp(5000);
  det.recordStaleStamp(5100);
  det.recordStaleStamp(5200);
  det.recordStaleStamp(5300);
  assertEquals(fired, 0, "evicted stamps must not accumulate across a lull");
});

Deno.test("fires exactly at the threshold, not before", () => {
  let fired = 0;
  const det = createLagDetector({
    onTooMuchLag: () => fired++,
    windowMs: 1000,
    threshold: 5,
  });
  det.recordStaleStamp(0);
  det.recordStaleStamp(10);
  det.recordStaleStamp(20);
  det.recordStaleStamp(30);
  assertEquals(fired, 0, "4 stamps (below threshold) must not fire");
  det.recordStaleStamp(40);
  assertEquals(fired, 1, "the 5th stamp trips the threshold");
});

Deno.test("default constants are a sane tolerant window", () => {
  // Guards against an accidental edit that makes the defaults trigger-happy
  // (a single stamp) or never-firing (zero threshold).
  assertEquals(LAG_DISCONNECT_STALE_STAMP_COUNT > 1, true);
  assertEquals(LAG_DISCONNECT_WINDOW_MS >= 1000, true);
});
