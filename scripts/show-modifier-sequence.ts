/**
 * Print the full modifier sequence for one or more seeds.
 *
 * Usage:
 *   deno run -A scripts/show-modifier-sequence.ts <seed> [seed...] [--rounds N]
 */

import { GAME_EVENT } from "../src/shared/game-event-bus.ts";
import { createScenario } from "../test/scenario.ts";

const args = Deno.args;
const seeds: number[] = [];
let rounds = 8;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--rounds") {
    rounds = Number(args[++i]);
  } else {
    const seed = Number(args[i]);
    if (!Number.isNaN(seed)) seeds.push(seed);
  }
}

if (seeds.length === 0) {
  console.error("usage: show-modifier-sequence.ts <seed> [seed...] [--rounds N]");
  Deno.exit(1);
}

for (const seed of seeds) {
  const sequence: string[] = [];
  using sc = await createScenario({ seed, mode: "modern", rounds });
  sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
    if (ev.modifierId) sequence.push(`${ev.modifierId}@r${ev.round}`);
  });
  sc.runGame(80000);
  console.log(`seed=${seed} (${rounds} rounds): ${sequence.join(" → ") || "(no modifiers)"}`);
}
