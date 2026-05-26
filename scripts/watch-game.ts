/**
 * Watch a game: run a seed end-to-end and print event narrative + (optionally)
 * a build-phase trace for one specific player/round.
 *
 * Usage:
 *   deno run -A scripts/watch-game.ts --seed 42
 *   deno run -A scripts/watch-game.ts --seed 42 --mode classic --rounds 10
 *   deno run -A scripts/watch-game.ts --seed 42 --round 3
 *   deno run -A scripts/watch-game.ts --seed 555555 --build-trace 26 GOLD
 *
 * --build-trace ROUND PLAYER captures the AI's per-placement build decisions
 * (target tower, gap set before/after, placement position relative to ring)
 * for ONE player ONE round — the format that makes "why did GOLD fail to
 * enclose in r26?" answerable.
 *
 * Body wrapped in main() because Biome hoists top-level consts past
 * their init-order dependencies.
 */

import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import {
  type BuildTraceObserver,
  createBuildTraceObserver,
} from "../test/build-trace-observer.ts";
import { createNarrativeObserver } from "../test/narrative-observer.ts";
import { createScenario, waitForEvent } from "../test/scenario.ts";

interface Args {
  seed: number | undefined;
  mode: "classic" | "modern";
  rounds: number;
  round: number | undefined;
  buildTrace: { round: number; playerId: 0 | 1 | 2 } | undefined;
}

const PLAYER_NAMES = ["RED", "BLUE", "GOLD"] as const;

await main();

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.seed === undefined) {
    console.error(
      "Usage: deno run -A scripts/watch-game.ts --seed N [--mode classic|modern] [--rounds N] [--round N] [--build-trace ROUND PLAYER]",
    );
    Deno.exit(1);
  }

  const sc = await createScenario({
    seed: args.seed,
    mode: args.mode,
    rounds: args.rounds + 1,
  });
  const narrative = createNarrativeObserver();
  narrative.attach(sc);

  let buildTrace: BuildTraceObserver | undefined;
  if (args.buildTrace) {
    buildTrace = createBuildTraceObserver(args.buildTrace);
    buildTrace.attach();
  }

  try {
    waitForEvent(sc, GAME_EVENT.ROUND_END, (ev) => ev.round === args.rounds, {
      // Scale sim-ms budget with round count. Survival uses ~183s sim per
      // round; 200s/round leaves headroom for occasional stalls.
      timeoutMs: 200_000 * args.rounds,
      label: `seed=${args.seed} r${args.rounds} end`,
    });
  } catch {
    // Game may have ended early via last-player-standing — partial data ok.
  } finally {
    narrative.detach();
    buildTrace?.detach();
  }

  console.log(
    `seed=${args.seed} mode=${args.mode} rounds=${args.rounds}${args.round !== undefined ? ` (filtered to r${args.round})` : ""}`,
  );

  const lines = filterByRound(narrative.lines, args.round);
  if (lines.length === 0) {
    console.error("No narrative captured");
    Deno.exit(1);
  }
  for (const line of lines) console.log(line);

  if (buildTrace) {
    console.log();
    for (const line of buildTrace.lines) console.log(line);
  }

  Deno.exit(0);
}

/** Filter narrative lines to a single round. Lines are scanned in order:
 *  a "── rN PHASE ──" header opens a round's section. */
function filterByRound(
  lines: readonly string[],
  round: number | undefined,
): string[] {
  if (round === undefined) return [...lines];
  const headerPrefix = `── r${round} `;
  const roundEndPrefix = `r${round} END:`;
  const gameEndPrefix = `GAME END r${round}:`;
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.startsWith("── r")) {
      inside = line.startsWith(headerPrefix);
      if (inside) out.push(line);
      continue;
    }
    if (line.startsWith(roundEndPrefix) || line.startsWith(gameEndPrefix)) {
      out.push(line);
      continue;
    }
    if (inside) out.push(line);
  }
  return out;
}

function parseArgs(): Args {
  const argv = Deno.args;
  let seed: number | undefined;
  let mode: "classic" | "modern" = "modern";
  let rounds = 3;
  let round: number | undefined;
  let buildTrace: { round: number; playerId: 0 | 1 | 2 } | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--seed") seed = Number(argv[++i]);
    else if (flag === "--mode") {
      const value = argv[++i];
      if (value !== "classic" && value !== "modern") {
        console.error(`Invalid --mode: ${value} (expected classic or modern)`);
        Deno.exit(1);
      }
      mode = value;
    } else if (flag === "--rounds") rounds = Number(argv[++i]);
    else if (flag === "--round") round = Number(argv[++i]);
    else if (flag === "--build-trace") {
      const roundArg = Number(argv[++i]);
      const playerArg = argv[++i]?.toUpperCase();
      const idx = PLAYER_NAMES.indexOf(
        playerArg as (typeof PLAYER_NAMES)[number],
      );
      if (!Number.isFinite(roundArg) || idx < 0) {
        console.error(
          `Invalid --build-trace ARGS: expected '--build-trace ROUND_NUM PLAYER' (PLAYER in RED|BLUE|GOLD)`,
        );
        Deno.exit(1);
      }
      buildTrace = { round: roundArg, playerId: idx as 0 | 1 | 2 };
      // Ensure the round we're tracing is actually played.
      if (rounds < roundArg) rounds = roundArg;
    } else {
      console.error(`Unknown flag: ${flag}`);
      Deno.exit(1);
    }
  }
  return { seed, mode, rounds, round, buildTrace };
}
