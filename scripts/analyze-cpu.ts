/**
 * Analyze a V8 `.cpuprofile` captured by `deno run --cpu-prof` or the E2E
 * perf API (`sc.perf.stopCpuProfile`).
 *
 * Computes per-function self-time (direct CPU cost) and total-time
 * (self + all descendants), and prints:
 *   - top 40 nodes by self-time
 *   - top 20 nodes by total-time (catches hot callsites whose children
 *     do the real work, e.g. `mainLoop`)
 *   - top 20 source files by aggregated self-time
 *
 * Usage: `deno run -A scripts/analyze-cpu.ts [path] [--filter <substr>]`
 * Default path: `tmp/perf/cpu.cpuprofile`.
 *
 * `--filter <substr>` scopes the function-level rankings (top SELF / top
 * TOTAL) to frames whose script URL contains the substring — e.g.
 * `--filter src/ai/` to isolate AI self-time. Percentages still use the
 * full-profile denominator, so they read as "% of total profile CPU".
 * The file-level rollup is always unfiltered.
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

interface Analysis {
  selfTime: Map<number, number>;
  totalByNode: Map<number, number>;
  byUrl: Map<string, number>;
  totalMicros: number;
}

await main();

async function main(): Promise<void> {
  const { path, filter } = parseArgs(Deno.args);
  const raw = await Deno.readTextFile(path);
  const prof: CpuProfile = JSON.parse(raw);
  const analysis = analyze(prof);
  printReport(prof, analysis, filter);
}

function parseArgs(raw: readonly string[]): {
  path: string;
  filter: string | undefined;
} {
  let path: string | undefined;
  let filter: string | undefined;
  for (let idx = 0; idx < raw.length; idx++) {
    const arg = raw[idx];
    if (arg === "--filter") {
      filter = raw[idx + 1];
      idx++;
    } else if (path === undefined && !arg.startsWith("--")) {
      path = arg;
    }
  }
  return { path: path ?? "tmp/perf/cpu.cpuprofile", filter };
}

function analyze(prof: CpuProfile): Analysis {
  const byId = new Map<number, CpuNode>();
  for (const node of prof.nodes) byId.set(node.id, node);

  const parentOf = new Map<number, number>();
  for (const node of prof.nodes) {
    for (const childId of node.children ?? []) parentOf.set(childId, node.id);
  }

  const selfTime = new Map<number, number>();
  for (const node of prof.nodes) selfTime.set(node.id, 0);
  for (let idx = 0; idx < prof.samples.length; idx++) {
    const id = prof.samples[idx];
    const dt = prof.timeDeltas[idx] ?? 0;
    selfTime.set(id, (selfTime.get(id) ?? 0) + dt);
  }

  const totalByNode = new Map<number, number>();
  for (let idx = 0; idx < prof.samples.length; idx++) {
    const dt = prof.timeDeltas[idx] ?? 0;
    let cur: number | undefined = prof.samples[idx];
    const seen = new Set<number>();
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      totalByNode.set(cur, (totalByNode.get(cur) ?? 0) + dt);
      cur = parentOf.get(cur);
    }
  }

  const byUrl = new Map<string, number>();
  for (const node of prof.nodes) {
    const url = node.callFrame.url || "(native)";
    const file = url.replace(/^https?:\/\/[^/]+\//, "/").split("?")[0];
    byUrl.set(file, (byUrl.get(file) ?? 0) + (selfTime.get(node.id) ?? 0));
  }

  const totalMicros = prof.timeDeltas.reduce((sum, dt) => sum + dt, 0);
  return { selfTime, totalByNode, byUrl, totalMicros };
}

function printReport(
  prof: CpuProfile,
  a: Analysis,
  filter: string | undefined,
): void {
  const { selfTime, totalByNode, byUrl, totalMicros } = a;
  const totalMs = totalMicros / 1000;
  const matchesFilter = (node: CpuNode): boolean =>
    filter === undefined || (node.callFrame.url ?? "").includes(filter);

  const entries = prof.nodes.map((node) => ({
    node,
    self: selfTime.get(node.id) ?? 0,
    total: totalByNode.get(node.id) ?? 0,
  }));
  const filtered = entries.filter((entry) => matchesFilter(entry.node));
  const ranked = [...filtered].sort((a, b) => b.self - a.self).slice(0, 40);
  const rankedTotal = filtered
    .filter((entry) => {
      const name = entry.node.callFrame.functionName;
      return name !== "(root)" && name !== "(program)";
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 20);
  const byUrlRanked = [...byUrl.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  console.log(`CPU profile: ${totalMs.toFixed(1)} ms sampled`);
  console.log(`Nodes: ${prof.nodes.length}, Samples: ${prof.samples.length}`);
  if (filter !== undefined) {
    const filteredSelf = filtered.reduce((sum, entry) => sum + entry.self, 0);
    const pct = totalMicros > 0 ? (100 * filteredSelf) / totalMicros : 0;
    console.log(
      `Filter: "${filter}" — ${(filteredSelf / 1000).toFixed(1)} ms self-time (${pct.toFixed(2)}% of profile) across ${filtered.length} frames`,
    );
  }
  console.log();

  console.log(
    `Top 40 by SELF time (${filter !== undefined ? `filtered "${filter}"` : "unfiltered"}):`,
  );
  console.log(
    `  ${"self%".padStart(6)} ${"total%".padStart(7)} ${"self(ms)".padStart(10)} ${"total(ms)".padStart(10)}  function`,
  );
  for (const entry of ranked) {
    const selfPct = totalMicros > 0 ? (100 * entry.self) / totalMicros : 0;
    const totalPct = totalMicros > 0 ? (100 * entry.total) / totalMicros : 0;
    console.log(
      `  ${selfPct.toFixed(2).padStart(6)} ${totalPct.toFixed(2).padStart(7)} ${(entry.self / 1000).toFixed(2).padStart(10)} ${(entry.total / 1000).toFixed(2).padStart(10)}  ${label(entry.node.callFrame)}`,
    );
  }
  console.log();

  console.log(
    `Top 20 by TOTAL time (${filter !== undefined ? `filtered "${filter}"` : "unfiltered"}):`,
  );
  console.log(
    `  ${"total%".padStart(7)} ${"self(ms)".padStart(10)} ${"total(ms)".padStart(10)}  function`,
  );
  for (const entry of rankedTotal) {
    const totalPct = totalMicros > 0 ? (100 * entry.total) / totalMicros : 0;
    console.log(
      `  ${totalPct.toFixed(2).padStart(7)} ${(entry.self / 1000).toFixed(2).padStart(10)} ${(entry.total / 1000).toFixed(2).padStart(10)}  ${label(entry.node.callFrame)}`,
    );
  }
  console.log();

  console.log("Top 20 files by SELF time (unfiltered):");
  for (const [file, us] of byUrlRanked) {
    const pct = totalMicros > 0 ? (100 * us) / totalMicros : 0;
    console.log(
      `  ${pct.toFixed(2).padStart(6)}%  ${(us / 1000).toFixed(1).padStart(10)} ms  ${file || "(empty)"}`,
    );
  }
}

function label(frame: CallFrame): string {
  const fn = frame.functionName || "(anonymous)";
  const file = frame.url
    ? frame.url.replace(/^https?:\/\/[^/]+\//, "/").split("?")[0]
    : "";
  return file ? `${fn}  [${file}:${frame.lineNumber}]` : fn;
}
