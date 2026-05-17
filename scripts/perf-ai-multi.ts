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

interface SeedRun {
  seed: number;
  profilePath: string;
  framesPath: string;
}

interface FrameRecord {
  tick: number;
  phase: string;
  round: number;
  phaseBefore: string;
  roundBefore: number;
  wallMicros: number;
}

interface FrameRun {
  seed: number;
  mode: "classic" | "modern";
  rounds: number;
  ticks: number;
  wallMs: number;
  records: FrameRecord[];
}

interface PerSeedPhaseStats {
  totalMicros: number;
  maxTickMicros: number;
  count: number;
}

interface AcrossSeedPhaseAgg {
  /** Mean across seeds of (sum of per-tick wallMicros within this bucket). */
  meanTotalMicros: number;
  /** Worst-of-worst: max across seeds of (max single tick within bucket). */
  maxTickMicros: number;
  /** Mean across seeds of (count of ticks within bucket). */
  meanCount: number;
  /** Number of seeds that had any ticks in this bucket. */
  seedsWithBucket: number;
}

const OUT_DIR = "tmp/perf";

await main();

async function main(): Promise<void> {
  const args = parseArgs(Deno.args);
  await Deno.mkdir(OUT_DIR, { recursive: true });
  const runs = await runAllSeeds(args);
  console.log();
  console.log(
    `Aggregating ${runs.length} profiles (seeds ${args.startSeed}..${args.startSeed + args.seeds - 1}, ${args.rounds} rounds, ${args.mode})`,
  );
  const profiles = await Promise.all(
    runs.map(async ({ profilePath }) => {
      const raw = await Deno.readTextFile(profilePath);
      return JSON.parse(raw) as CpuProfile;
    }),
  );
  const frameRuns = await Promise.all(
    runs.map(async ({ seed, framesPath }) => {
      const raw = await Deno.readTextFile(framesPath);
      const parsed = JSON.parse(raw) as FrameRun;
      return { seed, run: parsed };
    }),
  );
  const stats = aggregate(profiles);
  report(stats, profiles, args.filter);
  reportFrames(frameRuns);
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

async function runAllSeeds(args: Args): Promise<SeedRun[]> {
  const runs: SeedRun[] = [];
  for (let offset = 0; offset < args.seeds; offset++) {
    const seed = args.startSeed + offset;
    const profileName = `ai-cpu-seed-${seed}.cpuprofile`;
    const profilePath = `${OUT_DIR}/${profileName}`;
    const framesPath = `${OUT_DIR}/ai-frames-seed-${seed}.json`;
    for (const path of [profilePath, framesPath]) {
      try {
        await Deno.remove(path);
      } catch {
        // ok if missing
      }
    }
    const t0 = performance.now();
    const cmd = new Deno.Command("deno", {
      args: [
        "run",
        "--cpu-prof",
        "--cpu-prof-dir",
        OUT_DIR,
        "--cpu-prof-name",
        profileName,
        "-A",
        "scripts/perf-ai-headless.ts",
        "--seed",
        String(seed),
        "--rounds",
        String(args.rounds),
        "--mode",
        args.mode,
        "--out",
        framesPath,
      ],
      stdout: "piped",
      stderr: "inherit",
    });
    const { code } = await cmd.output();
    const wall = performance.now() - t0;
    if (code !== 0) {
      throw new Error(`subprocess failed for seed=${seed} (exit ${code})`);
    }
    console.log(
      `  seed=${seed} done in ${wall.toFixed(0)} ms wall → ${profileName}`,
    );
    runs.push({ seed, profilePath, framesPath });
  }
  return runs;
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

function shortLabel(entry: FrameStats): string {
  const file = entry.url
    .replace(/^https?:\/\/[^/]+\//, "/")
    .replace(/^file:\/\//, "")
    .split("?")[0];
  return `${entry.functionName}  [${file}:${entry.line}]`;
}

function reportFrames(
  frameRuns: readonly { seed: number; run: FrameRun }[],
): void {
  if (frameRuns.length === 0) return;

  // Per (round, phase) bucketed by seed, then aggregated across seeds.
  const perSeedByKey = new Map<string, Map<number, PerSeedPhaseStats>>();
  for (const { seed, run } of frameRuns) {
    for (const rec of run.records) {
      const key = `${rec.round}|${rec.phase}`;
      let seedMap = perSeedByKey.get(key);
      if (seedMap === undefined) {
        seedMap = new Map();
        perSeedByKey.set(key, seedMap);
      }
      let bucket = seedMap.get(seed);
      if (bucket === undefined) {
        bucket = { totalMicros: 0, maxTickMicros: 0, count: 0 };
        seedMap.set(seed, bucket);
      }
      bucket.totalMicros += rec.wallMicros;
      if (rec.wallMicros > bucket.maxTickMicros)
        bucket.maxTickMicros = rec.wallMicros;
      bucket.count++;
    }
  }

  const aggregated = new Map<string, AcrossSeedPhaseAgg>();
  for (const [key, seedMap] of perSeedByKey) {
    let totalSum = 0;
    let countSum = 0;
    let maxTick = 0;
    for (const bucket of seedMap.values()) {
      totalSum += bucket.totalMicros;
      countSum += bucket.count;
      if (bucket.maxTickMicros > maxTick) maxTick = bucket.maxTickMicros;
    }
    aggregated.set(key, {
      meanTotalMicros: totalSum / seedMap.size,
      maxTickMicros: maxTick,
      meanCount: countSum / seedMap.size,
      seedsWithBucket: seedMap.size,
    });
  }

  const phaseOrder = [
    "CASTLE_SELECT",
    "WALL_BUILD",
    "CANNON_PLACE",
    "MODIFIER_REVEAL",
    "BATTLE",
    "UPGRADE_PICK",
  ];
  const rows = [...aggregated.entries()];
  rows.sort(([keyA], [keyB]) => {
    const [roundA, phaseA] = keyA.split("|");
    const [roundB, phaseB] = keyB.split("|");
    const roundCmp = Number(roundA) - Number(roundB);
    if (roundCmp !== 0) return roundCmp;
    return phaseOrder.indexOf(phaseA!) - phaseOrder.indexOf(phaseB!);
  });

  console.log();
  console.log(
    `Per (round, phase) across ${frameRuns.length} seeds — total/mean per game; max-tick is worst-of-worst:`,
  );
  console.log(
    `  ${"round".padStart(5)} ${"phase".padEnd(14)} ${"seeds".padStart(5)} ${"mean count".padStart(10)} ${"mean total(ms)".padStart(15)} ${"max-tick(ms)".padStart(13)}`,
  );
  for (const [key, agg] of rows) {
    const [round, phase] = key.split("|");
    console.log(
      `  ${String(round).padStart(5)} ${(phase ?? "?").padEnd(14)} ${String(agg.seedsWithBucket).padStart(5)} ${agg.meanCount.toFixed(1).padStart(10)} ${fmtMs(agg.meanTotalMicros).padStart(15)} ${fmtMs(agg.maxTickMicros).padStart(13)}`,
    );
  }

  // Top hitches across all seeds — pull (seed, tick) records from every run,
  // sort by wallMicros, take the top N.
  type WorstTick = {
    seed: number;
    tick: number;
    round: number;
    phase: string;
    phaseBefore: string;
    roundBefore: number;
    wallMicros: number;
  };
  const allTicks: WorstTick[] = [];
  for (const { seed, run } of frameRuns) {
    for (const rec of run.records) {
      allTicks.push({
        seed,
        tick: rec.tick,
        round: rec.round,
        phase: rec.phase,
        phaseBefore: rec.phaseBefore,
        roundBefore: rec.roundBefore,
        wallMicros: rec.wallMicros,
      });
    }
  }
  allTicks.sort((a, b) => b.wallMicros - a.wallMicros);
  const topN = Math.min(30, allTicks.length);
  console.log();
  console.log(`Top ${topN} hitches across all seeds:`);
  console.log(
    `  ${"seed".padStart(4)} ${"tick".padStart(6)} ${"r".padStart(2)} ${"phase".padEnd(14)} ${"wall(ms)".padStart(9)}  transition`,
  );
  for (let i = 0; i < topN; i++) {
    const item = allTicks[i]!;
    const transition =
      item.phaseBefore !== item.phase || item.roundBefore !== item.round
        ? `${item.roundBefore}/${item.phaseBefore} → ${item.round}/${item.phase}`
        : "";
    console.log(
      `  ${String(item.seed).padStart(4)} ${String(item.tick).padStart(6)} ${String(item.round).padStart(2)} ${item.phase.padEnd(14)} ${fmtMs(item.wallMicros).padStart(9)}  ${transition}`,
    );
  }

  // Per-seed "worst tick" highlight — easy to see which seed has the
  // single-frame pathology vs the slow-but-steady ones.
  console.log();
  console.log(`Worst tick per seed (sorted desc):`);
  const worstPerSeed: WorstTick[] = [];
  for (const { seed, run } of frameRuns) {
    let worst: WorstTick | null = null;
    for (const rec of run.records) {
      if (worst === null || rec.wallMicros > worst.wallMicros) {
        worst = {
          seed,
          tick: rec.tick,
          round: rec.round,
          phase: rec.phase,
          phaseBefore: rec.phaseBefore,
          roundBefore: rec.roundBefore,
          wallMicros: rec.wallMicros,
        };
      }
    }
    if (worst !== null) worstPerSeed.push(worst);
  }
  worstPerSeed.sort((a, b) => b.wallMicros - a.wallMicros);
  console.log(
    `  ${"seed".padStart(4)} ${"tick".padStart(6)} ${"r".padStart(2)} ${"phase".padEnd(14)} ${"wall(ms)".padStart(9)}`,
  );
  for (const item of worstPerSeed) {
    console.log(
      `  ${String(item.seed).padStart(4)} ${String(item.tick).padStart(6)} ${String(item.round).padStart(2)} ${item.phase.padEnd(14)} ${fmtMs(item.wallMicros).padStart(9)}`,
    );
  }
}

function fmtMs(micros: number): string {
  return (micros / 1000).toFixed(2);
}
