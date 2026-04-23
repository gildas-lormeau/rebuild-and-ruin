/**
 * Detect CPU / GPU / GC peaks in a Chrome DevTools `trace.json`
 * captured by the E2E perf API (`sc.perf.stopTrace`).
 *
 * The trace timeline is split into fixed-width windows (default
 * 100ms). For each window we aggregate:
 *   - main-thread busy time (CPU ms spent in Complete events on the
 *     renderer's main thread; the main thread is auto-detected as
 *     the (pid, tid) carrying the most `FireAnimationFrame` events)
 *   - GPU busy time (sum of `GPUTask` durations)
 *   - worst single frame (longest `FireAnimationFrame` / `RenderFrame`
 *     on the main thread in the window)
 *   - GC time (sum of GC-family durations)
 *
 * We then print the top-N windows by each axis, with timestamps in
 * seconds-since-trace-start so a peak can be lined up against a
 * moment in the game.
 *
 * Usage:
 *   deno run -A --v8-flags=--max-old-space-size=8192 \
 *     scripts/analyze-perf-peaks.ts [path] [--window=100] [--top=20]
 *
 * Defaults: path = `tmp/perf/trace.json`, window = 100ms, top = 20.
 *
 * Note: the whole procedure lives inside `main()` because the repo's
 * file-order lint hoists top-level `const`s above loops that populate
 * them. Inside a function body, ordering is preserved.
 */

interface TraceEvent {
  name: string;
  cat: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: Record<string, unknown>;
}

interface Args {
  path: string;
  windowMs: number;
  top: number;
}

interface Bucket {
  cpuUs: number;
  gpuUs: number;
  gcUs: number;
  worstFrame: { name: string; dur: number; ts: number } | null;
  worstCpu: { name: string; dur: number; ts: number } | null;
}

interface Ranked {
  idx: number;
  bucket: Bucket;
  score: number;
}

const GC_NAMES = new Set(["MajorGC", "MinorGC"]);
const FRAME_NAMES = new Set(["FireAnimationFrame", "RenderFrame"]);

await main();

async function main(): Promise<void> {
  const { path, windowMs, top } = parseArgs();
  const windowUs = windowMs * 1000;

  console.log(`Reading ${path}…`);
  const raw = await Deno.readTextFile(path);
  console.log(
    `Raw size: ${(raw.length / 1024 / 1024).toFixed(1)} MB. Parsing…`,
  );
  const trace = JSON.parse(raw) as { traceEvents: TraceEvent[] };
  const events = trace.traceEvents;
  console.log(`Events: ${events.length.toLocaleString()}`);

  // Trace origin: lowest ts across Complete events. Instants and
  // metadata can have ts=0 and would skew the origin.
  let ts0 = Number.POSITIVE_INFINITY;
  let tsEnd = 0;
  for (const ev of events) {
    if (ev.ph !== "X" || typeof ev.dur !== "number") continue;
    if (ev.ts < ts0) ts0 = ev.ts;
    const endTs = ev.ts + ev.dur;
    if (endTs > tsEnd) tsEnd = endTs;
  }
  if (!Number.isFinite(ts0)) throw new Error("no Complete events in trace");

  const totalUs = tsEnd - ts0;
  const numBuckets = Math.ceil(totalUs / windowUs);
  console.log(
    `Timeline: ${(totalUs / 1_000_000).toFixed(2)} s, ${numBuckets} buckets × ${windowMs} ms`,
  );

  // Detect the main renderer thread: the (pid, tid) with the most
  // `FireAnimationFrame` events. Peaks there are the game's fault;
  // compositor-thread peaks aren't our problem.
  const rafCounts = new Map<string, number>();
  for (const ev of events) {
    if (ev.name !== "FireAnimationFrame") continue;
    const key = `${ev.pid}:${ev.tid}`;
    rafCounts.set(key, (rafCounts.get(key) ?? 0) + 1);
  }
  let mainKey = "";
  let mainCount = 0;
  for (const [key, count] of rafCounts) {
    if (count > mainCount) {
      mainKey = key;
      mainCount = count;
    }
  }
  console.log(
    `Main thread: ${mainKey} (${mainCount} FireAnimationFrame events)`,
  );

  const buckets: Bucket[] = Array.from({ length: numBuckets }, () => ({
    cpuUs: 0,
    gpuUs: 0,
    gcUs: 0,
    worstFrame: null,
    worstCpu: null,
  }));

  // Single pass: classify each Complete event and stamp it into a
  // bucket. Events straddling a boundary are attributed to the bucket
  // they start in — good enough for ranking.
  for (const ev of events) {
    if (ev.ph !== "X" || typeof ev.dur !== "number") continue;
    const offsetUs = ev.ts - ts0;
    if (offsetUs < 0) continue;
    const idx = Math.min(Math.floor(offsetUs / windowUs), numBuckets - 1);
    const bucket = buckets[idx];

    if (ev.name === "GPUTask") {
      bucket.gpuUs += ev.dur;
      continue;
    }
    if (isGc(ev)) {
      bucket.gcUs += ev.dur;
      continue;
    }
    if (`${ev.pid}:${ev.tid}` !== mainKey) continue;

    // `ThreadControllerImpl::RunTask` is the outermost main-thread
    // task span — use it for CPU accounting. `RunTask` is the paired
    // inner span and would double-count; nested Complete events like
    // `FunctionCall` / `EvaluateScript` are descendants of the same
    // task and would triple-count, so we skip everything except the
    // outer span for CPU totals.
    if (ev.name === "ThreadControllerImpl::RunTask") {
      bucket.cpuUs += ev.dur;
      if (ev.dur > (bucket.worstCpu?.dur ?? 0)) {
        bucket.worstCpu = { name: ev.name, dur: ev.dur, ts: ev.ts };
      }
      continue;
    }
    if (FRAME_NAMES.has(ev.name)) {
      if (ev.dur > (bucket.worstFrame?.dur ?? 0)) {
        bucket.worstFrame = { name: ev.name, dur: ev.dur, ts: ev.ts };
      }
    }
  }

  printRanking(
    `TOP ${top} CPU-PEAK WINDOWS (main-thread busy, ${windowMs}ms buckets):`,
    rankBy(buckets, "cpuUs", top),
    windowUs,
  );
  printRanking(
    `TOP ${top} GPU-PEAK WINDOWS:`,
    rankBy(buckets, "gpuUs", top),
    windowUs,
  );
  printRanking(
    `TOP ${top} WORST-FRAME WINDOWS (longest single FireAnimationFrame):`,
    rankByWorstFrame(buckets, top),
    windowUs,
  );
  const gcRanking = rankBy(buckets, "gcUs", top);
  if (gcRanking.length > 0) {
    printRanking(`TOP ${top} GC-PEAK WINDOWS:`, gcRanking, windowUs);
  }

  // Saturation summary — is pressure constant or spiky?
  const cpuSaturated = buckets.filter((b) => b.cpuUs > windowUs * 0.5).length;
  const gpuSaturated = buckets.filter((b) => b.gpuUs > windowUs * 0.5).length;
  const anySpike = buckets.filter(
    (b) => (b.worstFrame?.dur ?? 0) > 33_333,
  ).length;
  console.log();
  console.log("Summary:");
  console.log(
    `  CPU >50% busy: ${cpuSaturated}/${numBuckets} buckets (${((100 * cpuSaturated) / numBuckets).toFixed(1)}%)`,
  );
  console.log(
    `  GPU >50% busy: ${gpuSaturated}/${numBuckets} buckets (${((100 * gpuSaturated) / numBuckets).toFixed(1)}%)`,
  );
  console.log(
    `  Buckets with a >33.3ms frame: ${anySpike}/${numBuckets} (${((100 * anySpike) / numBuckets).toFixed(1)}%)`,
  );
}

function parseArgs(): Args {
  let path = "tmp/perf/trace.json";
  let windowMs = 100;
  let top = 20;
  for (const arg of Deno.args) {
    if (arg.startsWith("--window=")) windowMs = Number(arg.slice(9));
    else if (arg.startsWith("--top=")) top = Number(arg.slice(6));
    else if (!arg.startsWith("--")) path = arg;
  }
  return { path, windowMs, top };
}

function isGc(ev: TraceEvent): boolean {
  return GC_NAMES.has(ev.name) || ev.name.startsWith("V8.GC");
}

function rankBy(
  buckets: Bucket[],
  key: "cpuUs" | "gpuUs" | "gcUs",
  top: number,
): Ranked[] {
  return buckets
    .map((bucket, idx): Ranked => ({ idx, bucket, score: bucket[key] }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}

function rankByWorstFrame(buckets: Bucket[], top: number): Ranked[] {
  return buckets
    .map(
      (bucket, idx): Ranked => ({
        idx,
        bucket,
        score: bucket.worstFrame?.dur ?? 0,
      }),
    )
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}

function printRanking(title: string, rows: Ranked[], windowUs: number): void {
  console.log();
  console.log(title);
  const busyPct = (us: number): string =>
    `${((100 * us) / windowUs).toFixed(0).padStart(3)}%`;
  const ms = (us: number): string => (us / 1000).toFixed(1);
  for (const { idx, bucket } of rows) {
    const t = ((idx * windowUs) / 1_000_000).toFixed(2).padStart(7);
    const parts: string[] = [`t=${t}s`];
    parts.push(
      `cpu=${ms(bucket.cpuUs).padStart(6)}ms (${busyPct(bucket.cpuUs)})`,
    );
    parts.push(
      `gpu=${ms(bucket.gpuUs).padStart(6)}ms (${busyPct(bucket.gpuUs)})`,
    );
    if (bucket.gcUs > 0) parts.push(`gc=${ms(bucket.gcUs).padStart(5)}ms`);
    if (bucket.worstFrame) {
      parts.push(`worstFrame=${ms(bucket.worstFrame.dur)}ms`);
    }
    console.log(`  ${parts.join("  ")}`);
  }
}
