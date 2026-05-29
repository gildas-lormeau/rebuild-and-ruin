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
 *   deno run -A scripts/battle-metrics.ts --by-archetype       # segment by AI archetype
 *   deno run -A scripts/battle-metrics.ts --json
 *
 * Pool + arg plumbing is shared via scripts/seed-pool.ts.
 */

import type { PlayerBattleMetrics } from "../test/battle-metrics-observer.ts";
import { IMPACT } from "../test/impact-classify.ts";
import type {
  PlayerGameMetrics,
  SeedMetrics,
} from "./battle-metrics-runner.ts";
import type { WorkerRequest } from "./battle-metrics-worker.ts";
import { parseSeedPoolArgs, poolSizeFor, runWorkerPool } from "./seed-pool.ts";

interface ArchetypeGroup {
  rows: PlayerBattleMetrics[];
  players: PlayerGameMetrics[];
}

/** Fixed column order (NOT a skill ranking — read final score/lives for the
 *  actual competitive standing, which is data-dependent). Only archetypes
 *  actually present in the run are shown. */
const ARCHETYPE_ORDER = [
  "tactician",
  "builder",
  "balanced",
  "aggressive",
  "chaotic",
] as const;

await main();

async function main(): Promise<void> {
  const args = parseSeedPoolArgs(
    "Battle metrics — tracks AI battle-phase firing metrics (no scoring).\n" +
      "  deno run -A scripts/battle-metrics.ts [flags]   (or: npm run battle-metrics -- [flags])\n" +
      "  extra flag: --by-archetype  segment the report by AI personality archetype",
  );
  // battle-metrics-local boolean flag; the shared parser ignores unknown args.
  const byArchetype = Deno.args.includes("--by-archetype");
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
  if (byArchetype) printByArchetype(results);
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

  console.log(
    "\nStandard-shot PICK PATH — pickTarget sub-branch + scatter (mean jump from prior shot, tiles)",
  );
  const pickCounts = new Map<string, number>();
  const pickJumpSum = new Map<string, number>();
  const pickJumpPairs = new Map<string, number>();
  for (const row of rows) {
    for (const [path, count] of Object.entries(row.pickPath)) {
      pickCounts.set(path, (pickCounts.get(path) ?? 0) + count);
    }
    for (const [path, jumpSum] of Object.entries(row.pickPathJumpSum)) {
      pickJumpSum.set(path, (pickJumpSum.get(path) ?? 0) + jumpSum);
    }
    for (const [path, pairs] of Object.entries(row.pickPathJumpPairs)) {
      pickJumpPairs.set(path, (pickJumpPairs.get(path) ?? 0) + pairs);
    }
  }
  const pickTotal = sum([...pickCounts.values()]);
  for (const [path, count] of [...pickCounts].sort((a, b) => b[1] - a[1])) {
    const pairs = pickJumpPairs.get(path) ?? 0;
    const jump = pairs > 0 ? (pickJumpSum.get(path) ?? 0) / pairs : 0;
    console.log(
      `  ${path.padEnd(16)} ${pct(count, pickTotal)}  (${count})  jump=${jump.toFixed(1)}`,
    );
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
    "\nBattle decisiveness — victim-side breach severity (did fire actually breach?)",
  );
  const interiorLost = rows.map((r) =>
    Math.max(0, r.interiorAtStart - r.interiorAtEnd),
  );
  const towersDeEnclosed = rows.map((r) =>
    Math.max(0, r.enclosedTowersAtStart - r.enclosedTowersAtEnd),
  );
  meanLine("  interior tiles lost  ", interiorLost);
  meanLine("  towers de-enclosed   ", towersDeEnclosed);
  console.log(
    `  battles with a breach = ${pct(interiorLost.filter((v) => v > 0).length, rows.length)}  (share of player-battles that lost any enclosed interior)`,
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
  console.log(
    `  inter-shot dist (avg) = ${avgRatio(
      rows.map((r) => r.interShotDistSum),
      rows.map((r) => r.interShotPairs),
    )} tiles  (jump between consecutive shots — lower = concentrated fire)`,
  );

  console.log("\nCannon utilization / firing cadence");
  const owned = sum(rows.map((r) => r.ownedCannonsAtStart));
  const usable = sum(rows.map((r) => r.usableCannonsAtStart));
  const distinct = sum(rows.map((r) => r.distinctCannonsFired));
  const stalls = sum(rows.map((r) => r.stallShots));
  meanLine(
    "  owned cannons        ",
    rows.map((r) => r.ownedCannonsAtStart),
  );
  meanLine(
    "  usable cannons       ",
    rows.map((r) => r.usableCannonsAtStart),
  );
  console.log(
    `  enclosure-gated       = ${pct(owned - usable, owned)}  (owned cannons that can't fire — not enclosed)`,
  );
  meanLine(
    "  distinct fired       ",
    rows.map((r) => r.distinctCannonsFired),
  );
  console.log(
    `  utilization           = ${pct(distinct, usable)}  (distinct fired / usable — idle offense capacity is the rest)`,
  );
  console.log(
    `  ready headroom / shot = ${avgRatio(
      rows.map((r) => r.readyAfterFireSum),
      rows.map((r) => r.shots),
    )}  (cannons ready for the NEXT cycle; ≫0 = uninterrupted spam, ≈0 = reload-throttled)`,
  );
  console.log(
    `  reload-stall fraction = ${pct(stalls, totalShots)}  (shots after which no cannon was ready — cannon-starved fire)`,
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

/** Per-archetype breakdown of the key axes — the population mean blends
 *  deliberately-uneven trait tiers, so this segments by play style. Which
 *  archetype leads on which axis is data-dependent (e.g. measured runs show
 *  cannons-killed tracks battleTactics, while raw walls-destroyed and score
 *  can favor the fast-spray chaotic profile) — read the columns, don't assume
 *  an a-priori strong/weak ordering. */
function printByArchetype(results: readonly SeedMetrics[]): void {
  const groups = new Map<string, ArchetypeGroup>();
  for (const result of results) {
    for (const row of result.battles) {
      const archetype = result.archetypes[row.playerId];
      if (archetype === undefined) continue;
      getGroup(groups, archetype).rows.push(row);
    }
    for (const player of result.players) {
      const archetype = result.archetypes[player.playerId];
      if (archetype === undefined) continue;
      getGroup(groups, archetype).players.push(player);
    }
  }
  const present = ARCHETYPE_ORDER.filter((a) => groups.has(a));
  if (present.length === 0) return;

  console.log("\n");
  console.log("═".repeat(72));
  console.log("PER-ARCHETYPE breakdown (fixed order — score/lives = standing)");
  console.log("═".repeat(72));

  const metrics: Array<[string, (group: ArchetypeGroup) => string]> = [
    ["battles (n)", (g) => `${g.rows.length}`],
    ["games (n)", (g) => `${g.players.length}`],
    [
      "enclosure-gated",
      (g) =>
        pct(
          sum(
            g.rows.map((r) => r.ownedCannonsAtStart - r.usableCannonsAtStart),
          ),
          sum(g.rows.map((r) => r.ownedCannonsAtStart)),
        ).trim(),
    ],
    [
      "utilization",
      (g) =>
        pct(
          sum(g.rows.map((r) => r.distinctCannonsFired)),
          sum(g.rows.map((r) => r.usableCannonsAtStart)),
        ).trim(),
    ],
    [
      "inter-shot tiles",
      (g) =>
        avgRatio(
          g.rows.map((r) => r.interShotDistSum),
          g.rows.map((r) => r.interShotPairs),
        ),
    ],
    [
      "walls destroyed",
      (g) => mean(g.rows.map((r) => r.enemyWallsDestroyed)).toFixed(2),
    ],
    [
      "cannons killed",
      (g) => mean(g.rows.map((r) => r.enemyCannonsKilled)).toFixed(2),
    ],
    [
      "interior lost",
      (g) =>
        mean(
          g.rows.map((r) => Math.max(0, r.interiorAtStart - r.interiorAtEnd)),
        ).toFixed(1),
    ],
    [
      "towers de-encl",
      (g) =>
        mean(
          g.rows.map((r) =>
            Math.max(0, r.enclosedTowersAtStart - r.enclosedTowersAtEnd),
          ),
        ).toFixed(2),
    ],
    [
      "breach %",
      (g) =>
        pct(
          g.rows.filter((r) => r.interiorAtStart - r.interiorAtEnd > 0).length,
          g.rows.length,
        ).trim(),
    ],
    [
      "repair frac",
      (g) =>
        pct(
          sum(g.rows.map((r) => r.repairTilesPlaced)),
          sum(g.rows.map((r) => r.repairTilesPlaced + r.expansionTilesPlaced)),
        ).trim(),
    ],
    ["final score", (g) => mean(g.players.map((p) => p.finalScore)).toFixed(0)],
    ["final lives", (g) => mean(g.players.map((p) => p.finalLives)).toFixed(2)],
  ];

  const colWidth = 12;
  const header = [
    "metric".padEnd(18),
    ...present.map((a) => a.padStart(colWidth)),
  ];
  console.log(header.join(""));
  console.log("─".repeat(18 + present.length * colWidth));
  for (const [label, fn] of metrics) {
    const cells = present.map((a) => fn(groups.get(a)!).padStart(colWidth));
    console.log(label.padEnd(18) + cells.join(""));
  }
  console.log("═".repeat(72));
}

function getGroup(
  groups: Map<string, ArchetypeGroup>,
  archetype: string,
): ArchetypeGroup {
  let group = groups.get(archetype);
  if (!group) {
    group = { rows: [], players: [] };
    groups.set(archetype, group);
  }
  return group;
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

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
