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
 * Output
 * ------
 * Writes `test/seed-fixtures.json` as a flat `{ "condition-name": seed }`
 * map. Tests consume it via `loadSeed(name)` from `test/scenario.ts`.
 *
 * Usage
 * -----
 *   deno run -A scripts/record-seeds.ts [--max N]
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
}

run();

async function run(): Promise<void> {
  const config = parseArgs();
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
    `Scanning ${Object.keys(SEED_CONDITIONS).length} conditions across ${byMode.size} mode(s)`,
  );
  const start = Date.now();
  const allResults: Record<string, number> = {};
  for (const [mode, group] of byMode) {
    console.log(`\n${mode}: ${group.size} condition(s)`);
    const results = await scanMode(mode, group, config);
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
  let timeoutMsPerSeed = 960_000;
  for (let idx = 0; idx < args.length; idx++) {
    const arg = args[idx];
    if (arg === "--max" && args[idx + 1]) max = Number(args[++idx]);
    else if (arg === "--timeout-ms" && args[idx + 1]) {
      timeoutMsPerSeed = Number(args[++idx]);
    }
  }
  return { max, timeoutMsPerSeed };
}

async function scanMode(
  mode: "classic" | "modern",
  conditions: Map<string, SeedCondition>,
  config: CliConfig,
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  const pending = new Set(conditions.keys());
  const maxRounds = Math.max(
    ...Array.from(conditions.values(), (cond) => cond.rounds),
  );

  for (let seed = 0; seed < config.max && pending.size > 0; seed++) {
    let sc;
    try {
      sc = await createScenario({ seed, mode, rounds: maxRounds });
    } catch (err) {
      console.log(`  seed=${seed}  ERROR: ${(err as Error).message}`);
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
      }
    }
    console.log(
      `  seed=${seed}  covered=${results.size}/${conditions.size}  new=${fired.length > 0 ? fired.join(",") : "(none)"}`,
    );
  }
  return results;
}
