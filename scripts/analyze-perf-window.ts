/**
 * Zoom into a narrow time window of a Chrome trace + CPU profile
 * captured by the E2E perf API, and attribute the cost to specific
 * functions / trace events.
 *
 * Given an approximate wall-clock time `--at=42.0` (seconds since
 * trace start) and a `--window=200` (ms, default), we:
 *
 *   1. Find the main-thread `FireAnimationFrame` event closest to
 *      `at` and print its duration + the outermost main-thread
 *      spans (RunTask / FunctionCall / EvaluateScript) inside the
 *      window, nested by start time.
 *   2. Filter CPU-profile samples to the same window and aggregate
 *      self-time by function — the most direct answer to "which of
 *      MY functions dominated this spike".
 *   3. List GPU tasks, GC events, paints, and composites in the
 *      window so GPU-side stalls can be spotted.
 *
 * The trace and CPU profile share Chromium's `base::TimeTicks`
 * timebase, so CPU-profile `startTime` / `endTime` microseconds
 * align directly with trace event `ts`.
 *
 * Usage:
 *   deno run -A --v8-flags=--max-old-space-size=8192 \
 *     scripts/analyze-perf-window.ts --at=42.0 [--window=200] \
 *     [--trace=tmp/perf/trace.json] [--cpu=tmp/perf/cpu.cpuprofile]
 *
 * Defaults: trace = `tmp/perf/trace.json`, cpu = `tmp/perf/cpu.cpuprofile`,
 *           window = 200ms. `--at` is required.
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

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}

interface CpuNode {
  id: number;
  callFrame: CallFrame;
  children?: number[];
  hitCount?: number;
}

interface CpuProfile {
  nodes: CpuNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

interface Args {
  trace: string;
  cpu: string;
  events: string | null;
  atS: number;
  windowMs: number;
}

interface EventLogMeta {
  _meta: true;
  originMs: number;
  totalEvents: number;
  keptEvents: number;
  typeCounts: Record<string, number>;
}

interface EventLogEntry {
  tMs: number; // relative to first event
  tAbsMs: number; // absolute performance.now()
  seq: number;
  type: string;
  [key: string]: unknown;
}

const SKIP_NAMES = new Set([
  "RunTask",
  "ThreadControllerImpl::RunTask",
  "BlinkScheduler_PerformMicrotaskCheckpoint",
  "Receive mojo message",
  "SimpleWatcher::OnHandleReady",
]);

await main();

async function main(): Promise<void> {
  const args = parseArgs();
  const windowUs = args.windowMs * 1000;

  console.log(`Reading ${args.trace}…`);
  const rawTrace = await Deno.readTextFile(args.trace);
  console.log(`  ${(rawTrace.length / 1024 / 1024).toFixed(1)} MB. Parsing…`);
  const trace = JSON.parse(rawTrace) as { traceEvents: TraceEvent[] };
  const events = trace.traceEvents;

  // Trace origin (same method as analyze-perf-peaks).
  let ts0 = Number.POSITIVE_INFINITY;
  for (const ev of events) {
    if (ev.ph !== "X" || typeof ev.dur !== "number") continue;
    if (ev.ts < ts0) ts0 = ev.ts;
  }
  if (!Number.isFinite(ts0)) throw new Error("no Complete events in trace");

  // Main thread = (pid, tid) with the most FireAnimationFrame events.
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
  console.log(`Main thread: ${mainKey}`);

  // --- Find the frame nearest `at` ------------------------------------
  const atUs = ts0 + args.atS * 1_000_000;
  let nearestFrame: TraceEvent | null = null;
  let nearestDelta = Number.POSITIVE_INFINITY;
  for (const ev of events) {
    if (ev.name !== "FireAnimationFrame") continue;
    if (`${ev.pid}:${ev.tid}` !== mainKey) continue;
    if (ev.ph !== "X" || typeof ev.dur !== "number") continue;
    const delta = Math.abs(ev.ts - atUs);
    if (delta < nearestDelta) {
      nearestDelta = delta;
      nearestFrame = ev;
    }
  }
  if (!nearestFrame || typeof nearestFrame.dur !== "number") {
    throw new Error(`no FireAnimationFrame near t=${args.atS}s`);
  }
  console.log();
  console.log(
    `Nearest frame: t=${((nearestFrame.ts - ts0) / 1_000_000).toFixed(3)}s  ` +
      `dur=${(nearestFrame.dur / 1000).toFixed(1)}ms`,
  );

  // --- Window: centered on the frame ----------------------------------
  const frameMid = nearestFrame.ts + nearestFrame.dur / 2;
  const winStart = frameMid - windowUs / 2;
  const winEnd = frameMid + windowUs / 2;
  console.log(
    `Window: ${((winStart - ts0) / 1_000_000).toFixed(3)}s → ${((winEnd - ts0) / 1_000_000).toFixed(3)}s  (${args.windowMs}ms)`,
  );

  // --- Main-thread nested call chain inside the window ----------------
  // Gather all main-thread Complete events that overlap the window,
  // then render them indented by parent/child nesting (a Complete
  // event's parent is any Complete event that contains it fully on
  // the same thread).
  const mainEvents: TraceEvent[] = [];
  for (const ev of events) {
    if (ev.ph !== "X" || typeof ev.dur !== "number") continue;
    if (`${ev.pid}:${ev.tid}` !== mainKey) continue;
    if (ev.ts + ev.dur < winStart || ev.ts > winEnd) continue;
    mainEvents.push(ev);
  }
  // Sort by start, then by -dur so parents come before children.
  mainEvents.sort((a, b) =>
    a.ts !== b.ts ? a.ts - b.ts : (b.dur ?? 0) - (a.dur ?? 0),
  );

  printNestedEvents(mainEvents, winStart, ts0);

  // --- GPU / GC / Paint / Composite in the window ---------------------
  const gpuIn: TraceEvent[] = [];
  const gcIn: TraceEvent[] = [];
  const paintIn: TraceEvent[] = [];
  const commitIn: TraceEvent[] = [];
  for (const ev of events) {
    if (ev.ph !== "X" || typeof ev.dur !== "number") continue;
    if (ev.ts + ev.dur < winStart || ev.ts > winEnd) continue;
    if (ev.name === "GPUTask") gpuIn.push(ev);
    else if (
      ev.name === "MajorGC" ||
      ev.name === "MinorGC" ||
      ev.name.startsWith("V8.GC")
    ) {
      gcIn.push(ev);
    } else if (ev.name === "Paint") paintIn.push(ev);
    else if (ev.name === "CompositeLayers" || ev.name === "Commit") {
      commitIn.push(ev);
    }
  }
  summarize("GPU tasks", gpuIn);
  summarize("GC events", gcIn);
  summarize("Paint events", paintIn);
  summarize("Composite/Commit", commitIn);

  // --- CPU-profile samples filtered to the window ---------------------
  console.log();
  console.log(`Reading ${args.cpu}…`);
  const rawCpu = await Deno.readTextFile(args.cpu);
  const prof = JSON.parse(rawCpu) as CpuProfile;

  // Samples arrive at timestamps `prof.startTime + cumulative(timeDeltas)`.
  // Both trace ts and cpuprofile timestamps use µs on the same Chromium
  // timebase, so we can compare directly.
  const byId = new Map<number, CpuNode>();
  for (const node of prof.nodes) byId.set(node.id, node);
  const parent = new Map<number, number>();
  for (const node of prof.nodes) {
    for (const childId of node.children ?? []) parent.set(childId, node.id);
  }

  let cursor = prof.startTime;
  const windowSelfByNode = new Map<number, number>();
  let windowUsed = 0;
  for (let idx = 0; idx < prof.samples.length; idx++) {
    const delta = prof.timeDeltas[idx] ?? 0;
    cursor += delta;
    if (cursor < winStart) continue;
    if (cursor > winEnd) break;
    const id = prof.samples[idx];
    windowSelfByNode.set(id, (windowSelfByNode.get(id) ?? 0) + delta);
    windowUsed += delta;
  }

  if (windowUsed === 0) {
    console.log();
    console.log(
      "No CPU samples landed inside the window (profiler may not have been running).",
    );
    return;
  }

  // Roll up each sample's cost up its parent chain for "total time".
  const totalByNode = new Map<number, number>();
  cursor = prof.startTime;
  for (let idx = 0; idx < prof.samples.length; idx++) {
    const delta = prof.timeDeltas[idx] ?? 0;
    cursor += delta;
    if (cursor < winStart) continue;
    if (cursor > winEnd) break;
    let cur: number | undefined = prof.samples[idx];
    const seen = new Set<number>();
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      totalByNode.set(cur, (totalByNode.get(cur) ?? 0) + delta);
      cur = parent.get(cur);
    }
  }

  printCpuRanking(
    `Top 25 functions by SELF time inside the window (CPU profile):`,
    byId,
    windowSelfByNode,
    totalByNode,
    windowUsed,
    "self",
  );
  printCpuRanking(
    `Top 20 functions by TOTAL time (includes descendants):`,
    byId,
    windowSelfByNode,
    totalByNode,
    windowUsed,
    "total",
  );

  // --- User-code hot list (skip three.js and native frames) ----------
  const isUserCode = (url: string): boolean =>
    url.startsWith("http://localhost:5173/src/") ||
    url.startsWith("https://localhost:5173/src/");

  const userRanking: Array<{ node: CpuNode; self: number; total: number }> = [];
  for (const node of byId.values()) {
    const url = node.callFrame.url ?? "";
    if (!isUserCode(url)) continue;
    userRanking.push({
      node,
      self: windowSelfByNode.get(node.id) ?? 0,
      total: totalByNode.get(node.id) ?? 0,
    });
  }
  userRanking.sort((a, b) => b.self - a.self);
  console.log();
  console.log("Top 20 USER-CODE functions by SELF time inside the window:");
  console.log(
    `  ${"self%".padStart(6)} ${"self(ms)".padStart(10)} ${"total(ms)".padStart(10)}  function`,
  );
  for (const r of userRanking.slice(0, 20)) {
    if (r.self === 0) break;
    const pct = (100 * r.self) / windowUsed;
    console.log(
      `  ${pct.toFixed(2).padStart(6)} ${(r.self / 1000).toFixed(2).padStart(10)} ${(r.total / 1000).toFixed(2).padStart(10)}  ${labelFrame(r.node.callFrame)}`,
    );
  }

  if (args.events !== null) {
    await loadAndPrintEvents(args.events, args.atS, args.windowMs);
  }
}

/**
 * Read the NDJSON event log and print game events inside the same
 * window as the trace spike.
 *
 * Timebase caveat: the event log uses `performance.now()` ms while
 * the trace uses `base::TimeTicks` µs — both are Chromium monotonic
 * clocks but with different origins. Since `startTrace` and the
 * first bus event both fire within the same setup phase, treating
 * "seconds since start of each file" as interchangeable is accurate
 * to within ~100ms. That's fine for "which game event lined up with
 * this spike?" — which is what this view is for.
 */
async function loadAndPrintEvents(
  path: string,
  atS: number,
  windowMs: number,
): Promise<void> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.log();
      console.log(`(no event log at ${path} — skipping game-event view)`);
      return;
    }
    throw err;
  }
  const lines = raw.trim().split("\n");
  if (lines.length < 2) {
    console.log();
    console.log(`(event log ${path} has no events)`);
    return;
  }
  const meta = JSON.parse(lines[0]) as EventLogMeta;
  if (!meta._meta) {
    throw new Error(`${path}: first line is not a meta record`);
  }

  // Filter events whose relative tMs falls within the spike window.
  // tMs is "ms since first recorded event"; compare directly against
  // atS ± windowMs/2 (treating both files as starting at roughly the
  // same wall-clock moment).
  const centerMs = atS * 1000;
  const halfMs = windowMs / 2;
  const winStartMs = centerMs - halfMs;
  const winEndMs = centerMs + halfMs;

  const hits: EventLogEntry[] = [];
  for (let idx = 1; idx < lines.length; idx++) {
    const entry = JSON.parse(lines[idx]) as EventLogEntry;
    if (entry.tMs < winStartMs || entry.tMs > winEndMs) continue;
    hits.push(entry);
  }

  console.log();
  console.log(
    `Game events in window (${hits.length} of ${meta.keptEvents} total, ±${halfMs.toFixed(0)}ms around t=${atS}s):`,
  );
  if (hits.length === 0) {
    console.log(
      "  (none — try widening --window or checking alignment against the trace)",
    );
    return;
  }
  for (const entry of hits) {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (key === "tMs" || key === "tAbsMs" || key === "seq" || key === "type")
        continue;
      payload[key] = value;
    }
    const payloadStr = formatPayload(payload);
    const tSec = (entry.tMs / 1000).toFixed(3).padStart(8);
    console.log(
      `  ${tSec}s  ${entry.type}${payloadStr ? `  ${payloadStr}` : ""}`,
    );
  }
}

function formatPayload(payload: Record<string, unknown>): string {
  // Keep one line per event. Drop nested objects (state snapshots,
  // player lists); show primitive fields only so the view stays
  // scannable.
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") continue;
    const str = String(value);
    parts.push(
      str.length > 40 ? `${key}=${str.slice(0, 40)}…` : `${key}=${str}`,
    );
    if (parts.length >= 6) {
      parts.push("…");
      break;
    }
  }
  return parts.join(" ");
}

function parseArgs(): Args {
  let trace = "tmp/perf/trace.json";
  let cpu = "tmp/perf/cpu.cpuprofile";
  let events: string | null = "tmp/perf/events.ndjson";
  let atS: number | null = null;
  let windowMs = 200;
  for (const arg of Deno.args) {
    if (arg.startsWith("--trace=")) trace = arg.slice(8);
    else if (arg.startsWith("--cpu=")) cpu = arg.slice(6);
    else if (arg.startsWith("--events=")) events = arg.slice(9);
    else if (arg === "--no-events") events = null;
    else if (arg.startsWith("--at=")) atS = Number(arg.slice(5));
    else if (arg.startsWith("--window=")) windowMs = Number(arg.slice(9));
  }
  if (atS === null || Number.isNaN(atS)) {
    throw new Error("--at=<seconds> is required");
  }
  return { trace, cpu, events, atS, windowMs };
}

function printNestedEvents(
  evs: TraceEvent[],
  winStart: number,
  ts0: number,
): void {
  console.log();
  console.log("Main-thread events in window (nested by containment):");
  // Build a depth stack: an event is a child of the most recent
  // still-open event that fully contains it.
  const stack: TraceEvent[] = [];
  let shown = 0;
  for (const ev of evs) {
    // Pop everything that ended before this event started.
    while (stack.length > 0) {
      const topEv = stack[stack.length - 1];
      if (topEv.ts + (topEv.dur ?? 0) < ev.ts) stack.pop();
      else break;
    }
    const depth = stack.length;
    // Skip the most trivial wrappers at depth 0 to reduce noise, but
    // always show RunTask / FireAnimationFrame / FunctionCall.
    const interesting =
      depth <= 4 &&
      (ev.dur ?? 0) >= 500 && // <0.5ms spans are noise
      !SKIP_NAMES.has(ev.name);
    if (interesting) {
      const tRel = ((ev.ts - ts0) / 1_000_000).toFixed(3).padStart(8);
      const dur = ((ev.dur ?? 0) / 1000).toFixed(2).padStart(7);
      const url =
        (ev.args?.data as Record<string, unknown> | undefined)?.url ?? "";
      const suffix = url ? `  ${String(url).split("?")[0]}` : "";
      console.log(
        `  ${tRel}s  ${dur}ms  ${"  ".repeat(depth)}${ev.name}${suffix}`,
      );
      shown++;
      if (shown >= 80) {
        console.log("  … (truncated)");
        break;
      }
    }
    stack.push(ev);
  }
}

function summarize(label: string, evs: TraceEvent[]): void {
  if (evs.length === 0) return;
  const total = evs.reduce((sum, ev) => sum + (ev.dur ?? 0), 0);
  const max = evs.reduce((m, ev) => Math.max(m, ev.dur ?? 0), 0);
  console.log(
    `  ${label}: ${evs.length}, total ${(total / 1000).toFixed(2)}ms, max ${(max / 1000).toFixed(2)}ms`,
  );
}

function printCpuRanking(
  title: string,
  byId: Map<number, CpuNode>,
  selfByNode: Map<number, number>,
  totalByNode: Map<number, number>,
  windowUsed: number,
  mode: "self" | "total",
): void {
  const rows = [...byId.values()]
    .map((node) => ({
      node,
      self: selfByNode.get(node.id) ?? 0,
      total: totalByNode.get(node.id) ?? 0,
    }))
    .filter((r) => r.self > 0 || r.total > 0);
  rows.sort((a, b) => b[mode] - a[mode]);
  console.log();
  console.log(title);
  console.log(
    `  ${"self%".padStart(6)} ${"total%".padStart(7)} ${"self(ms)".padStart(10)} ${"total(ms)".padStart(10)}  function`,
  );
  const limit = mode === "self" ? 25 : 20;
  for (const r of rows.slice(0, limit)) {
    if (r[mode] === 0) break;
    const selfPct = (100 * r.self) / windowUsed;
    const totalPct = (100 * r.total) / windowUsed;
    console.log(
      `  ${selfPct.toFixed(2).padStart(6)} ${totalPct.toFixed(2).padStart(7)} ${(r.self / 1000).toFixed(2).padStart(10)} ${(r.total / 1000).toFixed(2).padStart(10)}  ${labelFrame(r.node.callFrame)}`,
    );
  }
}

function labelFrame(frame: CallFrame): string {
  const fn = frame.functionName || "(anonymous)";
  const file = frame.url
    ? frame.url.replace(/^https?:\/\/[^/]+\//, "/").split("?")[0]
    : "";
  return file ? `${fn}  [${file}:${frame.lineNumber}]` : fn;
}
