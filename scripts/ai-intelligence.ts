/**
 * AI intelligence metrics — runs N seeds × R rounds × 3 AI players in parallel
 * across a Deno worker pool, prints multi-dimensional summary stats. Designed
 * for low default param values so the user can sample many random seed sets
 * cheaply and measure metric variance before locking in a baseline.
 *
 * Usage:
 *   deno run -A scripts/ai-intelligence.ts                       # 10 random seeds × 15 rounds, modern
 *   deno run -A scripts/ai-intelligence.ts --seeds 1,2,3 --rounds 20
 *   deno run -A scripts/ai-intelligence.ts --random 20 --mode classic
 *   deno run -A scripts/ai-intelligence.ts --master-seed 42      # reproducible random draw
 *
 * Dimensions reported (per player-game / per round-player as appropriate):
 *   finalLives, finalScore, lastAliveRound,
 *   enclosedAlive (avg per round), interiorSize (avg per round).
 *
 * Pool + arg plumbing is shared via scripts/seed-pool.ts.
 */

import type { SeedMetrics } from "./ai-intelligence-runner.ts";
import type { WorkerRequest } from "./ai-intelligence-worker.ts";
import { parseSeedPoolArgs, poolSizeFor, runWorkerPool } from "./seed-pool.ts";

await main();

async function main(): Promise<void> {
  const args = parseSeedPoolArgs(
    "AI intelligence — multi-dimensional AI metrics across random seed sets.\n" +
      "  deno run -A scripts/ai-intelligence.ts [flags]",
  );
  if (!args.json) {
    console.log(
      `AI intelligence — ${args.seeds.length} seeds × ${args.rounds} rounds × 3 players, mode=${args.mode}`,
    );
    console.log(`seeds: ${args.seeds.join(", ")}`);
  }

  const poolSize = poolSizeFor(args.seeds.length);
  if (!args.json) console.log(`workers: ${poolSize}\n`);

  const t0 = performance.now();
  const requests: WorkerRequest[] = args.seeds.map((seed) => ({
    seed,
    rounds: args.rounds,
    mode: args.mode,
  }));
  const { results, errors } = await runWorkerPool<WorkerRequest, SeedMetrics>(
    import.meta.resolve("./ai-intelligence-worker.ts"),
    requests,
    poolSize,
  );
  const elapsedSec = (performance.now() - t0) / 1000;
  if (errors.length > 0) {
    console.error(`\nErrors (${errors.length}):`);
    for (const err of errors) console.error(`  ${err}`);
  }

  if (args.json) {
    console.log(
      JSON.stringify({
        seeds: args.seeds,
        rounds: args.rounds,
        mode: args.mode,
        elapsedSec,
        results,
      }),
    );
    return;
  }
  printSummary(results, args.rounds);
  console.log(`\nElapsed: ${elapsedSec.toFixed(1)}s`);
}

function printSummary(
  results: readonly SeedMetrics[],
  maxRounds: number,
): void {
  if (results.length === 0) {
    console.log("\nNo successful runs.");
    return;
  }

  // Aggregate per-game (one sample per player per seed) and per-round (one
  // sample per player per round per seed) into flat arrays for stats.
  const finalLives: number[] = [];
  const finalScore: number[] = [];
  const lastAliveRound: number[] = [];
  const enclosedAlive: number[] = [];
  const interiorSize: number[] = [];

  for (const seedResult of results) {
    for (const player of seedResult.players) {
      finalLives.push(player.finalLives);
      finalScore.push(player.finalScore);
      lastAliveRound.push(player.lastAliveRound);
      for (const sample of player.perRound) {
        enclosedAlive.push(sample.enclosedAlive);
        interiorSize.push(sample.interiorSize);
      }
    }
  }

  console.log(
    `\nResults from ${results.length} seeds (${maxRounds} rounds max, 3 players each)`,
  );
  console.log("─".repeat(78));
  printDim("finalLives    (per game)", finalLives);
  printDim("finalScore    (per game)", finalScore);
  printDim("lastAliveRnd  (per game)", lastAliveRound);
  printDim("enclosedAlive (per round)", enclosedAlive);
  printDim("interiorSize  (per round)", interiorSize);
  console.log("─".repeat(78));
  console.log("CV = stddev / mean — lower means more stable signal.");
  console.log("MDE = minimum detectable effect at 95% conf, n=samples.");
}

function printDim(label: string, values: readonly number[]): void {
  const stats = describe(values);
  const cvStr = stats.mean !== 0 ? (stats.std / stats.mean).toFixed(3) : "—";
  const mdeStr =
    stats.mean !== 0 && stats.n > 0
      ? `${(((1.96 * stats.std) / (stats.mean * Math.sqrt(stats.n))) * 100).toFixed(1)}%`
      : "—";
  console.log(
    `${label.padEnd(28)} mean=${stats.mean.toFixed(2).padStart(8)} ` +
      `std=${stats.std.toFixed(2).padStart(7)} ` +
      `min=${stats.min.toFixed(0).padStart(5)} ` +
      `max=${stats.max.toFixed(0).padStart(6)} ` +
      `n=${String(stats.n).padStart(5)} ` +
      `cv=${cvStr.padStart(6)} ` +
      `mde=${mdeStr.padStart(6)}`,
  );
}

function describe(values: readonly number[]): {
  mean: number;
  std: number;
  min: number;
  max: number;
  n: number;
} {
  const n = values.length;
  if (n === 0) return { mean: 0, std: 0, min: 0, max: 0, n: 0 };
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / n;
  let sqSum = 0;
  for (const v of values) sqSum += (v - mean) * (v - mean);
  const std = Math.sqrt(sqSum / Math.max(1, n - 1));
  return { mean, std, min, max, n };
}
