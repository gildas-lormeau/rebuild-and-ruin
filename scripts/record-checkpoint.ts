/**
 * Record a phase-test checkpoint fixture.
 *
 * Boots a headless runtime, AI-drives it to the requested `<phase>:<round>`
 * predicate, captures a `FullStateMessage` via `createFullStateMessage`,
 * and writes a complete `FixtureFile` JSON ready to feed to
 * `createPhaseScenario`. Used to author round-≥2 phase tests, where
 * AI-replay from boot would be too slow to do inline in the test.
 *
 * Usage:
 *   deno run -A scripts/record-checkpoint.ts \
 *     --seed 42 --mode classic --rounds 5 \
 *     --until wall_build:2 \
 *     --out test/phase-tests/fixtures/wall-build/round2-default.json
 *
 *   # Modern-mode example
 *   deno run -A scripts/record-checkpoint.ts \
 *     --seed 7 --mode modern --rounds 5 --until cannon_place:3 \
 *     --out test/phase-tests/fixtures/cannon-place/round3-modern.json
 */

import { createFullStateMessage } from "../src/online/online-serialize.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import type { FixtureFile } from "../test/phase-tests/types.ts";
import {
  createScenario,
  waitForPhase,
  waitUntilRound,
} from "../test/scenario.ts";

interface CliConfig {
  seed: number;
  mode: "classic" | "modern";
  rounds: number;
  untilPhase: Phase;
  untilRound: number;
  out: string;
  notes?: string;
  timeoutSec?: number;
}

run();

async function run(): Promise<void> {
  const config = parseArgs();

  console.log(
    `Recording checkpoint: seed=${config.seed} mode=${config.mode} ` +
      `until=${config.untilPhase}:${config.untilRound} → ${config.out}`,
  );

  const sc = await createScenario({
    seed: config.seed,
    mode: config.mode,
    rounds: config.rounds,
  });

  // Drive to (round, phase). Round-1 needs phase-only; rounds ≥ 2 must
  // wait for ROUND_START first or `waitForPhase` would catch an earlier
  // round's instance of the same phase (e.g. round-1 WALL_BUILD).
  // Default 180s budget mirrors what existing round-≥2 tests use — full
  // rounds of AI gameplay can take 30–60s each in sim-time. For deep rounds
  // (24+), allow CLI override via --timeout-sec.
  const timeoutMs = config.timeoutSec ? config.timeoutSec * 1000 : 180_000;
  if (config.untilRound > 1) {
    waitUntilRound(sc, config.untilRound, { timeoutMs });
  }
  waitForPhase(sc, config.untilPhase, { timeoutMs });

  if (sc.state.round !== config.untilRound) {
    throw new Error(
      `expected round ${config.untilRound}, runtime is at round ${sc.state.round} ` +
        `(phase events fired but round mismatched — re-check your --until value)`,
    );
  }

  const checkpoint = createFullStateMessage(sc.state, 0);

  const fixture: FixtureFile = {
    version: 1,
    seed: config.seed,
    mode: config.mode,
    rounds: config.rounds,
    entryPhase: config.untilPhase,
    round: config.untilRound,
    checkpoint,
    ...(config.notes ? { notes: config.notes } : {}),
  };

  await Deno.writeTextFile(config.out, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(
    `Wrote checkpoint at phase=${sc.state.phase} round=${sc.state.round} ` +
      `timer=${sc.state.timer.toFixed(2)} to ${config.out}`,
  );
}

function parseArgs(): CliConfig {
  const args = Deno.args;
  let seed: number | undefined;
  let mode: "classic" | "modern" = "classic";
  let rounds = 5;
  let untilSpec: string | undefined;
  let out: string | undefined;
  let notes: string | undefined;
  let timeoutSec: number | undefined;

  for (let idx = 0; idx < args.length; idx++) {
    const arg = args[idx];
    if (arg === "--seed" && args[idx + 1]) seed = Number(args[++idx]);
    else if (arg === "--mode" && args[idx + 1]) {
      const next = args[++idx]!;
      mode = next === "modern" ? "modern" : "classic";
    } else if (arg === "--rounds" && args[idx + 1]) {
      rounds = Number(args[++idx]);
    } else if (arg === "--until" && args[idx + 1]) {
      untilSpec = args[++idx];
    } else if (arg === "--out" && args[idx + 1]) {
      out = args[++idx];
    } else if (arg === "--notes" && args[idx + 1]) {
      notes = args[++idx];
    } else if (arg === "--timeout-sec" && args[idx + 1]) {
      timeoutSec = Number(args[++idx]);
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      Deno.exit(0);
    }
  }

  if (seed === undefined) fail("--seed is required");
  if (!untilSpec) fail("--until <phase>:<round> is required");
  if (!out) fail("--out <path> is required");

  const [phaseStr, roundStr] = untilSpec!.split(":");
  if (!phaseStr || !roundStr) {
    fail(`--until must be <phase>:<round>, got "${untilSpec}"`);
  }
  const untilPhase = parsePhase(phaseStr!);
  const untilRound = Number(roundStr);
  if (!Number.isInteger(untilRound) || untilRound < 1) {
    fail(`--until round must be a positive integer, got "${roundStr}"`);
  }
  if (rounds < untilRound) {
    fail(
      `--rounds (${rounds}) must be ≥ --until round (${untilRound}) ` +
        `so the runtime has room to reach the target before game-over`,
    );
  }

  return {
    seed: seed!,
    mode,
    rounds,
    untilPhase,
    untilRound,
    out: out!,
    notes,
    timeoutSec,
  };
}

function parsePhase(spec: string): Phase {
  const upper = spec.toUpperCase() as keyof typeof Phase;
  const phase = Phase[upper];
  if (phase === undefined) {
    fail(
      `unknown phase "${spec}" — expected one of: ` +
        Object.keys(Phase)
          .map((name) => name.toLowerCase())
          .join(", "),
    );
  }
  return phase;
}

function fail(msg: string): never {
  console.error(`record-checkpoint: ${msg}`);
  printUsage();
  Deno.exit(1);
}

function printUsage(): void {
  console.log(
    `Usage: deno run -A scripts/record-checkpoint.ts ` +
      `--seed N --mode classic|modern --rounds N ` +
      `--until <phase>:<round> --out <path> [--notes "..."]`,
  );
  console.log("");
  console.log("  Phases (lowercase or uppercase):");
  for (const name of Object.keys(Phase)) {
    console.log(`    ${name.toLowerCase()}`);
  }
}
