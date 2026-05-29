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
 * --rounds N is a WATCH BUDGET — stop observing after round N closes. It does
 * NOT change game state: the match itself defaults to to-the-death
 * (state.maxRounds = Infinity), so RNG-consuming code gated on maxRounds
 * (e.g. upgrade-system's "skip pick for the final round") never trips. That
 * means `--rounds 29` and `--rounds 50` produce IDENTICAL r29 state. Use
 * --match-rounds M to constrain the match length explicitly (rare —
 * investigation reproduction usually wants the default).
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
import {
  createScenario,
  ScenarioTimeoutError,
  waitForEvent,
} from "../test/scenario.ts";

interface Args {
  seed: number | undefined;
  mode: "classic" | "modern";
  /** Watch budget — stop observing after this round's ROUND_END. */
  rounds: number;
  /** Match-length cap (state.maxRounds). 0 = to-the-death (Infinity).
   *  Default 0 so --rounds never silently shifts AI-visible state. */
  matchRounds: number;
  round: number | undefined;
  buildTrace: { round: number; playerId: 0 | 1 | 2 } | undefined;
}

const PLAYER_NAMES = ["RED", "BLUE", "GOLD"] as const;
const HELP_TEXT = `Watch a game: run a seed end-to-end and print an event narrative, optionally
with a build-phase trace for one specific player/round.

Usage:
  deno run -A scripts/watch-game.ts --seed N [options]
  npm run watch-game -- --seed N [options]

Options:
  --seed N               Seed to play (REQUIRED).
  --mode classic|modern  Game mode (default: modern).
  --rounds N             Watch budget — stop observing after round N closes
                         (default: 3). Does NOT change game state.
  --match-rounds M       Match-length cap (state.maxRounds). 0 = to-the-death
                         (default: 0). Use to constrain match length explicitly.
  --round N              Filter the printed narrative to a single round.
  --build-trace ROUND PLAYER
                         Capture the AI's per-placement build decisions for one
                         player one round. PLAYER in RED|BLUE|GOLD.
  --help, -h             Show this help and exit.

Examples:
  deno run -A scripts/watch-game.ts --seed 42
  deno run -A scripts/watch-game.ts --seed 42 --mode classic --rounds 10
  deno run -A scripts/watch-game.ts --seed 42 --round 3
  deno run -A scripts/watch-game.ts --seed 555555 --build-trace 26 GOLD`;

await main();

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.seed === undefined) {
    console.error(
      "Usage: deno run -A scripts/watch-game.ts --seed N [--mode classic|modern] [--rounds N] [--match-rounds M] [--round N] [--build-trace ROUND PLAYER]",
    );
    Deno.exit(1);
  }

  // --rounds is the WATCH BUDGET; match length is independent.
  // matchRounds=0 → Infinity, so maxRounds-gated RNG (upgrade-system's
  // "skip pick for the final round") never trips. That makes r29 state
  // identical regardless of --rounds value.
  const scenarioRounds =
    args.matchRounds > 0 ? args.matchRounds : Number.POSITIVE_INFINITY;
  const sc = await createScenario({
    seed: args.seed,
    mode: args.mode,
    rounds: scenarioRounds,
  });
  const narrative = createNarrativeObserver();
  narrative.attach(sc);

  let buildTrace: BuildTraceObserver | undefined;
  if (args.buildTrace) {
    buildTrace = createBuildTraceObserver(args.buildTrace);
    buildTrace.attach();
  }

  // Track natural game end + last completed round so the timeout catch can
  // distinguish "game ended via last-player-standing before the watch budget"
  // (expected, friendly note) from a genuine hang (loud error).
  let gameEndedNaturally = false;
  let lastRoundEnded = 0;
  let winnerId: number | undefined;
  sc.bus.on(GAME_EVENT.ROUND_END, (ev) => {
    lastRoundEnded = ev.round;
  });
  sc.bus.on(GAME_EVENT.GAME_END, (ev) => {
    gameEndedNaturally = true;
    winnerId = ev.winner;
  });

  try {
    waitForEvent(sc, GAME_EVENT.ROUND_END, (ev) => ev.round === args.rounds, {
      // Scale sim-ms budget with round count. Survival uses ~183s sim per
      // round; 200s/round leaves headroom for occasional stalls.
      timeoutMs: 200_000 * args.rounds,
      label: `seed=${args.seed} r${args.rounds} end`,
    });
  } catch (err) {
    // Timeout is expected when the game ended early via last-player-standing
    // (no further ROUND_END fires) — partial data is still useful, so log
    // and fall through to print whatever was captured. Anything else is a
    // real bug (e.g. an observer crash) and must NOT be silently swallowed,
    // because the narrative would truncate without explanation.
    if (!(err instanceof ScenarioTimeoutError)) throw err;
    if (gameEndedNaturally) {
      const winnerLabel =
        winnerId !== undefined
          ? (PLAYER_NAMES[winnerId] ?? `P${winnerId}`)
          : "?";
      console.error(
        `[watch-game] game ended at r${lastRoundEnded} (winner ${winnerLabel}) — watch budget was r${args.rounds}`,
      );
    } else {
      // No GAME_END seen → either a real hang or the game state is wedged.
      // Surface the raw sim-budget error so the user can investigate.
      console.error(
        `[watch-game] ${err.message} (no GAME_END seen — possible hang; last ROUND_END was r${lastRoundEnded})`,
      );
    }
  } finally {
    narrative.detach();
    buildTrace?.detach();
  }

  const matchLabel =
    args.matchRounds > 0
      ? `match-rounds=${args.matchRounds}`
      : "match-rounds=∞";
  console.log(
    `seed=${args.seed} mode=${args.mode} rounds=${args.rounds} ${matchLabel}${args.round !== undefined ? ` (filtered to r${args.round})` : ""}`,
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
  let matchRounds = 0;
  let round: number | undefined;
  let buildTrace: { round: number; playerId: 0 | 1 | 2 } | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") {
      console.log(HELP_TEXT);
      Deno.exit(0);
    } else if (flag === "--seed") seed = Number(argv[++i]);
    else if (flag === "--mode") {
      const value = argv[++i];
      if (value !== "classic" && value !== "modern") {
        console.error(`Invalid --mode: ${value} (expected classic or modern)`);
        Deno.exit(1);
      }
      mode = value;
    } else if (flag === "--rounds") rounds = Number(argv[++i]);
    else if (flag === "--match-rounds") matchRounds = Number(argv[++i]);
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
  return { seed, mode, rounds, matchRounds, round, buildTrace };
}
