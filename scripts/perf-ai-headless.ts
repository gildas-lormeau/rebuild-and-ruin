/**
 * Headless runner for CPU-profiling the AI's WALL_BUILD (and full-game)
 * work. Designed to be invoked under Deno's native CPU profiler:
 *
 *   deno run --cpu-prof --cpu-prof-dir tmp/perf --cpu-prof-name ai-cpu.cpuprofile \
 *     -A scripts/perf-ai-headless.ts [--seed N] [--mode classic|modern] [--rounds N]
 *
 * Then analyze with:
 *   deno run -A scripts/analyze-cpu.ts tmp/perf/ai-cpu.cpuprofile --filter src/ai/
 *
 * No rendering, no canvas, no 3D — everything in the profile is sim/AI/bus.
 * Filter src/ai/ in the analyzer to isolate AI self-time.
 */

import { createScenario } from "../test/scenario.ts";

const DEFAULT_SEED = 42;
const DEFAULT_MODE: "classic" | "modern" = "classic";
const DEFAULT_ROUNDS = 8;
// Sim-ms budget for runGame. 8 rounds well under 30 minutes of sim time.
const TIMEOUT_MS = 1_800_000;

await main();

async function main(): Promise<void> {
  const args = parseArgs(Deno.args);
  const seed = args.seed ?? DEFAULT_SEED;
  const mode = args.mode ?? DEFAULT_MODE;
  const rounds = args.rounds ?? DEFAULT_ROUNDS;
  console.log(`headless run: seed=${seed} mode=${mode} rounds=${rounds}`);
  const sc = await createScenario({ seed, mode, rounds });
  const startedAt = performance.now();
  sc.runGame({ timeoutMs: TIMEOUT_MS });
  const elapsedMs = performance.now() - startedAt;
  console.log(`runGame done in ${elapsedMs.toFixed(0)} ms wall`);
}

function parseArgs(raw: readonly string[]): {
  seed: number;
  mode: "classic" | "modern";
  rounds: number;
} {
  let seed: number | undefined;
  let mode: "classic" | "modern" | undefined;
  let rounds: number | undefined;
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
    }
  }
  return {
    seed: seed ?? DEFAULT_SEED,
    mode: mode ?? DEFAULT_MODE,
    rounds: rounds ?? DEFAULT_ROUNDS,
  };
}
