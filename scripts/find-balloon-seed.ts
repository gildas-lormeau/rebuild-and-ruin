/**
 * One-off: find seeds whose pure-AI play produces a balloon battle
 * (BALLOON_ANIM_START fires — an enclosed alive balloon cannon resolved a
 * flight against an enemy target). Used to pick a seed for the
 * balloon-after-pitch fix verification + a determinism fixture. The AI
 * places balloons late (high defensiveness + spare slots), so this needs a
 * generous --rounds.
 *
 *   deno run -A scripts/find-balloon-seed.ts [--mode classic|modern] [--rounds N] [--tries N]
 *
 * Body is wrapped in main() so Biome's top-level const hoist can't reorder
 * `start`/`elapsed` past the search loop (see feedback_biome_const_hoist).
 */

import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { createScenario } from "../test/scenario.ts";

await main();

async function main(): Promise<void> {
  const mode = flag("--mode", "classic") as "classic" | "modern";
  const rounds = Number(flag("--rounds", "15"));
  const tries = Number(flag("--tries", "40"));

  console.log(
    `Searching ${tries} seeds for a balloon battle (${mode}, ${rounds} rounds)\n`,
  );

  const hits: { seed: number; round: number }[] = [];
  const start = Date.now();

  for (let seed = 0; seed < tries; seed++) {
    try {
      const sc = await createScenario({ seed, mode, rounds });
      let firedRound = -1;
      sc.bus.on(GAME_EVENT.BALLOON_ANIM_START, (ev) => {
        if (firedRound < 0) firedRound = ev.round;
      });
      sc.runUntil(() => firedRound >= 0, { timeoutMs: 600_000 });
      hits.push({ seed, round: firedRound });
      console.log(`  HIT seed=${seed}  round=${firedRound}`);
    } catch {
      // timeout (no balloon battle in `rounds`) or unplayable map — skip
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n${hits.length} balloon seed(s) in ${elapsed}s`);
  if (hits.length === 0) Deno.exit(1);
}

function flag(name: string, fallback: string): string {
  const idx = Deno.args.indexOf(name);
  return idx >= 0 && Deno.args[idx + 1] ? Deno.args[idx + 1]! : fallback;
}
