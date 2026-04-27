/**
 * Record a determinism fixture for a given seed.
 *
 * Plays the FULL headless runtime to completion (or `--max-ticks` exhausted)
 * and writes the entire bus event log as a JSON fixture in
 * `test/determinism-fixtures/`. The companion `test/determinism.test.ts`
 * loads each fixture, replays the same scenario, and asserts that the
 * resulting event log is byte-identical.
 *
 * Run when:
 *   - Adding a new fixture for an additional seed
 *   - Updating an existing fixture after an INTENTIONAL change to RNG flow,
 *     event payloads, or game balance (NEVER update to "fix" a determinism
 *     test failure — that almost certainly means determinism is broken)
 *
 * Usage:
 *   deno run -A scripts/record-determinism.ts                         # default: seed 42, classic, 2 rounds
 *   deno run -A scripts/record-determinism.ts --seed 7 --mode modern --rounds 3
 *   deno run -A scripts/record-determinism.ts --timeout-ms 800000
 */

import { createScenario, recordEvents } from "../test/scenario.ts";

interface CliConfig {
  seed: number;
  mode: "classic" | "modern";
  rounds: number;
  timeoutMs: number;
  /** When true, runs the scenario with mobile auto-zoom enabled and writes
   *  the fixture to a `-camera.json` filename. Camera-determinism tests
   *  load these to verify per-phase memory + first-entry default behavior. */
  camera: boolean;
}

interface FixtureFile {
  seed: number;
  opts: {
    seed: number;
    mode: "classic" | "modern";
    rounds: number;
    mobileZoomEnabled?: boolean;
  };
  timeoutMs: number;
  eventCount: number;
  events: ReturnType<typeof recordEvents>;
}

const FIXTURES_DIR = "test/determinism-fixtures";

run();

async function run(): Promise<void> {
  const config = parseArgs();

  const flavor = config.camera ? "+camera" : "";
  console.log(
    `Recording determinism fixture: seed=${config.seed} mode=${config.mode} rounds=${config.rounds}${flavor}`,
  );

  const sc = await createScenario({
    seed: config.seed,
    mode: config.mode,
    rounds: config.rounds,
    mobileZoomEnabled: config.camera ? true : undefined,
  });
  const events = recordEvents(sc);
  sc.runGame({ timeoutMs: config.timeoutMs });

  const fixture: FixtureFile = {
    seed: config.seed,
    opts: {
      seed: config.seed,
      mode: config.mode,
      rounds: config.rounds,
      ...(config.camera ? { mobileZoomEnabled: true } : {}),
    },
    timeoutMs: config.timeoutMs,
    eventCount: events.length,
    events,
  };

  await Deno.mkdir(FIXTURES_DIR, { recursive: true });
  const suffix = config.camera ? "-camera" : "";
  const path = `${FIXTURES_DIR}/seed-${config.seed}-${config.mode}${suffix}.json`;
  await Deno.writeTextFile(path, `${JSON.stringify(fixture, null, 2)}\n`);

  console.log(
    `Wrote ${events.length} events to ${path} (final round=${sc.state.round})`,
  );
}

function parseArgs(): CliConfig {
  const args = Deno.args;
  let seed = 42;
  let mode: "classic" | "modern" = "classic";
  let rounds = 2;
  let timeoutMs = 480_000;
  let camera = false;

  for (let idx = 0; idx < args.length; idx++) {
    const arg = args[idx];
    if (arg === "--seed" && args[idx + 1]) seed = Number(args[++idx]);
    else if (arg === "--mode" && args[idx + 1]) {
      const next = args[++idx]!;
      mode = next === "modern" ? "modern" : "classic";
    } else if (arg === "--rounds" && args[idx + 1])
      rounds = Number(args[++idx]);
    else if (arg === "--timeout-ms" && args[idx + 1]) {
      timeoutMs = Number(args[++idx]);
    } else if (arg === "--camera") {
      camera = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: deno run -A scripts/record-determinism.ts [--seed N] [--mode classic|modern] [--rounds N] [--timeout-ms N] [--camera]",
      );
      Deno.exit(0);
    }
  }

  return { seed, mode, rounds, timeoutMs, camera };
}
