/**
 * Analyze a Chrome DevTools `trace.json` captured by the E2E perf API
 * (`sc.perf.stopTrace`). Reports:
 *   - event-name histogram (what categories the trace covered)
 *   - long tasks (≥50ms main-thread complete events)
 *   - layout / style-recalc / paint / composite / GPU totals
 *   - GC events (count + total + longest 10)
 *   - script-call events >10ms, keyed by source URL (catches hot RAF
 *     callbacks like `mainLoop`)
 *
 * Traces can be hundreds of MB; run with extra heap, e.g.
 *   `deno run -A --v8-flags=--max-old-space-size=8192 scripts/analyze-trace.ts [path]`
 * Default path: `tmp/perf/trace.json`.
 */

interface TraceEvent {
  name: string;
  cat: string;
  ph: string; // phase: B=begin, E=end, X=complete(w/ dur), I=instant, b/e=async, M=metadata
  ts: number; // microseconds
  dur?: number;
  pid: number;
  tid: number;
  args?: Record<string, unknown>;
}

const path = Deno.args[0] ?? "tmp/perf/trace.json";
const raw = await Deno.readTextFile(path);
const trace = JSON.parse(raw) as { traceEvents: TraceEvent[] };
const events = trace.traceEvents;
// Histogram of event names (just to see what categories we captured).
const nameCounts = new Map<string, number>();
const topNames = [...nameCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 25);
// --- Long tasks (main thread >50ms) -----------------------------------
// Name "RunTask" for Chromium task units, or use "EventDispatch" chains.
// Simpler proxy: find all 'X' (Complete) events on main renderer thread
// with dur >= 50ms.
const longTasks = events.filter(
  (ev) => ev.ph === "X" && typeof ev.dur === "number" && ev.dur >= 50_000,
);
// --- Frame timing --------------------------------------------------------
// Frames ("DrawFrame" / "BeginFrame" / "Frame") are emitted per render.
// Chrome uses "Frame" instants with frame seq + "DrawFrame" durations.
// Use "DrawFrame" complete events (ph=X) for frame-time distribution.
const frames = events.filter(
  (ev) =>
    ev.name === "DrawFrame" && ev.ph === "X" && typeof ev.dur === "number",
);
// --- Forced synchronous layout / reflow --------------------------------
// Look for "Layout" events — if their start ts falls INSIDE a larger
// "EvaluateScript"/"FunctionCall" parent, it was a sync forced reflow.
// Simpler: count Layout events by duration. Real forced-reflow detection
// needs the stack, which is in the CPU profile; for the trace we
// just report totals.
const layouts = events.filter(
  (ev) => ev.name === "Layout" && ev.ph === "X" && typeof ev.dur === "number",
);
const layoutTotal = layouts.reduce((sum, ev) => sum + (ev.dur ?? 0), 0);
const recalcs = events.filter(
  (ev) =>
    ev.name === "UpdateLayoutTree" &&
    ev.ph === "X" &&
    typeof ev.dur === "number",
);
const recalcTotal = recalcs.reduce((sum, ev) => sum + (ev.dur ?? 0), 0);
// --- Paint / Composite / GPU ------------------------------------------
const paints = events.filter(
  (ev) => ev.name === "Paint" && ev.ph === "X" && typeof ev.dur === "number",
);
const paintTotal = paints.reduce((sum, ev) => sum + (ev.dur ?? 0), 0);
const composites = events.filter(
  (ev) =>
    (ev.name === "CompositeLayers" || ev.name === "Commit") &&
    ev.ph === "X" &&
    typeof ev.dur === "number",
);
const compositeTotal = composites.reduce((sum, ev) => sum + (ev.dur ?? 0), 0);
const gpuTasks = events.filter(
  (ev) => ev.name === "GPUTask" && ev.ph === "X" && typeof ev.dur === "number",
);
const gpuTotal = gpuTasks.reduce((sum, ev) => sum + (ev.dur ?? 0), 0);
// --- GC pressure -------------------------------------------------------
const gcs = events.filter(
  (ev) =>
    (ev.name === "MajorGC" ||
      ev.name === "MinorGC" ||
      ev.name.startsWith("V8.GC")) &&
    typeof ev.dur === "number",
);
const gcTotal = gcs.reduce((sum, ev) => sum + (ev.dur ?? 0), 0);
const majors = gcs.filter(
  (ev) => ev.name === "MajorGC" || ev.name.includes("Full"),
);
const minors = gcs.filter(
  (ev) => ev.name === "MinorGC" || ev.name.includes("Scavenge"),
);
// --- Long-running EvaluateScript / FunctionCall -------------------------
const scripts = events.filter(
  (ev) =>
    (ev.name === "EvaluateScript" ||
      ev.name === "FunctionCall" ||
      ev.name === "V8.ScriptCompiler") &&
    ev.ph === "X" &&
    typeof ev.dur === "number" &&
    (ev.dur ?? 0) > 10_000,
);

console.log("Reading trace…");

console.log(`Raw size: ${(raw.length / 1024 / 1024).toFixed(1)} MB. Parsing…`);

console.log(`Events: ${events.length.toLocaleString()}`);

for (const ev of events) {
  nameCounts.set(ev.name, (nameCounts.get(ev.name) ?? 0) + 1);
}

console.log();

console.log("Top 25 event names by count:");

for (const [name, count] of topNames) {
  console.log(`  ${count.toString().padStart(8)}  ${name}`);
}

longTasks.sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0));

console.log();

console.log(`Long tasks (≥50ms complete events): ${longTasks.length}`);

for (const ev of longTasks.slice(0, 30)) {
  console.log(
    `  ${((ev.dur ?? 0) / 1000).toFixed(1).padStart(7)} ms  [${ev.cat}]  ${ev.name}`,
  );
}

if (frames.length > 0) {
  const frameDurs = frames.map((f) => f.dur ?? 0).sort((a, b) => a - b);
  const median = frameDurs[Math.floor(frameDurs.length / 2)] ?? 0;
  const p95 = frameDurs[Math.floor(frameDurs.length * 0.95)] ?? 0;
  const p99 = frameDurs[Math.floor(frameDurs.length * 0.99)] ?? 0;
  const max = frameDurs[frameDurs.length - 1] ?? 0;
  const over16 = frameDurs.filter((d) => d > 16_667).length;
  const over33 = frameDurs.filter((d) => d > 33_333).length;
  console.log();
  console.log(`DrawFrame events: ${frames.length}`);
  console.log(
    `  median=${(median / 1000).toFixed(2)} ms  p95=${(p95 / 1000).toFixed(2)} ms  p99=${(p99 / 1000).toFixed(2)} ms  max=${(max / 1000).toFixed(2)} ms`,
  );
  console.log(
    `  over 16.7ms (missed 60fps): ${over16} (${((100 * over16) / frames.length).toFixed(1)}%)`,
  );
  console.log(
    `  over 33.3ms (missed 30fps): ${over33} (${((100 * over33) / frames.length).toFixed(1)}%)`,
  );
}

console.log();

console.log(
  `Layout events: ${layouts.length}, total ${(layoutTotal / 1000).toFixed(1)} ms`,
);

console.log(
  `Style recalc events: ${recalcs.length}, total ${(recalcTotal / 1000).toFixed(1)} ms`,
);

console.log();

console.log(
  `Paint events: ${paints.length}, total ${(paintTotal / 1000).toFixed(1)} ms`,
);

console.log(
  `Composite/Commit events: ${composites.length}, total ${(compositeTotal / 1000).toFixed(1)} ms`,
);

console.log(
  `GPU tasks: ${gpuTasks.length}, total ${(gpuTotal / 1000).toFixed(1)} ms`,
);

console.log();

console.log(
  `GC events: ${gcs.length}, total ${(gcTotal / 1000).toFixed(1)} ms`,
);

console.log(`  Major-ish: ${majors.length}, Minor-ish: ${minors.length}`);

if (gcs.length > 0) {
  const longestGcs = [...gcs]
    .sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))
    .slice(0, 10);
  console.log("  Longest 10 GCs:");
  for (const ev of longestGcs) {
    console.log(
      `    ${((ev.dur ?? 0) / 1000).toFixed(2).padStart(7)} ms  ${ev.name}`,
    );
  }
}

scripts.sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0));

console.log();

console.log(`Script/FunctionCall events >10ms: ${scripts.length}`);

for (const ev of scripts.slice(0, 20)) {
  const url = (ev.args?.data as Record<string, unknown> | undefined)?.url ?? "";
  console.log(
    `  ${((ev.dur ?? 0) / 1000).toFixed(1).padStart(7)} ms  ${ev.name}  ${String(url).split("?")[0]}`,
  );
}
