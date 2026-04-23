/**
 * E2E perf smoke test: plays a single round in a real browser at real
 * wall-clock speed and captures every Chrome DevTools perf artifact
 * the `sc.perf` API exposes.
 *
 * Non-fast (real RAF), non-headless (so frame timings reflect a real
 * GPU / compositor path). 1 round keeps the wall-clock budget bounded.
 *
 * Artifacts land in `tmp/perf/` (gitignored):
 *   - trace.json       → Chrome DevTools Performance panel (Load profile)
 *   - cpu.cpuprofile   → Chrome DevTools Performance panel (Load profile)
 *   - heap.heapsnapshot → Chrome DevTools Memory panel (Load)
 *
 * Run: deno test --no-check -A test/e2e-perf.test.ts
 * Requires: npm run dev (vite on port 5173)
 */

import { assert, assertGreater } from "@std/assert";
import { createE2EScenario } from "./e2e-scenario.ts";

const OUT_DIR = "tmp/perf";

Deno.test("e2e perf: single round produces DevTools artifacts", async () => {
  await Deno.mkdir(OUT_DIR, { recursive: true });

  await using sc = await createE2EScenario({
    seed: 42,
    humans: 0,
    headless: false,
    fastMode: false,
    rounds: 1,
  });

  // Baseline counters before anything interesting has happened.
  const before = await sc.perf.metrics();

  await sc.perf.startTrace();
  await sc.perf.startCpuProfile();

  // Real-time 1-round game needs a generous wall-clock budget —
  // castle select + build + cannon + battle + round-over banner all
  // run on their real timers now that fastMode is off.
  await sc.runGame({ timeoutMs: 180_000 });

  await sc.perf.stopCpuProfile(`${OUT_DIR}/cpu.cpuprofile`);
  await sc.perf.stopTrace(`${OUT_DIR}/trace.json`);
  await sc.perf.heapSnapshot(`${OUT_DIR}/heap.heapsnapshot`);

  const after = await sc.perf.metrics();

  // Sanity-check the metrics delta: time advanced, some task
  // duration accumulated, heap is non-zero. These aren't perf
  // assertions — just proof the CDP pipe carried real data end to end.
  assertGreater(after.timestamp, before.timestamp, "timestamp advanced");
  assertGreater(
    after.taskDuration,
    before.taskDuration,
    "renderer did work during the round",
  );
  assertGreater(after.jsHeapUsedBytes, 0, "js heap reported");

  // Prove each artifact was written and is non-empty. Parse the JSON
  // ones to confirm they're well-formed (DevTools silently ignores
  // broken files).
  const trace = JSON.parse(await Deno.readTextFile(`${OUT_DIR}/trace.json`));
  assertGreater(
    (trace.traceEvents as unknown[]).length,
    0,
    "trace has events",
  );

  const cpu = JSON.parse(await Deno.readTextFile(`${OUT_DIR}/cpu.cpuprofile`));
  assertGreater(
    (cpu.nodes as unknown[]).length,
    0,
    "cpu profile has call-tree nodes",
  );

  const heapStat = await Deno.stat(`${OUT_DIR}/heap.heapsnapshot`);
  assert(heapStat.size > 0, "heap snapshot is non-empty");

  console.log(
    `[perf] trace=${trace.traceEvents.length} events, ` +
      `cpu=${cpu.nodes.length} nodes, ` +
      `heapDelta=${(after.jsHeapUsedBytes - before.jsHeapUsedBytes).toLocaleString()} bytes, ` +
      `taskDuration=${(after.taskDuration - before.taskDuration).toFixed(2)}s`,
  );
});
