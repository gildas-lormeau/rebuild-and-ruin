/**
 * Regression: grunts must not linger in an eliminated player's zone.
 *
 * resetZoneState fires once at the moment of elimination. A grunt that
 * wanders into a dead zone AFTER that (e.g. frozen-river crossing in a
 * later round when the zone owner is already eliminated) used to stay
 * there forever — no target available (same-zone towers all dead), and
 * no further cleanup call.
 *
 * Expected semantics: the sweep runs at end of build phase, so stragglers
 * disappear on the BUILD → CANNON_PLACE transition (during the cannons
 * banner), never "magically" mid-battle.
 *
 * Reproduction: seed 604090 modern. frozen_river fires at round 21, Blue
 * is eliminated at round 22. Grunts cross into Blue's zone during the
 * next frozen window or (more commonly) get stranded there when the
 * river thaws. Assert: at every CANNON_PLACE phase start, no grunt
 * occupies a dead zone.
 */

import { assert } from "@std/assert";
import { createScenario, waitForModifier } from "./scenario.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { isPlayerEliminated } from "../src/shared/core/player-types.ts";

const FROZEN_RIVER = "frozen_river" as const;

Deno.test("dead-zone cleanup: no grunt in eliminated zone at CANNON_PLACE start", async () => {
  const sc = await createScenario({
    seed: 604090,
    mode: "modern",
    rounds: 100,
    renderer: "ascii",
  });
  const ascii = sc.renderer!;

  const violations: {
    round: number;
    gruntIdx: number;
    r: number;
    c: number;
    zone: number;
    deadZones: number[];
  }[] = [];

  sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
    if (ev.phase !== Phase.CANNON_PLACE) return;
    const deadZones = new Set<number>();
    for (const player of sc.state.players) {
      if (!isPlayerEliminated(player)) continue;
      const zone = sc.state.playerZones[player.id];
      if (zone !== undefined) deadZones.add(zone);
    }
    if (deadZones.size === 0) return;
    for (let i = 0; i < sc.state.grunts.length; i++) {
      const grunt = sc.state.grunts[i]!;
      const zone = sc.state.map.zones[grunt.row]?.[grunt.col] ?? -1;
      if (deadZones.has(zone)) {
        violations.push({
          round: sc.state.round,
          gruntIdx: i,
          r: grunt.row,
          c: grunt.col,
          zone,
          deadZones: [...deadZones],
        });
      }
    }
  });

  // Reach frozen_river (round 21), then run a few more rounds so Blue dies
  // and grunts can drift into the dead zone across subsequent frozen rolls.
  waitForModifier(sc, FROZEN_RIVER, { timeoutMs: 1_500_000 });
  const frozenRound = sc.state.round;
  console.log(`frozen_river round ${frozenRound}`);

  try {
    sc.runUntil(
      () =>
        sc.state.round >= frozenRound + 5 ||
        sc.state.players.filter((p) => p.homeTower !== null).length < 2,
      { timeoutMs: 600_000 },
    );
  } catch {
    // runGame may end early if game finishes
  }

  if (violations.length > 0) {
    console.log("\n=== VIOLATIONS ===");
    for (const v of violations) {
      console.log(
        `round ${v.round} CANNON_PLACE: grunt#${v.gruntIdx} @(${v.r},${v.c}) in dead zone ${v.zone} (deadZones=${v.deadZones.join(",")})`,
      );
    }
    console.log("\nFinal ASCII:");
    console.log(ascii.snapshot({ layer: "all", coords: true }));
  }

  assert(
    violations.length === 0,
    `${violations.length} grunt(s) still in eliminated zones at CANNON_PLACE start — should have been swept at end of build phase`,
  );

  sc[Symbol.dispose]();
});
