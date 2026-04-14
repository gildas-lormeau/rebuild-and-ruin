/**
 * Grace-period helpers for modifier targeting.
 *
 * Verifies that freshCastle filters a player's zone/identity out of
 * getModifierEligibleZones / getModifierEligiblePlayers, and that the
 * applyFireScar assertion catches a scar that would hit a grace zone.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { applyFireScar } from "../src/game/modifiers/fire-helpers.ts";
import {
  getGraceCastleZones,
  getModifierEligiblePlayers,
  getModifierEligibleZones,
} from "../src/game/modifiers/modifier-eligibility.ts";
import { packTile } from "../src/shared/core/spatial.ts";
import { createScenario } from "./scenario.ts";

Deno.test("grace: flag is false by default, all seated players eligible", async () => {
  const sc = await createScenario({ seed: 42 });
  for (const player of sc.state.players) {
    assertEquals(player.freshCastle, false);
  }
  // Without any grace flags, getModifierEligiblePlayers matches seated players.
  const eligible = getModifierEligiblePlayers(sc.state);
  const seated = sc.state.players.filter((p) => !!p.homeTower && !p.eliminated);
  assertEquals(eligible.length, seated.length);
  assertEquals(getGraceCastleZones(sc.state).size, 0);
});

Deno.test("grace: freshCastle excludes player's zone from eligibility", async () => {
  const sc = await createScenario({ seed: 42 });
  const target = sc.state.players.find((p) => !!p.homeTower && !p.eliminated);
  assert(target, "need at least one seated player");
  target.freshCastle = true;
  const targetZone = target.homeTower!.zone;

  const eligibleZones = getModifierEligibleZones(sc.state);
  assert(
    !eligibleZones.includes(targetZone),
    `zone ${targetZone} should be filtered out`,
  );
  const eligiblePlayers = getModifierEligiblePlayers(sc.state);
  assert(!eligiblePlayers.some((p) => p.id === target.id));
  assert(getGraceCastleZones(sc.state).has(targetZone));
});

Deno.test("grace: applyFireScar throws if scar touches a grace zone", async () => {
  const sc = await createScenario({ seed: 42 });
  const target = sc.state.players.find((p) => !!p.homeTower && !p.eliminated);
  assert(target, "need at least one seated player");
  target.freshCastle = true;
  const tower = target.homeTower!;
  // Any tile in the zones grid matching target's zone triggers the assert.
  // Use tower's top-left as a stable representative tile.
  const scar = new Set<number>([packTile(tower.row, tower.col)]);
  assertThrows(
    () => applyFireScar(sc.state, scar),
    Error,
    "fresh-castle zone",
  );
});
