/**
 * Sinkhole fairness tests — verify all zones get equal tile counts.
 *
 * Bug: seed 742237, round 4, modern mode — two AIs get 3-tile sinkholes,
 * one gets 2. The budget is rolled once and shared, so counts should match.
 *
 * Root cause: growSinkholeFromSeed uses SINKHOLE_FATTEN_CHANCE (0.65) which
 * can reject all BFS neighbors, leaving the cluster undersized even after
 * 3 retry attempts.
 *
 * Run with: deno test --no-check test/sinkhole-fairness.test.ts
 */

import { createScenario } from "./scenario-helpers.ts";
import { applySinkhole } from "../src/game/round-modifiers.ts";
import { setGameMode } from "../src/shared/types.ts";
import { GAME_MODE_MODERN } from "../src/shared/game-constants.ts";
import { unpackTile } from "../src/shared/spatial.ts";
import { assert, assertEquals } from "@std/assert";


/** Count sinkhole tiles per zone from the returned key set. */
function countPerZone(
  sunk: ReadonlySet<number>,
  zones: readonly (readonly number[])[],
): Map<number, number> {
  const counts = new Map<number, number>();
  for (const key of sunk) {
    const { r, c } = unpackTile(key);
    const zone = zones[r]![c]!;
    counts.set(zone, (counts.get(zone) ?? 0) + 1);
  }
  return counts;
}

Deno.test("sinkhole fairness: all zones get equal tile count (seed 742237)", async () => {
  const scenario = await createScenario(742237);
  setGameMode(scenario.state, GAME_MODE_MODERN);

  const sunk = applySinkhole(scenario.state);
  assert(sunk.size > 0, "sinkhole should affect tiles");

  const perZone = countPerZone(sunk, scenario.state.map.zones);
  const counts = [...perZone.values()];

  // All zones should have the same count
  const allEqual = counts.every((count) => count === counts[0]);
  assert(
    allEqual,
    `all zones should get equal tile count, got per-zone: ${[...perZone.entries()]
      .map(([zone, count]) => `zone${zone}=${count}`)
      .join(", ")}`,
  );
});

Deno.test("sinkhole fairness: multi-seed survey — counts match across zones", async () => {
  const seeds = [42, 100, 742237, 999, 1234, 5678, 9999, 31415, 27182, 65535,
    11111, 22222, 33333, 44444, 55555, 66666, 77777, 88888, 99999, 12345];
  let mismatches = 0;
  const details: string[] = [];

  for (const seed of seeds) {
    const scenario = await createScenario(seed);
    setGameMode(scenario.state, GAME_MODE_MODERN);

    const sunk = applySinkhole(scenario.state);
    if (sunk.size === 0) continue;

    const perZone = countPerZone(sunk, scenario.state.map.zones);
    const counts = [...perZone.values()];
    const allEqual = counts.every((count) => count === counts[0]);
    if (!allEqual) {
      mismatches++;
      details.push(
        `seed ${seed}: ${[...perZone.entries()]
          .map(([zone, count]) => `zone${zone}=${count}`)
          .join(", ")}`,
      );
    }
  }

  assert(
    mismatches === 0,
    `${mismatches}/${seeds.length} seeds had unequal zone counts:\n${details.join("\n")}`,
  );
});

Deno.test("sinkhole fairness: budget always met per zone", async () => {
  // Verify that each zone's cluster size equals the shared budget.
  // The budget is min(rng.int(4,6), floor((36 - existing) / activeZones)).
  // We can infer the budget from the max cluster size across zones.
  const seeds = [42, 100, 742237, 999, 1234, 5678, 9999, 31415];

  for (const seed of seeds) {
    const scenario = await createScenario(seed);
    setGameMode(scenario.state, GAME_MODE_MODERN);

    const sunk = applySinkhole(scenario.state);
    if (sunk.size === 0) continue;

    const perZone = countPerZone(sunk, scenario.state.map.zones);

    // The expected budget per zone is total / activeZones (since budget is shared)
    const expectedBudget = Math.max(...perZone.values());
    for (const [zone, count] of perZone) {
      assertEquals(
        count,
        expectedBudget,
        `seed ${seed}: zone ${zone} got ${count} tiles, expected ${expectedBudget}`,
      );
    }
  }
});
