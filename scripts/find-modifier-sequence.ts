/**
 * Find seeds where a specific *sequence* of modifiers fires.
 *
 * `find-seed.ts` only checks per-tick conditions — it can't express
 * "sinkhole happened, then later high_tide happened". This script
 * subscribes to bannerStart events and records the modifier order
 * for each seed, then reports seeds matching the requested sequence.
 *
 * Usage:
 *   deno run -A scripts/find-modifier-sequence.ts <first> <second> [--max <N>] [--rounds <R>]
 *
 * Example:
 *   deno run -A scripts/find-modifier-sequence.ts sinkhole high_tide --max 60 --rounds 8
 */

import { GAME_EVENT } from "../src/shared/game-event-bus.ts";
import { createScenario } from "../test/scenario.ts";

const args = Deno.args;
const first = args[0];
const second = args[1];
if (!first || !second) {
  console.error(
    "usage: find-modifier-sequence.ts <first> <second> [--max N] [--rounds R]",
  );
  Deno.exit(1);
}

let max = 60;
let rounds = 8;
for (let i = 2; i < args.length; i++) {
  if (args[i] === "--max") max = Number(args[++i]);
  else if (args[i] === "--rounds") rounds = Number(args[++i]);
}

console.log(
  `Searching for "${first}" then "${second}" (seeds 1..${max}, ${rounds} rounds)`,
);

const matches: { seed: number; sequence: string[] }[] = [];

for (let seed = 1; seed <= max; seed++) {
  const sequence: string[] = [];
  using sc = await createScenario({ seed, mode: "modern", rounds });
  sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
    if (ev.modifierId) sequence.push(ev.modifierId);
  });
  sc.runGame(80000);

  const firstIdx = sequence.indexOf(first);
  const secondIdx = sequence.indexOf(second, firstIdx + 1);
  if (firstIdx >= 0 && secondIdx > firstIdx) {
    matches.push({ seed, sequence });
    console.log(`  seed=${seed}: ${sequence.join(" → ")}`);
  }
}

console.log(`\n${matches.length} match(es)`);
if (matches.length > 0) {
  const best = matches[0]!;
  console.log(`Recommended: seed=${best.seed} (${best.sequence.join(" → ")})`);
}
