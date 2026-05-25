/**
 * Watch a game: run a seed end-to-end and print the narrative observer's
 * play-by-play to stdout. Thin wrapper around test/narrative-observer.ts —
 * the observer does the actual event-to-text translation.
 *
 * Usage:
 *   deno run -A scripts/watch-game.ts --seed 42
 *   deno run -A scripts/watch-game.ts --seed 42 --mode classic --rounds 10
 *   deno run -A scripts/watch-game.ts --seed 42 --round 3
 *
 * Tip: redirect to a file when the output is large
 *   deno run -A scripts/watch-game.ts --seed 42 > /tmp/g.log
 *
 * Body wrapped in main() because Biome hoists top-level consts past
 * their init-order dependencies.
 */

import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { createNarrativeObserver } from "../test/narrative-observer.ts";
import { createScenario, waitForEvent } from "../test/scenario.ts";

interface Args {
  seed: number | undefined;
  mode: "classic" | "modern";
  rounds: number;
  round: number | undefined;
}

await main();

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.seed === undefined) {
    console.error(
      "Usage: deno run -A scripts/watch-game.ts --seed N [--mode classic|modern] [--rounds N] [--round N]",
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

  Deno.exit(0);
}

/** Filter narrative lines to a single round. Lines are scanned in order:
 *  a "────── Round N ──────" header opens a round's section; a subsequent
 *  header (or end-of-stream) closes it. ROUND_END / GAME_END / phase-header
 *  lines with explicit `(rN)` / `[ROUND_END rN]` / `[GAME_END rN]` are also
 *  matched directly so the filter still works when the round divider wasn't
 *  emitted (e.g. round 1 starts without a ROUND_START in the bus). */
function filterByRound(
  lines: readonly string[],
  round: number | undefined,
): string[] {
  if (round === undefined) return [...lines];
  const target = `Round ${round}`;
  const targetTag = `(r${round})`;
  const targetRoundEnd = `[ROUND_END r${round}]`;
  const targetGameEnd = `[GAME_END r${round}]`;
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.startsWith("──────")) {
      inside = line.includes(target);
      if (inside) out.push(line);
      continue;
    }
    if (
      inside ||
      line.includes(targetTag) ||
      line.startsWith(targetRoundEnd) ||
      line.startsWith(targetGameEnd)
    ) {
      out.push(line);
    }
  }
  return out;
}

function parseArgs(): Args {
  const argv = Deno.args;
  let seed: number | undefined;
  let mode: "classic" | "modern" = "modern";
  let rounds = 3;
  let round: number | undefined;
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
    else {
      console.error(`Unknown flag: ${flag}`);
      Deno.exit(1);
    }
  }
  return { seed, mode, rounds, round };
}
