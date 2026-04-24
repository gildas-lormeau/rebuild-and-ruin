/**
 * Batch seed scanner — discovers the smallest seed that satisfies every
 * condition registered in `test/seed-conditions.ts`, in a single pass.
 *
 * Strategy
 * --------
 * 1. Group conditions by `mode` (classic/modern). Each group is scanned
 *    with one set of scenarios; a mode switch starts a new scan.
 * 2. For each seed in 0..max, create a scenario once, install every
 *    not-yet-found condition's matcher, and run the game with an early-exit
 *    predicate that stops as soon as every pending condition has fired.
 * 3. When the run ends (early exit or timeout), record each condition's
 *    seed if its poller returned true.
 * 4. Stop scanning when every condition in the group has a seed.
 *
 * Parallelism
 * -----------
 * 10-round modern matches genuinely take ~750 sim-s each (~5s wall) — no
 * per-seed timeout trimming is safe. Speedup comes from sharding across
 * subprocesses: `--parallel N` spawns N workers, each scans seeds where
 * `seed % N == workerId`, the parent merges hits by taking the min seed
 * per condition. Workers emit newline-delimited JSON on stdout.
 *
 * Output
 * ------
 * Writes `test/seed-fixtures.json` as a flat `{ "condition-name": seed }`
 * map. Tests consume it via `loadSeed(name)` from `test/scenario.ts`.
 *
 * Usage
 * -----
 *   deno run -A scripts/record-seeds.ts [--max N] [--parallel K]
 *
 * The pre-commit hook should run the *verify* pass (not the full rescan)
 * to catch drift fast: re-run every cached seed against its condition and
 * fail loudly if it no longer fires.
 */

import { createScenario } from "../test/scenario.ts";
import {
  SEED_CONDITIONS,
  type SeedCondition,
} from "../test/seed-conditions.ts";

interface CliConfig {
  max: number;
  timeoutMsPerSeed: number;
  parallel: number;
  worker: { id: number; shards: number } | null;
}

interface WorkerHit {
  readonly name: string;
  readonly seed: number;
}

// `tsc --noEmit` type-checks this file as part of the wider project, so the
// module-scope top-level await would trip `--isolatedModules`. Wrap in an
// IIFE to keep the entry point compatible.
void (async () => {
  const config = parseArgs();
  if (config.worker) {
    await runWorker(config);
  } else {
    await runMain(config);
  }
})();

async function runMain(config: CliConfig): Promise<void> {
  const byMode = new Map<"classic" | "modern", Map<string, SeedCondition>>();
  for (const [name, cond] of Object.entries(SEED_CONDITIONS)) {
    let group = byMode.get(cond.mode);
    if (!group) {
      group = new Map();
      byMode.set(cond.mode, group);
    }
    group.set(name, cond);
  }

  console.log(
    `Scanning ${Object.keys(SEED_CONDITIONS).length} conditions across ${byMode.size} mode(s) with ${config.parallel} worker(s)`,
  );
  const start = Date.now();
  const allResults: Record<string, number> = {};
  for (const [mode, group] of byMode) {
    console.log(`\n${mode}: ${group.size} condition(s)`);
    const results =
      config.parallel > 1
        ? await scanModeParallel(mode, group, config)
        : await scanMode(mode, group, config);
    for (const [name, seed] of results) allResults[name] = seed;
    const missing = [...group.keys()].filter((name) => !results.has(name));
    if (missing.length > 0) {
      console.error(
        `\nERROR: ${missing.length} ${mode} condition(s) not found within --max ${config.max}:`,
      );
      for (const name of missing) console.error(`  - ${name}`);
      Deno.exit(1);
    }
  }

  const sorted: Record<string, number> = {};
  for (const name of Object.keys(allResults).sort()) {
    sorted[name] = allResults[name]!;
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const path = new URL("../test/seed-fixtures.json", import.meta.url).pathname;
  await Deno.writeTextFile(path, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(
    `\nWrote ${Object.keys(sorted).length} seeds in ${elapsed}s → test/seed-fixtures.json`,
  );
}

function parseArgs(): CliConfig {
  const args = Deno.args;
  let max = 100;
  // Budget per seed. A 20-round modern match naturally ends in ~1500 sim-s
  // (rounds × ~72 s/round). 1_800_000ms gives ~20% margin so legitimate
  // late-firing conditions aren't truncated.
  let timeoutMsPerSeed = 1_800_000;
  let parallel = 1;
  let worker: CliConfig["worker"] = null;
  for (let idx = 0; idx < args.length; idx++) {
    const arg = args[idx];
    if (arg === "--max" && args[idx + 1]) max = Number(args[++idx]);
    else if (arg === "--timeout-ms" && args[idx + 1]) {
      timeoutMsPerSeed = Number(args[++idx]);
    } else if (arg === "--parallel" && args[idx + 1]) {
      parallel = Math.max(1, Number(args[++idx]));
    } else if (arg === "--worker" && args[idx + 1] && args[idx + 2]) {
      worker = { id: Number(args[++idx]), shards: Number(args[++idx]) };
    }
  }
  return { max, timeoutMsPerSeed, parallel, worker };
}

async function scanModeParallel(
  mode: "classic" | "modern",
  conditions: Map<string, SeedCondition>,
  config: CliConfig,
): Promise<Map<string, number>> {
  const merged = new Map<string, number>();
  const workerCount = config.parallel;
  const scriptUrl = new URL(import.meta.url).pathname;

  const workers = Array.from({ length: workerCount }, (_, id) => {
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        scriptUrl,
        "--max",
        String(config.max),
        "--timeout-ms",
        String(config.timeoutMsPerSeed),
        "--worker",
        String(id),
        String(workerCount),
      ],
      stdout: "piped",
      stderr: "piped",
    });
    return { id, child: cmd.spawn() };
  });

  const start = Date.now();
  const progress = { hits: 0 };
  const onHit = (hit: WorkerHit) => {
    const current = merged.get(hit.name);
    if (current === undefined || hit.seed < current) {
      merged.set(hit.name, hit.seed);
    }
    progress.hits++;
    console.log(
      `  [${((Date.now() - start) / 1000).toFixed(1)}s] hit ${hit.name}=${hit.seed}  covered=${merged.size}/${conditions.size}`,
    );
  };

  await Promise.all(workers.map(({ child }) => drainWorker(child, onHit)));
  return merged;
}

async function drainWorker(
  child: Deno.ChildProcess,
  onHit: (hit: WorkerHit) => void,
): Promise<void> {
  // Forward stderr so worker errors surface in the parent's output.
  const stderrPump = (async () => {
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      Deno.stderr.write(value ?? new Uint8Array());
      void decoder; // silence unused warning
    }
  })();

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIdx = buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line) onHit(JSON.parse(line) as WorkerHit);
      newlineIdx = buffer.indexOf("\n");
    }
  }
  await stderrPump;
  const status = await child.status;
  if (!status.success) {
    throw new Error(`worker exited with code ${status.code}`);
  }
}

async function runWorker(config: CliConfig): Promise<void> {
  const { id, shards } = config.worker!;
  const byMode = new Map<"classic" | "modern", Map<string, SeedCondition>>();
  for (const [name, cond] of Object.entries(SEED_CONDITIONS)) {
    let group = byMode.get(cond.mode);
    if (!group) {
      group = new Map();
      byMode.set(cond.mode, group);
    }
    group.set(name, cond);
  }
  for (const [mode, group] of byMode) {
    await scanMode(
      mode,
      group,
      config,
      (seed) => seed % shards === id,
      (hit) => {
        console.log(JSON.stringify(hit));
      },
    );
  }
}

async function scanMode(
  mode: "classic" | "modern",
  conditions: Map<string, SeedCondition>,
  config: CliConfig,
  seedFilter?: (seed: number) => boolean,
  onHit?: (hit: WorkerHit) => void,
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  const pending = new Set(conditions.keys());
  const maxRounds = Math.max(
    ...Array.from(conditions.values(), (cond) => cond.rounds),
  );

  for (let seed = 0; seed < config.max && pending.size > 0; seed++) {
    if (seedFilter && !seedFilter(seed)) continue;
    let sc;
    try {
      sc = await createScenario({ seed, mode, rounds: maxRounds });
    } catch (err) {
      console.error(`  seed=${seed}  ERROR: ${(err as Error).message}`);
      continue;
    }
    const pollers = new Map<string, () => boolean>();
    for (const name of pending) {
      pollers.set(name, conditions.get(name)!.match(sc));
    }
    // Timeout (no condition fired on this seed) is the expected common
    // case — swallow it so the loop records partial matches and moves on.
    try {
      sc.runUntil(() => Array.from(pollers.values()).every((poll) => poll()), {
        timeoutMs: config.timeoutMsPerSeed,
      });
    } catch {
      // ScenarioTimeoutError — fall through to the per-poller check below.
    }
    const fired: string[] = [];
    for (const [name, poll] of pollers) {
      if (poll()) {
        results.set(name, seed);
        pending.delete(name);
        fired.push(name);
        onHit?.({ name, seed });
      }
    }
    if (!onHit) {
      console.log(
        `  seed=${seed}  covered=${results.size}/${conditions.size}  new=${fired.length > 0 ? fired.join(",") : "(none)"}`,
      );
    }
  }
  return results;
}
