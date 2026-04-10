/**
 * Find seeds that produce specific game state conditions.
 *
 * Runs headless scenarios at high speed (no browser, no rendering) and reports
 * seeds matching a given condition. Use this to find deterministic seeds for
 * e2e tests that need specific game states.
 *
 * Usage:
 *   deno run -A scripts/find-seed.ts --condition <name> [--rounds N] [--tries N] [--mode modern|classic]
 *
 * Built-in conditions (RNG-driven, observable via scenario helpers):
 *   wildfire               — wildfire modifier active at battle start
 *   crumblingWalls         — crumbling walls modifier active
 *   gruntSurge             — grunt surge modifier active
 *   frozenRiver            — frozen river modifier active
 *   highTide               — high tide modifier active
 *   sinkhole               — sinkhole modifier active
 *   anyModifier            — any environmental modifier active
 *   manyGrunts             — 10+ grunts alive during battle
 *
 * Note: upgrade-dependent conditions (masterBuilderLockout, reinforcedWalls, etc.)
 * cannot be found here because scenario helpers skip the upgrade pick dialog.
 * For those, use the e2e test with mode: "modern" and enough rounds.
 *
 * Custom conditions (JS expression, evaluated with `state` in scope):
 *   deno run -A scripts/find-seed.ts --expr "state.grunts.length > 10"
 *
 * The condition is checked at EVERY phase boundary (after cannon, after battle,
 * during build) so transient state like lockout is caught.
 *
 * Examples:
 *   deno run -A scripts/find-seed.ts --condition masterBuilderLockout
 *   deno run -A scripts/find-seed.ts --condition wildfire --tries 200
 *   deno run -A scripts/find-seed.ts --expr "state.round > 3 && state.grunts.length > 8" --rounds 5
 */

import { createScenario } from "../test/scenario-helpers.ts";
import { GAME_MODE_MODERN } from "../src/shared/game-constants.ts";
import { setGameMode, type GameState } from "../src/shared/types.ts";

// ---------------------------------------------------------------------------
// Condition registry
// ---------------------------------------------------------------------------

type Condition = (state: GameState) => boolean;

const CONDITIONS: Record<string, Condition> = {
  wildfire: (state) =>
    state.modern?.activeModifier === "wildfire",

  crumblingWalls: (state) =>
    state.modern?.activeModifier === "crumbling_walls",

  gruntSurge: (state) =>
    state.modern?.activeModifier === "grunt_surge",

  frozenRiver: (state) =>
    state.modern?.activeModifier === "frozen_river",

  highTide: (state) =>
    state.modern?.activeModifier === "high_tide",

  sinkhole: (state) =>
    state.modern?.activeModifier === "sinkhole",

  anyModifier: (state) =>
    state.modern?.activeModifier != null,

  manyGrunts: (state) =>
    state.grunts.length >= 10,
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = Deno.args;
  let condition = "";
  let expr = "";
  let rounds = 6;
  let tries = 100;
  let mode = "modern";

  for (let idx = 0; idx < args.length; idx++) {
    const arg = args[idx];
    if (arg === "--condition" && args[idx + 1]) condition = args[++idx]!;
    else if (arg === "--expr" && args[idx + 1]) expr = args[++idx]!;
    else if (arg === "--rounds" && args[idx + 1]) rounds = Number(args[++idx]);
    else if (arg === "--tries" && args[idx + 1]) tries = Number(args[++idx]);
    else if (arg === "--mode" && args[idx + 1]) mode = args[++idx]!;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: deno run -A scripts/find-seed.ts --condition <name> [--rounds N] [--tries N]",
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

  return { condition, expr, rounds, tries, mode };
}

// ---------------------------------------------------------------------------
// Runner — checks condition at every phase boundary within each round
// ---------------------------------------------------------------------------

async function run() {
  const config = parseArgs();

  const check: Condition = config.expr
    ? (new Function("state", `return (${config.expr})`) as Condition)
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

  const matches: { seed: number; round: number }[] = [];
  const startTime = Date.now();

  for (let seed = 0; seed < config.tries; seed++) {
    try {
      const scenario = await createScenario(seed);
      if (config.mode === "modern") {
        setGameMode(scenario.state, GAME_MODE_MODERN);
      }

      let found = false;
      for (let round = 0; round < config.rounds; round++) {
        // Run cannon phase
        scenario.runCannon();
        if (check(scenario.state)) {
          matches.push({ seed, round: round + 1 });
          found = true;
          break;
        }

        // Run battle → enters build phase (sets modifiers via RNG)
        scenario.runBattle();
        if (check(scenario.state)) {
          matches.push({ seed, round: round + 1 });
          found = true;
          break;
        }

        // Run build phase
        scenario.runBuild();
        if (check(scenario.state)) {
          matches.push({ seed, round: round + 1 });
          found = true;
          break;
        }

        // Finalize build (life loss, reselection)
        const result = scenario.finalizeBuild();
        if (result.needsReselect.length > 0) {
          scenario.processReselection(result.needsReselect);
        }
        if (scenario.state.players.every((player) => player.eliminated)) break;
      }

      if (found) {
        console.log(`  seed=${seed}  round=${matches[matches.length - 1]!.round}`);
      }
    } catch {
      // Some seeds produce unplayable maps — skip
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (matches.length === 0) {
    console.log(`\nNo seeds found in ${elapsed}s. Try increasing --tries or --rounds.`);
    Deno.exit(1);
  }

  console.log(`\n${matches.length} match(es) in ${elapsed}s`);
  console.log(
    `\nRecommended for e2e test: seed=${matches[0]!.seed}, rounds=${matches[0]!.round + 1}`,
  );
}

run();
