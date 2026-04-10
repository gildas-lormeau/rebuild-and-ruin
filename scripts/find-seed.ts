/**
 * Find seeds that produce specific game state conditions.
 *
 * Runs the FULL headless runtime (same composition root the browser uses)
 * via `createScenario` and reports seeds matching a given condition. Use
 * this to find deterministic seeds for tests that need specific game states.
 *
 * Usage:
 *   deno run -A scripts/find-seed.ts --condition <name> [--rounds N] [--tries N] [--mode modern|classic]
 *
 * Built-in conditions (RNG-driven, observable on GameState):
 *   wildfire               — wildfire modifier active at battle start
 *   crumblingWalls         — crumbling walls modifier active
 *   gruntSurge             — grunt surge modifier active
 *   frozenRiver            — frozen river modifier active
 *   highTide               — high tide modifier active
 *   sinkhole               — sinkhole modifier active
 *   anyModifier            — any environmental modifier active
 *   manyGrunts             — 10+ grunts alive during battle
 *
 * Custom conditions (JS expression, evaluated with `state` and `seq` in scope):
 *   deno run -A scripts/find-seed.ts --expr "state.grunts.length > 10"
 *
 * `seq` is the modifier sequence observed so far (array of ModifierId
 * strings, in firing order). Use it for sequence/history conditions:
 *   deno run -A scripts/find-seed.ts --expr "seq.indexOf('sinkhole') >= 0 && seq.indexOf('high_tide') > seq.indexOf('sinkhole')"
 *
 * The condition is checked on every tick while the runtime advances. Seeds
 * found here are valid for tests because they're discovered by the same
 * runtime the tests use.
 *
 * Examples:
 *   deno run -A scripts/find-seed.ts --condition wildfire
 *   deno run -A scripts/find-seed.ts --condition highTide --tries 200
 *   deno run -A scripts/find-seed.ts --expr "state.round > 3 && state.grunts.length > 8" --rounds 5
 *   deno run -A scripts/find-seed.ts --expr "seq[0] === 'sinkhole' && seq[1] === 'high_tide'" --rounds 8
 */

import { GAME_EVENT } from "../src/shared/game-event-bus.ts";
import type { GameState } from "../src/shared/types.ts";
import { createScenario } from "../test/scenario.ts";

// ---------------------------------------------------------------------------
// Condition registry
// ---------------------------------------------------------------------------

type Condition = (state: GameState, seq: readonly string[]) => boolean;

const CONDITIONS: Record<string, Condition> = {
  wildfire: (state) => state.modern?.activeModifier === "wildfire",
  crumblingWalls: (state) =>
    state.modern?.activeModifier === "crumbling_walls",
  gruntSurge: (state) => state.modern?.activeModifier === "grunt_surge",
  frozenRiver: (state) => state.modern?.activeModifier === "frozen_river",
  highTide: (state) => state.modern?.activeModifier === "high_tide",
  sinkhole: (state) => state.modern?.activeModifier === "sinkhole",
  anyModifier: (state) => state.modern?.activeModifier != null,
  manyGrunts: (state) => state.grunts.length >= 10,
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliConfig {
  condition: string;
  expr: string;
  rounds: number;
  tries: number;
  mode: "modern" | "classic";
  /** Max ticks per seed before giving up (16ms per tick). */
  maxTicksPerSeed: number;
}

function parseArgs(): CliConfig {
  const args = Deno.args;
  let condition = "";
  let expr = "";
  let rounds = 6;
  let tries = 100;
  let mode: "modern" | "classic" = "modern";
  let maxTicksPerSeed = 30000;

  for (let idx = 0; idx < args.length; idx++) {
    const arg = args[idx];
    if (arg === "--condition" && args[idx + 1]) condition = args[++idx]!;
    else if (arg === "--expr" && args[idx + 1]) expr = args[++idx]!;
    else if (arg === "--rounds" && args[idx + 1]) rounds = Number(args[++idx]);
    else if (arg === "--tries" && args[idx + 1]) tries = Number(args[++idx]);
    else if (arg === "--mode" && args[idx + 1]) {
      const next = args[++idx]!;
      mode = next === "classic" ? "classic" : "modern";
    } else if (arg === "--max-ticks" && args[idx + 1]) {
      maxTicksPerSeed = Number(args[++idx]);
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: deno run -A scripts/find-seed.ts --condition <name> [--rounds N] [--tries N] [--mode modern|classic] [--max-ticks N]",
      );
      console.log("\nConditions:", Object.keys(CONDITIONS).join(", "));
      console.log(
        'Or use --expr \'<JS expression>\' with `state` (GameState) in scope.',
      );
      Deno.exit(0);
    }
  }

  if (!condition && !expr) {
    console.error(
      "Error: --condition or --expr required. Use --help for usage.",
    );
    Deno.exit(1);
  }

  return { condition, expr, rounds, tries, mode, maxTicksPerSeed };
}

// ---------------------------------------------------------------------------
// Runner — drives the full runtime per seed and checks the predicate per tick
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const config = parseArgs();

  const check: Condition = config.expr
    ? (new Function("state", "seq", `return (${config.expr})`) as Condition)
    : CONDITIONS[config.condition]!;

  if (!check) {
    console.error(`Unknown condition: "${config.condition}"`);
    console.error("Available:", Object.keys(CONDITIONS).join(", "));
    Deno.exit(1);
  }

  const label = config.expr ? `expr: ${config.expr}` : config.condition;
  console.log(
    `Searching for seeds matching "${label}" (${config.tries} seeds, ${config.rounds} rounds, ${config.mode} mode)\n`,
  );

  const matches: { seed: number; round: number; seq: string[] }[] = [];
  const startTime = Date.now();

  for (let seed = 0; seed < config.tries; seed++) {
    try {
      const sc = await createScenario({
        seed,
        mode: config.mode,
        rounds: config.rounds,
      });
      // Track modifier banners as they fire — exposed to expressions as `seq`.
      const seq: string[] = [];
      sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
        if (ev.modifierId) seq.push(ev.modifierId);
      });
      const ticksUsed = sc.runUntil(
        () => check(sc.state, seq),
        config.maxTicksPerSeed,
      );
      if (ticksUsed >= 0) {
        matches.push({ seed, round: sc.state.round, seq: [...seq] });
        const seqStr = seq.length > 0 ? `  seq=[${seq.join(",")}]` : "";
        console.log(`  seed=${seed}  round=${sc.state.round}${seqStr}`);
      }
    } catch {
      // Some seeds produce unplayable maps or runtime errors — skip.
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (matches.length === 0) {
    console.log(
      `\nNo seeds found in ${elapsed}s. Try increasing --tries or --rounds.`,
    );
    Deno.exit(1);
  }

  console.log(`\n${matches.length} match(es) in ${elapsed}s`);
  console.log(
    `\nRecommended for test: seed=${matches[0]!.seed}, rounds=${matches[0]!.round + 1}`,
  );
}

run();
