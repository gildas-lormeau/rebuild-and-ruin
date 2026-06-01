/**
 * One-off diagnostic: at a (seed, round) WALL_BUILD entry, classify every
 * tower in a player's zone as alive/dead, enclosed/unowned, and — the decisive
 * question for the survival idle-diagnostic — `isTowerEnclosable` (terrain-only:
 * can ANY wall configuration seal it, or is a water/pit/house channel reaching
 * the map border right beside it?). An idle round on an UNENCLOSABLE tower is a
 * legitimate quiet round (false positive); an idle round on an ENCLOSABLE
 * unowned tower is a real missed expansion.
 *
 * Reproduces the survival runner's exact config (modern, rounds=31) so the r6
 * state matches what the diagnostic flagged.
 *
 *   deno run -A scripts/diag-tower-enclosable.ts <seed> <round> <RED|BLUE|GOLD>
 */

import { isTowerEnclosable } from "../src/ai/ai-castle-rect.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import {
  computeOutside,
  towerReachesOutsideCardinal,
} from "../src/shared/core/spatial.ts";
import { createScenario, waitForEvent } from "../test/scenario.ts";

const PLAYER_NAMES = ["RED", "BLUE", "GOLD"] as const;

main();

async function main(): Promise<void> {
  const [seedArg, roundArg, nameArg] = Deno.args;
  const seed = Number(seedArg);
  const round = Number(roundArg);
  const pid = PLAYER_NAMES.indexOf(nameArg as (typeof PLAYER_NAMES)[number]);
  if (!Number.isInteger(seed) || !Number.isInteger(round) || pid < 0) {
    console.error(
      "usage: diag-tower-enclosable.ts <seed> <round> <RED|BLUE|GOLD>",
    );
    Deno.exit(1);
  }

  using sc = await createScenario({ seed, mode: "modern", rounds: 31 });
  waitForEvent(
    sc,
    GAME_EVENT.PHASE_START,
    (ev) => ev.phase === Phase.WALL_BUILD && sc.state.round === round,
    { timeoutMs: 200_000 * (round + 1), label: `seed=${seed} r${round} WB` },
  );

  const state = sc.state;
  const player = state.players[pid as 0 | 1 | 2];
  if (!player) {
    console.error(`player ${nameArg} not seated`);
    Deno.exit(1);
  }
  const home = player.homeTower;
  const walls = player.walls;
  const outside = computeOutside(walls);
  const ownedSet = new Set(player.enclosedTowers.map((tower) => tower.index));

  console.log(
    `seed=${seed} r${round} ${nameArg} WALL_BUILD start — lives=${player.lives} walls=${walls.size} homeZone=${home?.zone ?? "?"}`,
  );
  console.log(
    "  tower  pos       alive  owned  enclosable  cardReachesOutside",
  );
  for (const tower of state.map.towers) {
    if (!home || tower.zone !== home.zone) continue;
    const alive = state.towerAlive[tower.index];
    const owned = ownedSet.has(tower.index);
    const enclosable = isTowerEnclosable(tower, state);
    const cardOut = towerReachesOutsideCardinal(tower, walls, outside);
    const homeMark = tower.index === home.index ? " (HOME)" : "";
    console.log(
      `  #${String(tower.index).padEnd(4)} (${String(tower.row).padStart(2)},${String(tower.col).padStart(2)})    ${alive ? "Y" : "."}      ${owned ? "Y" : "."}      ${enclosable ? "Y" : "."}           ${cardOut ? "Y" : "."}${homeMark}`,
    );
  }
}
