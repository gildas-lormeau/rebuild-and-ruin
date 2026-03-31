/**
 * Reproduction test: clumsy walls must survive reselection.
 *
 * When a player reselects, rebuildHomeCastle must include clumsy builder
 * extras (same path as the animated castle build). Previously it used
 * computeCastleWallTiles (no clumsy), erasing the extra walls.
 *
 * Run with: bun test/reselect-clumsy.test.ts
 */

import { computeCastleWallTiles } from "../src/castle-generation.ts";
import { createScenario } from "./scenario-helpers.ts";
import { assert, test, runTests } from "./test-helpers.ts";

test("reselection preserves clumsy walls from castle build", () => {
  // Find a seed where clumsy builders add extra walls during reselection
  for (let seed = 1; seed < 200; seed++) {
    const s = createScenario(seed);

    for (let round = 0; round < 20; round++) {
      const { needsReselect } = s.playRound();
      if (needsReselect.length === 0) continue;

      const pid = needsReselect[0]!;
      s.processReselection(needsReselect);

      const player = s.state.players[pid]!;
      if (!player.homeTower || !player.castle) continue;

      // Count what a clean castle (no clumsy) would have
      const cleanTiles = computeCastleWallTiles(
        player.castle,
        s.state.map.tiles,
      );
      const cleanCount = cleanTiles.length;
      const actualCount = player.walls.size;

      if (actualCount > cleanCount) {
        console.log(
          `seed=${seed} round=${s.state.round} pid=${pid}: ` +
            `actual=${actualCount} clean=${cleanCount} (${actualCount - cleanCount} clumsy extras)`,
        );
        // Player has more walls than the clean castle — clumsy walls survived
        return; // Success
      }
      break;
    }
  }
  assert(false, "Could not find a seed where clumsy builders add extra walls during reselection");
});

await runTests("Reselection clumsy walls");
