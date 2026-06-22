/**
 * Record determinism fixtures.
 *
 * Plays the FULL headless runtime to completion and writes the entire bus
 * event log as a JSON fixture in `test/determinism-fixtures/`. The companion
 * `test/determinism.test.ts` loads each fixture, replays the same scenario,
 * and asserts that the resulting event log is byte-identical.
 *
 * Run when:
 *   - Adding a new fixture for an additional seed
 *   - Updating fixtures after an INTENTIONAL dynamics/RNG/payload change.
 *     NEVER re-record to "fix" a failing determinism test without first
 *     confirming the runtime is still deterministic — run
 *     `npm run check-determinism`, which classifies each fixture as MATCHES /
 *     SAFE-RERECORD / BUG by replaying it twice. Only re-record SAFE-RERECORD.
 *
 * Usage:
 *   deno run -A scripts/record-determinism.ts                  # default: seed 42, classic, 2 rounds
 *   deno run -A scripts/record-determinism.ts --seed 7 --mode modern --rounds 3
 *   deno run -A scripts/record-determinism.ts --camera
 *   deno run -A scripts/record-determinism.ts --all            # re-record every existing fixture in place
 */

import {
  createScenario,
  type RecordedEvent,
  recordEvents,
} from "../test/scenario.ts";

export interface FixtureOpts {
  seed: number;
  mode: "classic" | "modern";
  rounds: number;
  mobileZoomEnabled?: boolean;
}

export interface FixtureFile {
  seed: number;
  opts: FixtureOpts;
  timeoutMs: number;
  eventCount: number;
  events: RecordedEvent[];
}

interface CliConfig {
  seed: number;
  mode: "classic" | "modern";
  rounds: number;
  timeoutMs: number;
  camera: boolean;
  all: boolean;
}

export const FIXTURES_DIR = "test/determinism-fixtures";
/**
 * Coverage invariants a fixture exists to lock — re-recording must preserve
 * them, else the fixture silently keeps passing while testing nothing. Keyed
 * by a substring of the fixture filename. (The balloon fixture is the known
 * landmine: a dynamics change can shift its seed's cannon elections away from
 * Propaganda Balloons, leaving a determinism fixture with zero balloon anims.)
 */
export const COVERAGE: {
  match: string;
  event: string;
  min: number;
  note: string;
}[] = [
  {
    match: "balloon",
    event: "balloonAnimStart",
    min: 1,
    note: "balloon-anim sequencing",
  },
];

/** Index of the first differing event, or -1 if the two logs are identical. */
export function firstDivergence(
  a: RecordedEvent[],
  b: RecordedEvent[],
): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return i;
  }
  return a.length === b.length ? -1 : n;
}

if (import.meta.main) {
  const config = parseArgs();
  await (config.all ? recordAll() : recordOne(config));
}

/** Re-record every fixture already in FIXTURES_DIR, writing back to its own
 *  filename (preserving -balloon / -camera suffixes) and asserting coverage. */
async function recordAll(): Promise<void> {
  const names = [...Deno.readDirSync(FIXTURES_DIR)]
    .filter((e) => e.isFile && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();
  console.log(`Re-recording ${names.length} fixtures in ${FIXTURES_DIR}/ …`);
  for (const name of names) {
    const path = `${FIXTURES_DIR}/${name}`;
    const prev: FixtureFile = JSON.parse(Deno.readTextFileSync(path));
    const events = await recordFixtureEvents(prev.opts, prev.timeoutMs);
    assertCoverage(name, events); // throws (and aborts --all) if coverage lost
    await writeFixture(path, toFixture(prev.opts, prev.timeoutMs, events));
    const cov = COVERAGE.filter((c) => name.includes(c.match))
      .map(
        (c) => ` ${c.event}=${events.filter((e) => e.type === c.event).length}`,
      )
      .join("");
    console.log(
      `  ✓ ${name.padEnd(32)} ${String(events.length).padStart(6)} events${cov}`,
    );
  }
  console.log("Done. Verify with: npm run test:determinism");
}

/** Throw if a re-recorded fixture lost a coverage invariant it exists to lock. */
export function assertCoverage(
  fixtureName: string,
  events: RecordedEvent[],
): void {
  for (const cov of COVERAGE) {
    if (!fixtureName.includes(cov.match)) continue;
    const count = events.filter((e) => e.type === cov.event).length;
    if (count < cov.min) {
      throw new Error(
        `${fixtureName}: lost ${cov.note} coverage (${cov.event}=${count} < ${cov.min}). ` +
          `A dynamics change shifted this seed — re-derive a new seed that still exercises it; ` +
          `do NOT commit this fixture.`,
      );
    }
  }
}

async function recordOne(config: CliConfig): Promise<void> {
  const opts: FixtureOpts = {
    seed: config.seed,
    mode: config.mode,
    rounds: config.rounds,
    ...(config.camera ? { mobileZoomEnabled: true } : {}),
  };
  console.log(
    `Recording determinism fixture: seed=${config.seed} mode=${config.mode} rounds=${config.rounds}${config.camera ? "+camera" : ""}`,
  );
  const events = await recordFixtureEvents(opts, config.timeoutMs);
  const suffix = config.camera ? "-camera" : "";
  const path = `${FIXTURES_DIR}/seed-${config.seed}-${config.mode}${suffix}.json`;
  await Deno.mkdir(FIXTURES_DIR, { recursive: true });
  await writeFixture(path, toFixture(opts, config.timeoutMs, events));
  console.log(`Wrote ${events.length} events to ${path}`);
}

/** Play one scenario to completion and return its bus event log. Mirrors the
 *  replay path in test/determinism.test.ts exactly (no await on runGame — the
 *  headless runtime runs the loop synchronously). */
export async function recordFixtureEvents(
  opts: FixtureOpts,
  timeoutMs: number,
): Promise<RecordedEvent[]> {
  const sc = await createScenario({
    seed: opts.seed,
    mode: opts.mode,
    rounds: opts.rounds,
    mobileZoomEnabled: opts.mobileZoomEnabled,
  });
  const events = recordEvents(sc);
  sc.runGame({ timeoutMs });
  return events;
}

function toFixture(
  opts: FixtureOpts,
  timeoutMs: number,
  events: RecordedEvent[],
): FixtureFile {
  return {
    seed: opts.seed,
    opts,
    timeoutMs,
    eventCount: events.length,
    events,
  };
}

async function writeFixture(path: string, fixture: FixtureFile): Promise<void> {
  await Deno.writeTextFile(path, `${JSON.stringify(fixture, null, 2)}\n`);
}

function parseArgs(): CliConfig {
  const args = Deno.args;
  const config: CliConfig = {
    seed: 42,
    mode: "classic",
    rounds: 2,
    timeoutMs: 480_000,
    camera: false,
    all: false,
  };
  for (let idx = 0; idx < args.length; idx++) {
    const arg = args[idx];
    if (arg === "--seed" && args[idx + 1]) config.seed = Number(args[++idx]);
    else if (arg === "--mode" && args[idx + 1])
      config.mode = args[++idx] === "modern" ? "modern" : "classic";
    else if (arg === "--rounds" && args[idx + 1])
      config.rounds = Number(args[++idx]);
    else if (arg === "--timeout-ms" && args[idx + 1])
      config.timeoutMs = Number(args[++idx]);
    else if (arg === "--camera") config.camera = true;
    else if (arg === "--all") config.all = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: record-determinism.ts [--all] [--seed N] [--mode classic|modern] [--rounds N] [--timeout-ms N] [--camera]",
      );
      Deno.exit(0);
    }
  }
  return config;
}
