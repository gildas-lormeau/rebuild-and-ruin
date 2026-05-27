/**
 * Multi-master-seed AI comparison — automates the "run ai-intelligence twice
 * with N different seed draws, aggregate verdicts" workflow that mitigates
 * single-run sampling noise. Sets up a git worktree at the baseline ref,
 * runs intelligence snapshots in both code bases sequentially across N
 * master-seeds, and prints a consensus table.
 *
 * Usage:
 *   deno run -A scripts/ai-compare-multi.ts --baseline-ref HEAD~5
 *   deno run -A scripts/ai-compare-multi.ts --baseline-ref e1765e4c~1 --runs 5 --random 10 --rounds 15
 *
 * The baseline ref can be any git rev. The script creates a worktree at
 * /tmp/rampart-baseline-<sha7> (reuses it if it already exists), symlinks
 * node_modules, copies the ai-intelligence scripts in (the baseline ref may
 * pre-date them), runs the matrix, then removes the worktree unless
 * --keep-worktree is passed.
 *
 * Output reports per metric:
 *   - verdict tally across runs (how many "+ better" / "- worse" / "noise")
 *   - aggregate win% across all (seed, slot) tuples in all runs
 *   - consensus verdict
 *
 * Consensus verdict rule:
 *   majority "+ better" runs AND ≥55% aggregate win%  → CONSENSUS BETTER
 *   majority "- worse"  runs AND ≤45% aggregate win%  → CONSENSUS WORSE
 *   otherwise                                          → NEUTRAL / NOISE
 */

import {
  classifyVerdict,
  computeDeltas,
  fmtDelta,
  type MetricDelta,
  matchTuples,
  type Snapshot,
  type Verdict,
} from "./ai-compare-lib.ts";

interface Args {
  baselineRef: string;
  runs: number;
  random: number;
  rounds: number;
  mode: "classic" | "modern";
  keepWorktree: boolean;
}

interface RunResult {
  masterSeed: number;
  deltas: MetricDelta[];
  tuplesTotal: number;
}

interface MetricSummary {
  name: string;
  perRunVerdict: Verdict[];
  perRunDeltaPct: number[];
  totalBetter: number;
  totalWorse: number;
  totalTied: number;
  meanDeltaPct: number;
}

await main();

async function main(): Promise<void> {
  const args = parseArgs();
  const sha = (await runGit(["rev-parse", "--short", args.baselineRef])).trim();
  const worktreePath = `/tmp/rampart-baseline-${sha}`;

  await ensureWorktree(args.baselineRef, worktreePath);
  console.log(
    `baseline worktree: ${worktreePath} (ref=${args.baselineRef} sha=${sha})`,
  );
  console.log(
    `matrix: ${args.runs} master-seeds × ${args.random} seeds × ${args.rounds} rounds × 3 players, mode=${args.mode}`,
  );

  const runs: RunResult[] = [];
  const t0 = performance.now();
  try {
    for (let i = 0; i < args.runs; i++) {
      const masterSeed = i + 1;
      console.log(`\n[run ${masterSeed}/${args.runs}] …`);
      const baseline = await runIntelligence(args, masterSeed, worktreePath);
      const candidate = await runIntelligence(args, masterSeed, Deno.cwd());
      const matched = matchTuples(baseline, candidate);
      const deltas = computeDeltas(matched);
      runs.push({ masterSeed, deltas, tuplesTotal: matched.length });
      printRunLine(masterSeed, deltas, matched.length);
    }
  } finally {
    if (!args.keepWorktree) await removeWorktree(worktreePath);
  }
  const elapsedSec = (performance.now() - t0) / 1000;

  console.log("\n");
  printConsensus(runs);
  console.log(`\nElapsed: ${elapsedSec.toFixed(1)}s`);
}

function parseArgs(): Args {
  const argv = Deno.args;
  let baselineRef = "";
  let runs = 5;
  let random = 10;
  let rounds = 15;
  let mode: "classic" | "modern" = "modern";
  let keepWorktree = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--baseline-ref") baselineRef = argv[++i]!;
    else if (arg === "--runs") runs = Number.parseInt(argv[++i]!, 10);
    else if (arg === "--random") random = Number.parseInt(argv[++i]!, 10);
    else if (arg === "--rounds") rounds = Number.parseInt(argv[++i]!, 10);
    else if (arg === "--mode") {
      const value = argv[++i]!;
      if (value !== "classic" && value !== "modern") {
        throw new Error(`--mode must be classic|modern, got "${value}"`);
      }
      mode = value;
    } else if (arg === "--keep-worktree") keepWorktree = true;
  }
  if (!baselineRef) {
    console.error(
      "Usage: deno run -A scripts/ai-compare-multi.ts --baseline-ref <git-ref> [--runs N] [--random N] [--rounds N] [--mode classic|modern] [--keep-worktree]",
    );
    Deno.exit(1);
  }
  return { baselineRef, runs, random, rounds, mode, keepWorktree };
}

async function ensureWorktree(ref: string, path: string): Promise<void> {
  try {
    Deno.statSync(path);
    return;
  } catch {
    // doesn't exist
  }
  await runGit(["worktree", "add", path, ref]);
  // Symlink node_modules so deno can resolve npm deps (baseline trees don't
  // have their own node_modules — they share the active checkout's install).
  const nm = `${Deno.cwd()}/node_modules`;
  await runCmd(["ln", "-sf", nm, `${path}/`]);
  // The baseline ref likely predates these scripts — copy them in so they
  // can execute. Worker imports test/scenario.ts and src/* from the worktree,
  // which is exactly what we want (baseline AI code).
  for (const file of [
    "ai-intelligence.ts",
    "ai-intelligence-runner.ts",
    "ai-intelligence-worker.ts",
  ]) {
    await Deno.copyFile(`scripts/${file}`, `${path}/scripts/${file}`);
  }
}

async function removeWorktree(path: string): Promise<void> {
  await runGit(["worktree", "remove", path, "--force"]).catch(() => {});
}

async function runIntelligence(
  args: Args,
  masterSeed: number,
  cwd: string,
): Promise<Snapshot> {
  const cmd = new Deno.Command("deno", {
    args: [
      "run",
      "-A",
      "scripts/ai-intelligence.ts",
      "--json",
      "--master-seed",
      String(masterSeed),
      "--random",
      String(args.random),
      "--rounds",
      String(args.rounds),
      "--mode",
      args.mode,
    ],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    const err = new TextDecoder().decode(stderr);
    throw new Error(`ai-intelligence failed (cwd=${cwd}): ${err}`);
  }
  return JSON.parse(new TextDecoder().decode(stdout)) as Snapshot;
}

async function runGit(args: readonly string[]): Promise<string> {
  return runCmd(["git", ...args]);
}

async function runCmd(args: readonly string[]): Promise<string> {
  const cmd = new Deno.Command(args[0]!, {
    args: args.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    const err = new TextDecoder().decode(stderr);
    throw new Error(`${args.join(" ")} failed: ${err}`);
  }
  return new TextDecoder().decode(stdout);
}

function printRunLine(
  masterSeed: number,
  deltas: readonly MetricDelta[],
  tuplesTotal: number,
): void {
  const parts: string[] = [];
  for (const d of deltas) {
    const decided = d.better + d.worse;
    const winPct = decided > 0 ? (100 * d.better) / decided : 0;
    const verdict = classifyVerdict(winPct, decided, tuplesTotal);
    const tag =
      verdict === "+ better"
        ? "+"
        : verdict === "- worse"
          ? "-"
          : verdict === "noise"
            ? "."
            : "?";
    parts.push(`${d.name}=${tag}${winPct.toFixed(0)}%`);
  }
  console.log(`  ms=${masterSeed}: ${parts.join("  ")}`);
}

function printConsensus(runs: readonly RunResult[]): void {
  if (runs.length === 0) {
    console.log("No completed runs.");
    return;
  }
  const summaries = aggregate(runs);
  console.log(
    `${"metric".padEnd(14)} ${"runs+/-/.".padStart(11)} ${"agg win%".padStart(10)} ${"mean %Δ".padStart(9)} ${"tally (b/w/t)".padStart(16)} consensus`,
  );
  console.log("─".repeat(82));
  for (const s of summaries) {
    const betterRuns = s.perRunVerdict.filter((v) => v === "+ better").length;
    const worseRuns = s.perRunVerdict.filter((v) => v === "- worse").length;
    const noiseRuns = s.perRunVerdict.length - betterRuns - worseRuns;
    const decided = s.totalBetter + s.totalWorse;
    const aggWinPct = decided > 0 ? (100 * s.totalBetter) / decided : 0;
    const consensus = consensusVerdict(
      betterRuns,
      worseRuns,
      s.perRunVerdict.length,
      aggWinPct,
    );
    console.log(
      `${s.name.padEnd(14)} ${`${betterRuns}/${worseRuns}/${noiseRuns}`.padStart(11)} ` +
        `${(decided > 0 ? aggWinPct.toFixed(0) + "%" : "—").padStart(10)} ` +
        `${fmtDelta(s.meanDeltaPct).padStart(8)}% ${`${s.totalBetter}/${s.totalWorse}/${s.totalTied}`.padStart(16)} ${consensus}`,
    );
  }
  console.log("─".repeat(82));
  console.log(
    `runs+/-/. = how many master-seed runs voted better/worse/noise (or low-signal).`,
  );
  console.log(
    `agg win%  = total better / (total better + total worse) across all runs.`,
  );
  console.log(
    `CONSENSUS: ≥majority direction + win% past 55%/45% → BETTER/WORSE; else NEUTRAL/NOISE.`,
  );
}

function aggregate(runs: readonly RunResult[]): MetricSummary[] {
  const metricNames = runs[0]?.deltas.map((d) => d.name) ?? [];
  return metricNames.map((name) => {
    const perRunVerdict: Verdict[] = [];
    const perRunDeltaPct: number[] = [];
    let totalBetter = 0;
    let totalWorse = 0;
    let totalTied = 0;
    let meanDeltaSum = 0;
    for (const run of runs) {
      const d = run.deltas.find((x) => x.name === name);
      if (!d) continue;
      const decided = d.better + d.worse;
      const winPct = decided > 0 ? (100 * d.better) / decided : 0;
      perRunVerdict.push(classifyVerdict(winPct, decided, run.tuplesTotal));
      const pct =
        d.baselineMean !== 0 ? (d.meanDelta / d.baselineMean) * 100 : 0;
      perRunDeltaPct.push(pct);
      meanDeltaSum += pct;
      totalBetter += d.better;
      totalWorse += d.worse;
      totalTied += d.tied;
    }
    return {
      name,
      perRunVerdict,
      perRunDeltaPct,
      totalBetter,
      totalWorse,
      totalTied,
      meanDeltaPct: meanDeltaSum / Math.max(1, perRunDeltaPct.length),
    };
  });
}

function consensusVerdict(
  betterRuns: number,
  worseRuns: number,
  totalRuns: number,
  aggWinPct: number,
): string {
  const majority = Math.ceil(totalRuns / 2);
  if (betterRuns >= majority && aggWinPct >= 55) return "BETTER";
  if (worseRuns >= majority && aggWinPct <= 45) return "WORSE";
  if (betterRuns >= majority || aggWinPct >= 55) return "lean better";
  if (worseRuns >= majority || aggWinPct <= 45) return "lean worse";
  return "NEUTRAL / noise";
}
