/**
 * Multi-seed CPU perf aggregation for AI work in headless scenarios.
 *
 * Spawns N deno subprocesses sequentially (one per seed) with native
 * `--cpu-prof` enabled. Each subprocess produces its own .cpuprofile.
 * After all runs complete, aggregates self-time per (url, function, line)
 * frame across profiles and prints mean / min / max / stddev.
 *
 * Sequential by design — running profilers in parallel inflates per-run
 * timings via CPU contention and produces noisy numbers. 20 × ~600ms wall
 * = ~12s, plus deno startup overhead per spawn.
 *
 * Usage:
 *   deno run -A scripts/perf-ai-multi.ts \
 *     [--seeds N] [--start-seed N] [--rounds N] [--mode classic|modern] \
 *     [--filter <substr>]
 *
 * Defaults: 20 seeds starting at 1, 4 rounds, classic mode, filter src/ai/.
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

interface FrameStats {
  url: string;
  functionName: string;
  line: number;
  selfMicrosPerRun: number[];
  totalMicrosPerRun: number[];
}

interface Args {
  seeds: number;
  startSeed: number;
  rounds: number;
  mode: "classic" | "modern";
  filter: string | undefined;
}

const OUT_DIR = "tmp/perf";

await main();

async function main(): Promise<void> {
  const args = parseArgs(Deno.args);
  await Deno.mkdir(OUT_DIR, { recursive: true });
  const profilePaths = await runAllSeeds(args);
  console.log();
  console.log(
    `Aggregating ${profilePaths.length} profiles (seeds ${args.startSeed}..${args.startSeed + args.seeds - 1}, ${args.rounds} rounds, ${args.mode})`,
  );
  const profiles = await Promise.all(
    profilePaths.map(async (path) => {
      const raw = await Deno.readTextFile(path);
      return JSON.parse(raw) as CpuProfile;
    }),
  );
  const stats = aggregate(profiles);
  report(stats, profiles, args.filter);
}

function parseArgs(raw: readonly string[]): Args {
  let seeds = 20;
  let startSeed = 1;
  let rounds = 4;
  let mode: "classic" | "modern" = "classic";
  let filter: string | undefined = "src/ai/";
  for (let idx = 0; idx < raw.length; idx++) {
    const arg = raw[idx];
    const next = raw[idx + 1];
    if (arg === "--seeds" && next !== undefined) {
      seeds = Number(next);
      idx++;
    } else if (arg === "--start-seed" && next !== undefined) {
      startSeed = Number(next);
      idx++;
    } else if (arg === "--rounds" && next !== undefined) {
      rounds = Number(next);
      idx++;
    } else if (arg === "--mode" && (next === "classic" || next === "modern")) {
      mode = next;
      idx++;
    } else if (arg === "--filter" && next !== undefined) {
      filter = next === "" ? undefined : next;
      idx++;
    }
  }
  return { seeds, startSeed, rounds, mode, filter };
}

async function runAllSeeds(args: Args): Promise<string[]> {
  const paths: string[] = [];
  for (let offset = 0; offset < args.seeds; offset++) {
    const seed = args.startSeed + offset;
    const name = `ai-cpu-seed-${seed}.cpuprofile`;
    const path = `${OUT_DIR}/${name}`;
    try {
      await Deno.remove(path);
    } catch {
      // ok if missing
    }
    const t0 = performance.now();
    const cmd = new Deno.Command("deno", {
      args: [
        "run",
        "--cpu-prof",
        "--cpu-prof-dir",
        OUT_DIR,
        "--cpu-prof-name",
        name,
        "-A",
        "scripts/perf-ai-headless.ts",
        "--seed",
        String(seed),
        "--rounds",
        String(args.rounds),
        "--mode",
        args.mode,
      ],
      stdout: "piped",
      stderr: "inherit",
    });
    const { code } = await cmd.output();
    const wall = performance.now() - t0;
    if (code !== 0) {
      throw new Error(`subprocess failed for seed=${seed} (exit ${code})`);
    }
    console.log(`  seed=${seed} done in ${wall.toFixed(0)} ms wall → ${name}`);
    paths.push(path);
  }
  return paths;
}

function aggregate(profiles: readonly CpuProfile[]): Map<string, FrameStats> {
  const stats = new Map<string, FrameStats>();
  for (let runIdx = 0; runIdx < profiles.length; runIdx++) {
    const profile = profiles[runIdx];
    const { selfTime, totalByNode, byKey } = perRunBreakdown(profile);
    for (const [key, { url, functionName, line }] of byKey) {
      let entry = stats.get(key);
      if (entry === undefined) {
        entry = {
          url,
          functionName,
          line,
          selfMicrosPerRun: new Array(profiles.length).fill(0),
          totalMicrosPerRun: new Array(profiles.length).fill(0),
        };
        stats.set(key, entry);
      }
      const frameSelf = selfTime.get(key) ?? 0;
      const frameTotal = totalByNode.get(key) ?? 0;
      entry.selfMicrosPerRun[runIdx] = frameSelf;
      entry.totalMicrosPerRun[runIdx] = frameTotal;
    }
  }
  return stats;
}

function perRunBreakdown(profile: CpuProfile): {
  selfTime: Map<string, number>;
  totalByNode: Map<string, number>;
  byKey: Map<string, { url: string; functionName: string; line: number }>;
} {
  const byId = new Map<number, CpuNode>();
  for (const node of profile.nodes) byId.set(node.id, node);

  const parentOf = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const childId of node.children ?? []) parentOf.set(childId, node.id);
  }

  const keyOfNode = new Map<number, string>();
  const byKey = new Map<
    string,
    { url: string; functionName: string; line: number }
  >();
  for (const node of profile.nodes) {
    const frame = node.callFrame;
    const url = frame.url || "(native)";
    const name = frame.functionName || "(anonymous)";
    const key = `${url}|${name}|${frame.lineNumber}`;
    keyOfNode.set(node.id, key);
    if (!byKey.has(key)) {
      byKey.set(key, { url, functionName: name, line: frame.lineNumber });
    }
  }

  const selfByNode = new Map<number, number>();
  for (let idx = 0; idx < profile.samples.length; idx++) {
    const id = profile.samples[idx];
    const dt = profile.timeDeltas[idx] ?? 0;
    selfByNode.set(id, (selfByNode.get(id) ?? 0) + dt);
  }

  const totalByNodeId = new Map<number, number>();
  for (let idx = 0; idx < profile.samples.length; idx++) {
    const dt = profile.timeDeltas[idx] ?? 0;
    let cur: number | undefined = profile.samples[idx];
    const seen = new Set<number>();
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      totalByNodeId.set(cur, (totalByNodeId.get(cur) ?? 0) + dt);
      cur = parentOf.get(cur);
    }
  }

  const selfByKey = new Map<string, number>();
  for (const [nodeId, micros] of selfByNode) {
    const key = keyOfNode.get(nodeId);
    if (key === undefined) continue;
    selfByKey.set(key, (selfByKey.get(key) ?? 0) + micros);
  }
  const totalByKey = new Map<string, number>();
  for (const [nodeId, micros] of totalByNodeId) {
    const key = keyOfNode.get(nodeId);
    if (key === undefined) continue;
    totalByKey.set(key, (totalByKey.get(key) ?? 0) + micros);
  }

  return { selfTime: selfByKey, totalByNode: totalByKey, byKey };
}

function report(
  stats: Map<string, FrameStats>,
  profiles: readonly CpuProfile[],
  filter: string | undefined,
): void {
  const profileTotals = profiles.map((profile) =>
    profile.timeDeltas.reduce((sum, dt) => sum + dt, 0),
  );
  const meanProfileMicros =
    profileTotals.reduce((sum, micros) => sum + micros, 0) / profiles.length;

  const filtered = [...stats.values()].filter((entry) => {
    if (filter === undefined) return true;
    return entry.url.includes(filter);
  });

  const annotated = filtered
    .map((entry) => {
      const stats = summarize(entry.selfMicrosPerRun);
      const totalStats = summarize(entry.totalMicrosPerRun);
      return { entry, self: stats, total: totalStats };
    })
    .filter(({ entry }) => {
      // Skip program/root meta nodes.
      const name = entry.functionName;
      return name !== "(root)" && name !== "(program)" && name !== "(idle)";
    });

  const bySelfMean = [...annotated]
    .sort((a, b) => b.self.mean - a.self.mean)
    .slice(0, 40);
  const byTotalMean = [...annotated]
    .sort((a, b) => b.total.mean - a.total.mean)
    .slice(0, 20);

  const filteredMeanMicros = annotated.reduce(
    (sum, item) => sum + item.self.mean,
    0,
  );
  const filteredPct =
    meanProfileMicros > 0 ? (100 * filteredMeanMicros) / meanProfileMicros : 0;

  console.log();
  console.log(
    `Mean profile total: ${(meanProfileMicros / 1000).toFixed(1)} ms sampled per run`,
  );
  if (filter !== undefined) {
    console.log(
      `Filter "${filter}" mean self-time: ${(filteredMeanMicros / 1000).toFixed(1)} ms (${filteredPct.toFixed(2)}% of profile)`,
    );
  }
  console.log();

  console.log(
    `Top 40 by MEAN SELF time across ${profiles.length} runs${filter ? ` (filter "${filter}")` : ""}:`,
  );
  console.log(
    `  ${"mean(ms)".padStart(9)} ${"min".padStart(7)} ${"max".padStart(7)} ${"stddev".padStart(7)}  function`,
  );
  for (const item of bySelfMean) {
    console.log(
      `  ${fmtMs(item.self.mean).padStart(9)} ${fmtMs(item.self.min).padStart(7)} ${fmtMs(item.self.max).padStart(7)} ${fmtMs(item.self.stddev).padStart(7)}  ${shortLabel(item.entry)}`,
    );
  }
  console.log();

  console.log(
    `Top 20 by MEAN TOTAL time (self + descendants)${filter ? ` (filter "${filter}")` : ""}:`,
  );
  console.log(
    `  ${"mean(ms)".padStart(9)} ${"min".padStart(7)} ${"max".padStart(7)} ${"stddev".padStart(7)}  function`,
  );
  for (const item of byTotalMean) {
    console.log(
      `  ${fmtMs(item.total.mean).padStart(9)} ${fmtMs(item.total.min).padStart(7)} ${fmtMs(item.total.max).padStart(7)} ${fmtMs(item.total.stddev).padStart(7)}  ${shortLabel(item.entry)}`,
    );
  }
}

function summarize(micros: readonly number[]): {
  mean: number;
  min: number;
  max: number;
  stddev: number;
} {
  if (micros.length === 0) {
    return { mean: 0, min: 0, max: 0, stddev: 0 };
  }
  const mean = micros.reduce((sum, micros) => sum + micros, 0) / micros.length;
  let min = micros[0];
  let max = micros[0];
  let sumSq = 0;
  for (const value of micros) {
    if (value < min) min = value;
    if (value > max) max = value;
    const dev = value - mean;
    sumSq += dev * dev;
  }
  const stddev = Math.sqrt(sumSq / micros.length);
  return { mean, min, max, stddev };
}

function fmtMs(micros: number): string {
  return (micros / 1000).toFixed(2);
}

function shortLabel(entry: FrameStats): string {
  const file = entry.url
    .replace(/^https?:\/\/[^/]+\//, "/")
    .replace(/^file:\/\//, "")
    .split("?")[0];
  return `${entry.functionName}  [${file}:${entry.line}]`;
}
