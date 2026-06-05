/**
 * Multi-seed E2E perf sweep — runs the e2e-perf test N times with N
 * different seeds, captures one trace.json + cpu.cpuprofile per seed,
 * and aggregates which seeds exhibit the shader-compile hitch.
 *
 * For each seed:
 *   1. Spawn `deno test test/e2e/perf.test.ts` with PERF_SEED + PERF_OUT_DIR
 *      so the test writes to a per-seed directory.
 *   2. Run analyze-perf-peaks on the trace to find the worst-frame window.
 *   3. Run analyze-perf-window at that window's t to see whether
 *      getProgramInfoLog dominates self-time (shader compile signature).
 *
 * Sequential — the browser opens a real canvas + shares port 5173 with
 * the dev server; running these in parallel would skew GPU timings.
 *
 * Usage:
 *   deno run -A scripts/perf-e2e-multi.ts \
 *     [--seeds N] [--start-seed N] [--rounds N]
 *
 * Defaults: 10 seeds starting at 1, 1 round per run.
 * Requires: npm run dev (vite on 5173).
 */

interface Args {
  seeds: number;
  startSeed: number;
  rounds: number;
  fastMode: boolean;
}

interface TopFn {
  fn: string;
  selfMs: number;
  selfPct: number;
}

interface SeedResult {
  seed: number;
  ok: boolean;
  worstFrameMs: number;
  worstWindowT: number;
  worstWindowCpu: number;
  worstWindowGpu: number;
  /** Top 5 self-time functions inside the worst-frame window. */
  topFns: TopFn[];
  outDir: string;
}

const BASE_OUT = "tmp/perf";

await main();

async function main(): Promise<void> {
  const args = parseArgs(Deno.args);
  console.log(
    `Plan: ${args.seeds} seeds × ${args.rounds} round${args.rounds === 1 ? "" : "s"}, fastMode=${args.fastMode}`,
  );
  const results: SeedResult[] = [];
  for (let offset = 0; offset < args.seeds; offset++) {
    const seed = args.startSeed + offset;
    const outDir = `${BASE_OUT}/e2e-seed-${seed}`;
    await Deno.mkdir(outDir, { recursive: true });
    console.log(
      `\n=== seed=${seed} (run ${offset + 1}/${args.seeds}) → ${outDir} ===`,
    );
    const runOk = await runSingleSeed(seed, args.rounds, outDir, args.fastMode);
    if (!runOk) {
      results.push(failedResult(seed, outDir));
      continue;
    }
    const analyzed = await analyzeSeed(seed, outDir);
    results.push(analyzed);
    // Eager incremental summary line so we see progress.
    printSeedLine(analyzed);
  }
  printSummary(results);
}

function parseArgs(raw: readonly string[]): Args {
  let seeds = 10;
  let startSeed = 1;
  let rounds = 1;
  let fastMode = false;
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
    } else if (arg === "--fast") {
      fastMode = true;
    }
  }
  return { seeds, startSeed, rounds, fastMode };
}

async function runSingleSeed(
  seed: number,
  rounds: number,
  outDir: string,
  fastMode: boolean,
): Promise<boolean> {
  const t0 = performance.now();
  const env: Record<string, string> = {
    PERF_SEED: String(seed),
    PERF_ROUNDS: String(rounds),
    PERF_OUT_DIR: outDir,
  };
  if (fastMode) env.PERF_FAST = "1";
  const cmd = new Deno.Command("deno", {
    args: ["test", "--no-check", "-A", "test/e2e/perf.test.ts"],
    env,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  const wall = performance.now() - t0;
  if (code !== 0) {
    console.error(
      `  seed=${seed} FAILED (exit ${code}) in ${wall.toFixed(0)}ms`,
    );
    const out = new TextDecoder().decode(stdout);
    const err = new TextDecoder().decode(stderr);
    if (out.length > 0)
      console.error(`  stdout tail:\n${out.split("\n").slice(-10).join("\n")}`);
    if (err.length > 0)
      console.error(`  stderr tail:\n${err.split("\n").slice(-10).join("\n")}`);
    return false;
  }
  console.log(`  seed=${seed} run done in ${(wall / 1000).toFixed(1)}s`);
  return true;
}

async function analyzeSeed(seed: number, outDir: string): Promise<SeedResult> {
  const tracePath = `${outDir}/trace.json`;
  const cpuPath = `${outDir}/cpu.cpuprofile`;

  // Step 1: peaks → find the t and worstFrame for the worst window.
  const peaksCmd = new Deno.Command("deno", {
    args: [
      "run",
      "-A",
      "--v8-flags=--max-old-space-size=8192",
      "scripts/analyze-perf-peaks.ts",
      tracePath,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const peaksOut = await peaksCmd.output();
  if (peaksOut.code !== 0) {
    console.error(`  seed=${seed} peaks analysis failed`);
    return failedResult(seed, outDir);
  }
  const peaksText = new TextDecoder().decode(peaksOut.stdout);
  const topWindow = parseTopWindow(peaksText);
  if (topWindow === null) {
    console.error(`  seed=${seed} could not parse peaks output`);
    return failedResult(seed, outDir);
  }

  // Step 2: window → look up the top self-time function at the peak.
  const windowCmd = new Deno.Command("deno", {
    args: [
      "run",
      "-A",
      "--v8-flags=--max-old-space-size=8192",
      "scripts/analyze-perf-window.ts",
      `--at=${topWindow.t}`,
      "--window=400",
      `--trace=${tracePath}`,
      `--cpu=${cpuPath}`,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const windowOut = await windowCmd.output();
  if (windowOut.code !== 0) {
    console.error(`  seed=${seed} window analysis failed`);
    return failedResult(seed, outDir);
  }
  const windowText = new TextDecoder().decode(windowOut.stdout);
  const topFns = parseTopSelfFns(windowText, 5);

  return {
    seed,
    ok: true,
    worstFrameMs: topWindow.worstFrame,
    worstWindowT: topWindow.t,
    worstWindowCpu: topWindow.cpu,
    worstWindowGpu: topWindow.gpu,
    topFns,
    outDir,
  };
}

function failedResult(seed: number, outDir: string): SeedResult {
  return {
    seed,
    ok: false,
    worstFrameMs: 0,
    worstWindowT: 0,
    worstWindowCpu: 0,
    worstWindowGpu: 0,
    topFns: [],
    outDir,
  };
}

/** Parse the first TOP CPU-PEAK row from analyze-perf-peaks output.
 *  Sample line:
 *    t=  40.60s  cpu= 327.7ms (328%)  gpu= 128.9ms (129%)  ...  worstFrame=327.2ms
 */
function parseTopWindow(
  text: string,
): { t: number; cpu: number; gpu: number; worstFrame: number } | null {
  // Find the section header, then the first data row.
  const lines = text.split("\n");
  let inSection = false;
  for (const line of lines) {
    if (line.includes("TOP") && line.includes("CPU-PEAK")) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    const match = line.match(
      /t=\s*([\d.]+)s\s+cpu=\s*([\d.]+)ms.*?gpu=\s*([\d.]+)ms.*?worstFrame=([\d.]+)ms/,
    );
    if (match) {
      return {
        t: Number(match[1]),
        cpu: Number(match[2]),
        gpu: Number(match[3]),
        worstFrame: Number(match[4]),
      };
    }
  }
  return null;
}

/** Parse the top N SELF rows from the CPU-profile self-time table.
 *  Sample line:
 *     56.52   56.52     225.87     225.87  getProgramInfoLog
 *  Columns: self%, total%, self(ms), total(ms), function */
function parseTopSelfFns(text: string, topN: number): TopFn[] {
  const result: TopFn[] = [];
  const lines = text.split("\n");
  let inSection = false;
  for (const line of lines) {
    if (line.includes("functions by SELF time")) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    // Skip header line "self% total% self(ms) total(ms) function"
    if (/^\s*self%/.test(line)) continue;
    const match = line.match(
      /^\s*([\d.]+)\s+[\d.]+\s+([\d.]+)\s+[\d.]+\s+(.+?)\s*$/,
    );
    if (match) {
      result.push({
        selfPct: Number(match[1]),
        selfMs: Number(match[2]),
        fn: match[3]!.trim(),
      });
      if (result.length >= topN) return result;
      continue;
    }
    // Stop if we hit a blank/section break after we've started collecting.
    if (result.length > 0 && line.trim() === "") return result;
  }
  return result;
}

function printSummary(results: readonly SeedResult[]): void {
  console.log();
  console.log("=== E2E perf sweep summary ===");
  for (const r of results) printSeedLine(r);

  const ok = results.filter((r) => r.ok);
  if (ok.length === 0) return;

  console.log();
  console.log("Per-seed top-5 self functions inside the worst-frame window:");
  for (const r of ok) {
    console.log(
      `  seed ${r.seed} — worst frame ${r.worstFrameMs.toFixed(1)}ms`,
    );
    for (const fn of r.topFns) {
      console.log(
        `      ${fn.selfPct.toFixed(2).padStart(6)}%  ${fn.selfMs.toFixed(2).padStart(7)}ms  ${fn.fn}`,
      );
    }
  }

  const allWorst = ok.map((r) => r.worstFrameMs);
  const allMean = allWorst.reduce((sum, x) => sum + x, 0) / allWorst.length;
  const allMax = Math.max(...allWorst);
  const allMin = Math.min(...allWorst);
  console.log();
  console.log(
    `Worst frame across ${ok.length} seeds: min ${allMin.toFixed(1)}ms, mean ${allMean.toFixed(1)}ms, max ${allMax.toFixed(1)}ms.`,
  );

  // Surface which functions appear in any seed's top-1 — a quick way to see
  // whether one root cause dominates or multiple do.
  const top1Counts = new Map<string, number>();
  for (const r of ok) {
    const top1 = r.topFns[0];
    if (!top1) continue;
    top1Counts.set(top1.fn, (top1Counts.get(top1.fn) ?? 0) + 1);
  }
  const sorted = [...top1Counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log();
  console.log(
    `Top-1 self-time function — distribution across ${ok.length} seeds:`,
  );
  for (const [fn, count] of sorted) {
    console.log(`  ${String(count).padStart(2)} × ${fn}`);
  }
}

function printSeedLine(r: SeedResult): void {
  const okFlag = r.ok ? "y" : "N";
  const top1 = r.topFns[0];
  const top1Str = top1
    ? `${top1.fn} (${top1.selfMs.toFixed(1)}ms, ${top1.selfPct.toFixed(1)}%)`
    : "(none)";
  console.log(
    `  ${String(r.seed).padStart(4)}  ${okFlag}  worst=${r.worstFrameMs.toFixed(0).padStart(4)}ms  cpu=${r.worstWindowCpu.toFixed(0).padStart(4)}ms  gpu=${r.worstWindowGpu.toFixed(0).padStart(4)}ms  @t=${r.worstWindowT.toFixed(1).padStart(5)}s  | ${top1Str}`,
  );
}
