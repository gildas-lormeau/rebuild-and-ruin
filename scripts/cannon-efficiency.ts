/**
 * Cannon firing-behaviour measurement harness (parallel).
 *
 * Runs N modern games to-the-death across a Deno worker pool (size =
 * navigator.hardwareConcurrency, override via --workers) and aggregates
 * firing-behaviour metrics across several axes that pull in different
 * directions, so improving one must not silently wreck another:
 *
 *   USAGE / throughput — the headline "cannon usage" number. cap/b = mean
 *     fire-capable cannons (alive + enclosed) a player has at battle start;
 *     can/b = mean distinct cannons it actually fires; util = can/b ÷ cap/b
 *     (fraction of the fleet that fires). sht/b = mean shots. The single bound-
 *     speed crosshair caps this. Fair fixes (crosshair efficiency, placement
 *     discipline) lift util.
 *
 *   CURSOR — the bottleneck. ONE crosshair per player at CROSSHAIR_SPEED; every
 *     fire-commit waits on it travelling to target. trav/b = mean cursor path
 *     (px) per battle; trav/sht = cursor px per shot (LOWER = more fire per
 *     crosshair-second).
 *
 *   TRAJECTORY — which cannon fires. fltT = mean flight time; impR = impacts
 *     landed / shots (fewer balls mid-air at the 10s battle end).
 *
 *   VARIETY — must not hammer the same walls each round. ovlap = mean Jaccard
 *     of a player's targeted-tile set between consecutive rounds.
 *
 *   FAR-REACH — willingness to take long finishing shots. p90 flight px; a
 *     flight-cutting change is good only if this holds.
 *
 * Usage:
 *   deno run -A scripts/cannon-efficiency.ts --seeds 1000,1137 --rounds 25
 *   deno run -A scripts/cannon-efficiency.ts --count 12 --rounds 25 --workers 8
 *
 * Body wrapped in main() because Biome hoists top-level consts past their
 * init-order dependencies.
 */

import { type Agg, emptyAgg } from "./cannon-efficiency-runner.ts";
import type {
  WorkerRequest,
  WorkerResponse,
} from "./cannon-efficiency-worker.ts";

interface Args {
  seeds: number[];
  rounds: number;
  workers: number;
}

const HELP_TEXT = `Cannon firing-behaviour measurement harness (parallel).

Runs N modern games to-the-death across a Deno worker pool and aggregates
AI cannon-firing metrics. Deterministic per seed (byte-identical to a
sequential run); use it to A/B a firing change against a baseline.

Usage:
  deno run -A scripts/cannon-efficiency.ts [options]
  npm run cannon-efficiency -- [options]

Options:
  --seeds A,B,C    Explicit comma-separated seed list.
  --count N        Use N deterministic seeds (1000, 1137, …) instead.
                   Same set every run, so baseline/candidate are comparable.
  --rounds N       Per-seed sim-time budget in rounds (default 25). Does NOT
                   cap the match — games still run to-the-death.
  --workers N      Worker pool size (default navigator.hardwareConcurrency).
  --help, -h       Show this help and exit.

Columns: shots, cap/b (capable fleet at battle start), can/b (cannons fired),
  util (can/b÷cap/b), sht/b, trav/b + trav/sht (cursor px), fltT (flight s),
  p90 (far-reach px), impR (impacts/shot), ovlap (round-to-round repetition).`;

await main();

async function main(): Promise<void> {
  if (Deno.args.includes("--help") || Deno.args.includes("-h")) {
    console.log(HELP_TEXT);
    return;
  }
  const args = parseArgs(Deno.args);
  const poolSize = Math.max(1, Math.min(args.seeds.length, args.workers));
  console.error(
    `seeds=${args.seeds.join(",")} rounds-budget=${args.rounds} ` +
      `mode=modern workers=${poolSize}`,
  );

  const results = await runPool(args);

  console.log(
    [
      "seed".padEnd(10),
      "shots",
      "cap/b",
      "can/b",
      " util",
      "sht/b",
      " trav/b",
      "trav/sht",
      " fltT",
      " p90",
      "  impR",
      " ovlap",
    ].join("  "),
  );
  const all = emptyAgg();
  let overlapAcc = 0;
  let seen = 0;
  for (const seed of args.seeds) {
    const a = results.get(seed);
    if (!a) continue;
    seen++;
    console.log(report(String(seed), a, a.meanRoundOverlap));
    all.shots += a.shots;
    all.flightT += a.flightT;
    all.impacts += a.impacts;
    all.dists.push(...a.dists);
    all.battleCapable.push(...a.battleCapable);
    all.battleCannons.push(...a.battleCannons);
    all.battleShots.push(...a.battleShots);
    all.battleTravel.push(...a.battleTravel);
    all.cursorTravelPx += a.cursorTravelPx;
    overlapAcc += a.meanRoundOverlap;
  }
  console.log(report("ALL", all, seen ? overlapAcc / seen : 0));
}

async function runPool(args: Args): Promise<Map<number, Agg>> {
  const pending = [...args.seeds];
  const results = new Map<number, Agg>();
  const errors: string[] = [];
  const poolSize = Math.max(1, Math.min(args.seeds.length, args.workers));

  const workerDone: Promise<void>[] = [];
  for (let i = 0; i < poolSize; i++) {
    let resolveDone!: () => void;
    workerDone.push(new Promise<void>((resolve) => (resolveDone = resolve)));

    const worker = new Worker(
      import.meta.resolve("./cannon-efficiency-worker.ts"),
      { type: "module" },
    );

    const dispatchNext = (): void => {
      const next = pending.shift();
      if (next === undefined) {
        worker.terminate();
        resolveDone();
        return;
      }
      const request: WorkerRequest = { seed: next, rounds: args.rounds };
      worker.postMessage(request);
    };

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response.ok) {
        results.set(response.seed, response.result);
        Deno.stderr.writeSync(new TextEncoder().encode("."));
      } else {
        errors.push(`seed=${response.seed}: ${response.error}`);
        Deno.stderr.writeSync(new TextEncoder().encode("!"));
      }
      dispatchNext();
    };
    worker.onerror = (event) => {
      errors.push(`worker error: ${event.message}`);
      resolveDone();
    };

    dispatchNext();
  }

  await Promise.all(workerDone);
  Deno.stderr.writeSync(new TextEncoder().encode("\n"));
  if (errors.length > 0) {
    console.error(`Errors (${errors.length}):`);
    for (const err of errors) console.error(`  ${err}`);
  }
  return results;
}

function report(label: string, a: Agg, overlap: number): string {
  const sorted = [...a.dists].sort((x, y) => x - y);
  const capb = mean(a.battleCapable);
  const canb = mean(a.battleCannons);
  return [
    label.padEnd(10),
    String(a.shots).padStart(5),
    capb.toFixed(1).padStart(5),
    canb.toFixed(1).padStart(5),
    (capb ? canb / capb : 0).toFixed(2).padStart(5),
    mean(a.battleShots).toFixed(1).padStart(5),
    mean(a.battleTravel).toFixed(0).padStart(6),
    (a.shots ? a.cursorTravelPx / a.shots : 0).toFixed(0).padStart(8),
    (a.shots ? a.flightT / a.shots : 0).toFixed(3).padStart(6),
    percentile(sorted, 0.9).toFixed(0).padStart(4),
    (a.shots ? a.impacts / a.shots : 0).toFixed(3).padStart(6),
    overlap.toFixed(3).padStart(6),
  ].join("  ");
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function parseArgs(argv: string[]): Args {
  let seeds: number[] = [];
  let rounds = 25;
  let workers = navigator.hardwareConcurrency ?? 4;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--seeds") {
      seeds = argv[++i]!.split(",").map((s) => Number(s.trim()));
    } else if (argv[i] === "--count") {
      const n = Number(argv[++i]);
      // Deterministic spread so baseline/candidate use the same seed set.
      seeds = Array.from({ length: n }, (_, k) => 1000 + k * 137);
    } else if (argv[i] === "--rounds") {
      rounds = Number(argv[++i]);
    } else if (argv[i] === "--workers") {
      workers = Number(argv[++i]);
    }
  }
  if (seeds.length === 0) seeds = [1000, 1137, 1274, 1411, 1548, 1685];
  return { seeds, rounds, workers };
}
