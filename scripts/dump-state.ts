/**
 * Dump per-round state snapshots for a given seed.
 *
 * Logs round, modifier, sinkhole tile count, grunt count, and any grunt
 * positions that overlap water tiles. Useful for verifying that "grunts
 * on water" bugs are actually game-state bugs vs render bugs.
 */

import { GAME_EVENT } from "../src/shared/game-event-bus.ts";
import { isWater } from "../src/shared/spatial.ts";
import { createScenario } from "../test/scenario.ts";

const args = Deno.args;
const seed = Number(args[0] ?? "5");
const rounds = Number(args[1] ?? "10");

using sc = await createScenario({ seed, mode: "modern", rounds });

const seenRounds = new Set<number>();
sc.bus.on(GAME_EVENT.ROUND_START, (ev) => {
  if (seenRounds.has(ev.round)) return;
  seenRounds.add(ev.round);

  const state = sc.state;
  const modern = state.modern;
  const sinkholeTileCount = modern?.sinkholeTiles?.size ?? 0;
  const activeMod = modern?.activeModifier ?? "—";

  const gruntsOnWater: string[] = [];
  for (const grunt of state.grunts) {
    if (isWater(state.map.tiles, grunt.row, grunt.col)) {
      gruntsOnWater.push(`(${grunt.row},${grunt.col})`);
    }
  }

  console.log(
    `r${ev.round}: modifier=${activeMod}  sinkholeTiles=${sinkholeTileCount}  ` +
      `grunts=${state.grunts.length}  gruntsOnWater=${gruntsOnWater.length}` +
      (gruntsOnWater.length > 0 ? ` [${gruntsOnWater.join(",")}]` : ""),
  );
});

sc.runGame(80000);
console.log("done");
