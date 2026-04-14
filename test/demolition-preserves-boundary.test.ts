/**
 * Regression: demolition must preserve walls on the map boundary (row 0/27,
 * col 0/43). Before the fix, the 8-dir load-bearing check only considered
 * in-bounds neighbors, so a wall on the bottom row had no in-bounds
 * "outside" neighbor and was wrongly stripped — breaking the enclosure and
 * zeroing interior.
 *
 * Seed 876938 modern reaches a round-5 demolition pick where every seated
 * player has walls on the bottom boundary row. Post-demolition, every
 * walled player must still have interior > 0.
 */

import { assertGreater } from "@std/assert";
import { createScenario, waitForEvent } from "./scenario.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";

Deno.test("demolition preserves boundary walls (seed 876938)", async () => {
  using sc = await createScenario({ seed: 876938, mode: "modern", rounds: 5 });
  const timeout = { timeoutMs: 300000 };

  // Drive the game until the demolition upgrade has been picked *and*
  // applied. Demolition's effect runs inside `applyUpgradePicks`, which
  // fires synchronously with the triggering UPGRADE_PICKED event — so by
  // the time this wait returns, player.walls already reflects the strip.
  waitForEvent(
    sc,
    GAME_EVENT.UPGRADE_PICKED,
    (ev) => ev.upgradeId === "demolition",
    timeout,
  );

  // Post-demolition: every walled player must still have an enclosure.
  // Before the fix, boundary walls (row 0/27, col 0/43) got stripped,
  // zeroing interior for players whose south wall was on row 27.
  for (const player of sc.state.players) {
    if (player.walls.size === 0) continue;
    assertGreater(
      player.interior.size,
      0,
      `player ${player.id} lost all interior across demolition ` +
        `(walls=${player.walls.size}) — boundary walls were stripped`,
    );
  }
});
