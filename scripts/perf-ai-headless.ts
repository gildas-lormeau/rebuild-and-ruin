/**
 * Headless runner for CPU-profiling the AI's WALL_BUILD (and full-game)
 * work. Drives the game tick-by-tick so each tick's wall-time can be
 * attributed to the (round, phase) it landed in, exposing per-frame
 * hitches that the aggregate self-time view hides.
 *
 *   deno run --cpu-prof --cpu-prof-dir tmp/perf --cpu-prof-name ai-cpu.cpuprofile \
 *     -A scripts/perf-ai-headless.ts \
 *     [--seed N] [--mode classic|modern] [--rounds N] [--out path]
 *
 * Analyze with:
 *   deno run -A scripts/analyze-cpu.ts tmp/perf/ai-cpu.cpuprofile --filter src/ai/
 *   deno run -A scripts/perf-ai-multi.ts          # cross-seed aggregation
 *
 * Writes per-tick wall-times to `tmp/perf/ai-frames-seed-N.json` for the
 * multi-seed orchestrator to aggregate hitches across seeds.
 */

import { Mode } from "../src/shared/ui/ui-mode.ts";
import { createScenario } from "../test/scenario.ts";

interface TickRecord {
  tick: number;
  /** Phase observed after the tick — i.e. where the work ended up. */
  phase: string;
  /** Round observed after the tick. */
  round: number;
  /** Phase observed before the tick (different from `phase` only on the
   *  exact tick a phase transition fires). Useful for attributing the
   *  end-of-phase finalization spike to the right bucket. */
  phaseBefore: string;
  roundBefore: number;
  wallMicros: number;
}

interface PhaseStats {
  key: string;
  count: number;
  totalMicros: number;
  maxMicros: number;
  samples: number[];
}

const DEFAULT_SEED = 42;
const DEFAULT_MODE: "classic" | "modern" = "classic";
const DEFAULT_ROUNDS = 8;
/** Hard cap on sim ticks; ~10x a normal game so a stuck run aborts rather
 *  than spinning forever. 8 rounds is normally ~30k ticks. */
const MAX_TICKS = 300_000;

await main();

async function main(): Promise<void> {
  const args = parseArgs(Deno.args);
  console.log(
    `headless run: seed=${args.seed} mode=${args.mode} rounds=${args.rounds}`,
  );
  const sc = await createScenario({
    seed: args.seed,
    mode: args.mode,
    rounds: args.rounds,
  });

  const records: TickRecord[] = [];
  const startedAt = performance.now();
  let tickIdx = 0;
  let phaseBefore = String(sc.state.phase);
  let roundBefore = sc.state.round;
  while (sc.mode() !== Mode.STOPPED) {
    if (tickIdx >= MAX_TICKS) {
      throw new Error(`exceeded MAX_TICKS=${MAX_TICKS} (game never stopped)`);
    }
    const t0 = performance.now();
    sc.tick(1);
    const wallMicros = Math.round((performance.now() - t0) * 1000);
    const phaseAfter = String(sc.state.phase);
    const roundAfter = sc.state.round;
    records.push({
      tick: tickIdx,
      phase: phaseAfter,
      round: roundAfter,
      phaseBefore,
      roundBefore,
      wallMicros,
    });
    phaseBefore = phaseAfter;
    roundBefore = roundAfter;
    tickIdx++;
  }
  const elapsedMs = performance.now() - startedAt;
  console.log(
    `runGame done in ${elapsedMs.toFixed(0)} ms wall over ${tickIdx} ticks`,
  );

  printPerPhaseReport(records);
  printTopHitches(records, 15);

  const outPath = args.out ?? `tmp/perf/ai-frames-seed-${args.seed}.json`;
  await Deno.mkdir(outPath.split("/").slice(0, -1).join("/") || ".", {
    recursive: true,
  });
  await Deno.writeTextFile(
    outPath,
    JSON.stringify(
      {
        seed: args.seed,
        mode: args.mode,
        rounds: args.rounds,
        ticks: tickIdx,
        wallMs: elapsedMs,
        records,
      },
      null,
      0,
    ),
  );
  console.log(`per-tick records written to ${outPath}`);
}

function parseArgs(raw: readonly string[]): {
  seed: number;
  mode: "classic" | "modern";
  rounds: number;
  out: string | undefined;
} {
  let seed: number | undefined;
  let mode: "classic" | "modern" | undefined;
  let rounds: number | undefined;
  let out: string | undefined;
  for (let idx = 0; idx < raw.length; idx++) {
    const arg = raw[idx];
    const next = raw[idx + 1];
    if (arg === "--seed" && next !== undefined) {
      seed = Number(next);
      idx++;
    } else if (arg === "--mode" && (next === "classic" || next === "modern")) {
      mode = next;
      idx++;
    } else if (arg === "--rounds" && next !== undefined) {
      rounds = Number(next);
      idx++;
    } else if (arg === "--out" && next !== undefined) {
      out = next;
      idx++;
    }
  }
  return {
    seed: seed ?? DEFAULT_SEED,
    mode: mode ?? DEFAULT_MODE,
    rounds: rounds ?? DEFAULT_ROUNDS,
    out,
  };
}

function printPerPhaseReport(records: readonly TickRecord[]): void {
  // Bucket by `${round}|${phase}` using post-tick attribution. The
  // transition tick gets bucketed in the entering phase; the worst-case
  // outlier shows up in `printTopHitches` with both bucket labels, so
  // attribution ambiguity is visible there.
  const buckets = new Map<string, PhaseStats>();
  for (const rec of records) {
    const key = `${rec.round}|${rec.phase}`;
    let stats = buckets.get(key);
    if (stats === undefined) {
      stats = {
        key,
        count: 0,
        totalMicros: 0,
        maxMicros: 0,
        samples: [],
      };
      buckets.set(key, stats);
    }
    stats.count++;
    stats.totalMicros += rec.wallMicros;
    if (rec.wallMicros > stats.maxMicros) stats.maxMicros = rec.wallMicros;
    stats.samples.push(rec.wallMicros);
  }

  console.log();
  console.log("Per (round, phase) wall-time:");
  console.log(
    `  ${"round".padStart(5)} ${"phase".padEnd(14)} ${"count".padStart(6)} ${"total(ms)".padStart(10)} ${"mean(ms)".padStart(9)} ${"max(ms)".padStart(8)} ${"p95(ms)".padStart(8)} ${"p99(ms)".padStart(8)}`,
  );
  // Order by round, then by a fixed phase order for readability.
  const phaseOrder = [
    "CASTLE_SELECT",
    "WALL_BUILD",
    "CANNON_PLACE",
    "MODIFIER_REVEAL",
    "BATTLE",
    "UPGRADE_PICK",
  ];
  const rows = [...buckets.values()];
  rows.sort((a, b) => {
    const [ra, pa] = a.key.split("|");
    const [rb, pb] = b.key.split("|");
    const roundCmp = Number(ra) - Number(rb);
    if (roundCmp !== 0) return roundCmp;
    return phaseOrder.indexOf(pa!) - phaseOrder.indexOf(pb!);
  });
  for (const stats of rows) {
    const [round, phase] = stats.key.split("|");
    const sorted = [...stats.samples].sort((a, b) => a - b);
    const p95 = quantile(sorted, 0.95);
    const p99 = quantile(sorted, 0.99);
    console.log(
      `  ${String(round).padStart(5)} ${(phase ?? "?").padEnd(14)} ${String(stats.count).padStart(6)} ${fmtMs(stats.totalMicros).padStart(10)} ${fmtMs(stats.totalMicros / stats.count).padStart(9)} ${fmtMs(stats.maxMicros).padStart(8)} ${fmtMs(p95).padStart(8)} ${fmtMs(p99).padStart(8)}`,
    );
  }
}

function printTopHitches(records: readonly TickRecord[], topN: number): void {
  const sorted = [...records].sort((a, b) => b.wallMicros - a.wallMicros);
  console.log();
  console.log(`Top ${topN} hitches (single ticks):`);
  console.log(
    `  ${"tick".padStart(6)} ${"r".padStart(2)} ${"phase".padEnd(14)} ${"wall(ms)".padStart(9)}  transition`,
  );
  for (let i = 0; i < Math.min(topN, sorted.length); i++) {
    const rec = sorted[i]!;
    const transition =
      rec.phaseBefore !== rec.phase || rec.roundBefore !== rec.round
        ? `${rec.roundBefore}/${rec.phaseBefore} → ${rec.round}/${rec.phase}`
        : "";
    console.log(
      `  ${String(rec.tick).padStart(6)} ${String(rec.round).padStart(2)} ${rec.phase.padEnd(14)} ${fmtMs(rec.wallMicros).padStart(9)}  ${transition}`,
    );
  }
}

function quantile(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor(q * sortedAsc.length)),
  );
  return sortedAsc[idx]!;
}

function fmtMs(micros: number): string {
  return (micros / 1000).toFixed(2);
}
