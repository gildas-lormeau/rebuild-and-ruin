/**
 * Analyze a V8 `.cpuprofile` captured by the E2E perf API
 * (`sc.perf.stopCpuProfile`).
 *
 * Computes per-function self-time (direct CPU cost) and total-time
 * (self + all descendants), and prints:
 *   - top 40 nodes by self-time
 *   - top 20 nodes by total-time (catches hot callsites whose children
 *     do the real work, e.g. `mainLoop`)
 *   - top 20 source files by aggregated self-time
 *
 * Usage: `deno run -A scripts/analyze-cpu.ts [path]`
 * Default path: `tmp/perf/cpu.cpuprofile`.
 */

interface CallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
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

const path = Deno.args[0] ?? "tmp/perf/cpu.cpuprofile";
const raw = await Deno.readTextFile(path);
const prof: CpuProfile = JSON.parse(raw);
const byId = new Map<number, CpuNode>();
// Parent lookup for total-time rollup.
const parent = new Map<number, number>();
const selfTime = new Map<number, number>();
// Roll up total-time along the parent chain.
const totalTime = new Map<number, number>();
// Sort nodes so leaves come first — simple approach: iterate enough times
// to fix-point, or do a post-order traversal. Easier: topological order
// via BFS from root (id 1 typically).
// Instead: aggregate by walking each sample up to root (O(samples * depth)).
const totalByNode = new Map<number, number>();
const totalMicros = prof.timeDeltas.reduce((sum, dt) => sum + dt, 0);
const totalMs = totalMicros / 1000;
// Rank by self-time.
const ranked = [...byId.values()]
  .map((node) => ({
    node,
    self: selfTime.get(node.id) ?? 0,
    total: totalByNode.get(node.id) ?? 0,
  }))
  .sort((a, b) => b.self - a.self)
  .slice(0, 40);
// Also rank by total-time (costs that roll up even if self-time is small).
const rankedTotal = [...byId.values()]
  .map((node) => ({
    node,
    self: selfTime.get(node.id) ?? 0,
    total: totalByNode.get(node.id) ?? 0,
  }))
  .filter((r) => {
    // Skip trivial roots. Keep interesting wrappers.
    const name = r.node.callFrame.functionName;
    return name !== "(root)" && name !== "(program)";
  })
  .sort((a, b) => b.total - a.total)
  .slice(0, 20);
// Bucket by URL (which file / bundle consumed CPU).
const byUrl = new Map<string, number>();
const byUrlRanked = [...byUrl.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20);

for (const node of prof.nodes) byId.set(node.id, node);

for (const node of prof.nodes) {
  for (const childId of node.children ?? []) parent.set(childId, node.id);
}

for (const node of prof.nodes) selfTime.set(node.id, 0);

for (let idx = 0; idx < prof.samples.length; idx++) {
  const id = prof.samples[idx];
  const dt = prof.timeDeltas[idx] ?? 0;
  selfTime.set(id, (selfTime.get(id) ?? 0) + dt);
}

for (const node of prof.nodes)
  totalTime.set(node.id, selfTime.get(node.id) ?? 0);

for (let idx = 0; idx < prof.samples.length; idx++) {
  const dt = prof.timeDeltas[idx] ?? 0;
  let cur: number | undefined = prof.samples[idx];
  const seen = new Set<number>();
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    totalByNode.set(cur, (totalByNode.get(cur) ?? 0) + dt);
    cur = parent.get(cur);
  }
}

console.log(`CPU profile: ${totalMs.toFixed(1)} ms sampled`);

console.log(`Nodes: ${prof.nodes.length}, Samples: ${prof.samples.length}`);

console.log();

console.log("Top 40 by SELF time (microseconds):");

console.log(
  `  ${"self%".padStart(6)} ${"total%".padStart(7)} ${"self(ms)".padStart(10)} ${"total(ms)".padStart(10)}  function`,
);

for (const r of ranked) {
  const selfPct = (100 * r.self) / totalMicros;
  const totalPct = (100 * r.total) / totalMicros;
  console.log(
    `  ${selfPct.toFixed(2).padStart(6)} ${totalPct.toFixed(2).padStart(7)} ${(r.self / 1000).toFixed(2).padStart(10)} ${(r.total / 1000).toFixed(2).padStart(10)}  ${label(r.node.callFrame)}`,
  );
}

console.log();

console.log("Top 20 by TOTAL time (includes descendants):");

console.log(
  `  ${"total%".padStart(7)} ${"self(ms)".padStart(10)} ${"total(ms)".padStart(10)}  function`,
);

for (const r of rankedTotal) {
  const totalPct = (100 * r.total) / totalMicros;
  console.log(
    `  ${totalPct.toFixed(2).padStart(7)} ${(r.self / 1000).toFixed(2).padStart(10)} ${(r.total / 1000).toFixed(2).padStart(10)}  ${label(r.node.callFrame)}`,
  );
}

function label(frame: CallFrame): string {
  const fn = frame.functionName || "(anonymous)";
  const file = frame.url
    ? frame.url.replace(/^https?:\/\/[^/]+\//, "/").split("?")[0]
    : "";
  return file ? `${fn}  [${file}:${frame.lineNumber}]` : fn;
}

for (const node of prof.nodes) {
  const url = node.callFrame.url || "(native)";
  const file = url.replace(/^https?:\/\/[^/]+\//, "/").split("?")[0];
  byUrl.set(file, (byUrl.get(file) ?? 0) + (selfTime.get(node.id) ?? 0));
}

console.log();

console.log("Top 20 files by SELF time:");

for (const [file, us] of byUrlRanked) {
  const pct = (100 * us) / totalMicros;
  console.log(
    `  ${pct.toFixed(2).padStart(6)}%  ${(us / 1000).toFixed(1).padStart(10)} ms  ${file || "(empty)"}`,
  );
}
