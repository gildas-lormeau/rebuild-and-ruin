/**
 * Battle-metrics tracker — runs N seeds × R rounds × 3 AI players in parallel
 * across a Deno worker pool and prints raw battle-phase metrics (NO scoring).
 * Tracks what the AI shot at (outcome), why (FireOrigin intent), the results
 * (offense / defense / charity / cross-round build tax), and crosshair motion
 * — grouped per axis so you can eyeball where a firing change moves the
 * needle. See project memory `project_battle_metrics_tracking`.
 *
 * Usage:
 *   deno run -A scripts/battle-metrics.ts                      # 10 random seeds × 15 rounds, modern
 *   deno run -A scripts/battle-metrics.ts --seeds 1,2,3 --rounds 20
 *   deno run -A scripts/battle-metrics.ts --random 20 --mode classic
 *   deno run -A scripts/battle-metrics.ts --master-seed 42     # reproducible draw
 *   deno run -A scripts/battle-metrics.ts --json
 *
 * Pool + arg plumbing is shared via scripts/seed-pool.ts.
 */

import { IMPACT } from "../test/impact-classify.ts";
import type { SeedMetrics } from "./battle-metrics-runner.ts";
import type { WorkerRequest } from "./battle-metrics-worker.ts";
import { parseSeedPoolArgs, poolSizeFor, runWorkerPool } from "./seed-pool.ts";

await main();

async function main(): Promise<void> {
  const args = parseSeedPoolArgs();
  if (!args.json) {
    console.log(
      `Battle metrics — ${args.seeds.length} seeds × ${args.rounds} rounds × 3 players, mode=${args.mode}`,
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
    import.meta.resolve("./battle-metrics-worker.ts"),
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
  printReport(results);
  console.log(`\nElapsed: ${elapsedSec.toFixed(1)}s`);
}

function printReport(results: readonly SeedMetrics[]): void {
  const rows = results.flatMap((r) => r.battles);
  const gamePlayers = results.flatMap((r) => r.players);
  if (rows.length === 0) {
    console.log("\nNo battle rows collected.");
    return;
  }
  const totalShots = sum(rows.map((r) => r.shots));

  console.log(
    `\nBattle rows: ${rows.length} (player-battles) from ${results.length} seeds`,
  );
  console.log(`Total shots fired: ${totalShots}`);
  console.log("─".repeat(72));

  console.log("\nShot OUTCOME — what the AI aimed at (% of shots)");
  for (const kind of Object.values(IMPACT)) {
    const count = sum(rows.map((r) => r.outcome[kind] ?? 0));
    if (count === 0) continue;
    console.log(`  ${kind.padEnd(14)} ${pct(count, totalShots)}  (${count})`);
  }
  const wasted = sum(
    rows.map(
      (r) =>
        r.outcome[IMPACT.OWN_TOWER] +
        r.outcome[IMPACT.ENEMY_TOWER] +
        r.outcome[IMPACT.NEUTRAL_TOWER] +
        r.outcome[IMPACT.DEBRIS] +
        r.outcome[IMPACT.OFF_MAP],
    ),
  );
  console.log(
    `  → hard-wasted (immune towers + debris + off-map): ${pct(wasted, totalShots)}`,
  );

  console.log("\nShot INTENT — FireOrigin (% of shots)");
  const origins = new Map<string, number>();
  for (const row of rows) {
    for (const [origin, count] of Object.entries(row.origin)) {
      origins.set(origin, (origins.get(origin) ?? 0) + count);
    }
  }
  for (const [origin, count] of [...origins].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${origin.padEnd(14)} ${pct(count, totalShots)}  (${count})`);
  }

  console.log("\nOffense / battle (mean over player-battles)");
  meanLine(
    "  enemy walls destroyed",
    rows.map((r) => r.enemyWallsDestroyed),
  );
  meanLine(
    "  enemy cannons killed ",
    rows.map((r) => r.enemyCannonsKilled),
  );
  console.log("\nSelf-fire / battle (cleanup, NOT waste)");
  meanLine(
    "  own walls destroyed  ",
    rows.map((r) => r.ownWallsDestroyed),
  );

  console.log("\nGrunt kills / battle");
  meanLine(
    "  own-zone (defense)   ",
    rows.map((r) => r.gruntKillsOwnZone),
  );
  meanLine(
    "  enemy-zone (charity) ",
    rows.map((r) => r.gruntKillsEnemyZone),
  );

  console.log("\nDefense / battle");
  meanLine(
    "  own towers lost      ",
    rows.map((r) => r.ownTowersLostToGrunts),
  );

  console.log(
    "\nCross-round build tax — next WALL_BUILD (the objective signal)",
  );
  const repair = sum(rows.map((r) => r.repairTilesPlaced));
  const expansion = sum(rows.map((r) => r.expansionTilesPlaced));
  const gaps = sum(rows.map((r) => r.unrepairedGaps));
  meanLine(
    "  repair tiles placed  ",
    rows.map((r) => r.repairTilesPlaced),
  );
  meanLine(
    "  expansion tiles      ",
    rows.map((r) => r.expansionTilesPlaced),
  );
  meanLine(
    "  unrepaired gaps      ",
    rows.map((r) => r.unrepairedGaps),
  );
  console.log(
    `  repair fraction       = ${pct(repair, repair + expansion)}  (higher = battles taxed builds more)`,
  );
  console.log(
    `  unrepaired / destroyed= ${pct(gaps, gaps + repair)}  (higher = damage they couldn't fix)`,
  );

  console.log("\nOther burdens / battle (measure-only)");
  meanLine(
    "  enemy-house shots    ",
    rows.map((r) => r.enemyHouseShots),
  );
  meanLine(
    "  pits in own zone     ",
    rows.map((r) => r.pitsInOwnZone),
  );
  meanLine(
    "  dup / over-commit    ",
    rows.map((r) => r.dupShots),
  );

  console.log("\nCrosshair / cursor");
  const travel = sum(rows.map((r) => r.crosshairTravelPx));
  meanLine(
    "  travel px / battle   ",
    rows.map((r) => r.crosshairTravelPx),
  );
  console.log(
    `  travel px / shot      = ${(totalShots > 0 ? travel / totalShots : 0).toFixed(1)}`,
  );
  console.log(
    `  flight dist px (avg)  = ${avgRatio(
      rows.map((r) => r.flightDistSumPx),
      rows.map((r) => r.shots),
    )}`,
  );
  console.log(
    `  flight time s  (avg)  = ${avgRatio(
      rows.map((r) => r.flightTimeSum),
      rows.map((r) => r.shots),
    )}`,
  );

  console.log("\nPer game (per player)");
  meanLine(
    "  final score          ",
    gamePlayers.map((p) => p.finalScore),
  );
  meanLine(
    "  final lives          ",
    gamePlayers.map((p) => p.finalLives),
  );
  meanLine(
    "  last alive round     ",
    gamePlayers.map((p) => p.lastAliveRound),
  );
  console.log("─".repeat(72));
}

function meanLine(label: string, values: readonly number[]): void {
  const stats = describe(values);
  console.log(
    `${label} mean=${stats.mean.toFixed(2).padStart(8)} std=${stats.std.toFixed(2).padStart(7)} max=${stats.max.toFixed(0).padStart(5)} n=${stats.n}`,
  );
}

function pct(count: number, total: number): string {
  return `${total > 0 ? ((100 * count) / total).toFixed(1) : "0.0"}%`.padStart(
    6,
  );
}

function avgRatio(num: readonly number[], den: readonly number[]): string {
  const d = sum(den);
  return (d > 0 ? sum(num) / d : 0).toFixed(1);
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function describe(values: readonly number[]): {
  mean: number;
  std: number;
  max: number;
  n: number;
} {
  const n = values.length;
  if (n === 0) return { mean: 0, std: 0, max: 0, n: 0 };
  let total = 0;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    total += value;
    if (value > max) max = value;
  }
  const mean = total / n;
  let sqSum = 0;
  for (const value of values) sqSum += (value - mean) * (value - mean);
  return { mean, std: Math.sqrt(sqSum / Math.max(1, n - 1)), max, n };
}
