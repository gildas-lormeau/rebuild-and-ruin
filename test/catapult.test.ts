/**
 * Catapult variant — spawn behaviour + line-of-sight wall siege.
 *
 * Covers:
 *
 *   1. Determinism: two scenarios with the same seed produce identical
 *      catapult-vs-grunt sequences. Catches RNG drift or non-deterministic
 *      ordering in addGrunt.
 *
 *   2. Mode gating + spawn rate: in modern mode, both grunts and catapults
 *      appear, with a catapult ratio in the right neighbourhood of
 *      CATAPULT_SPAWN_CHANCE. In classic mode, no catapults spawn at all.
 *
 *   3. Wall LoS siege: in normal modern-mode play, catapults whose target
 *      tower is shielded by a wall route to the wall and destroy it.
 *      Sampled across seeds because the geometry depends on emergent AI
 *      wall placement.
 */

import { assert, assertEquals } from "@std/assert";
import { Phase } from "../src/shared/core/game-phase.ts";
import { CATAPULT_SPAWN_CHANCE } from "../src/shared/core/game-constants.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import type { TileKey } from "../src/shared/core/grid.ts";
import { createScenario, type Scenario } from "./scenario.ts";

const SEED = 12345;
const ROUNDS = 10;
const WALL_SIEGE_SEEDS = [12345, 67890, 520946, 111, 999] as const;
const WALL_SIEGE_MAX_TICKS = 60_000;

Deno.test(
  "catapult: same seed produces identical kind sequence (determinism)",
  async () => {
    const scA = await createScenario({
      seed: SEED,
      mode: "modern",
      rounds: ROUNDS,
    });
    const scB = await createScenario({
      seed: SEED,
      mode: "modern",
      rounds: ROUNDS,
    });
    const kindsA = collectSpawnKinds(scA);
    const kindsB = collectSpawnKinds(scB);

    scA.runGame({ timeoutMs: 3_000_000 });
    scB.runGame({ timeoutMs: 3_000_000 });

    assertEquals(
      kindsA,
      kindsB,
      "catapult/grunt sequence must be identical across runs of the same seed",
    );
    assert(kindsA.length > 0, "expected at least one grunt spawn in 10 rounds");
  },
);

Deno.test(
  "catapult: modern-mode spawns produce both kinds at roughly the configured rate",
  async () => {
    const sc = await createScenario({
      seed: SEED,
      mode: "modern",
      rounds: ROUNDS,
    });
    const kinds = collectSpawnKinds(sc);
    sc.runGame({ timeoutMs: 3_000_000 });

    const total = kinds.length;
    const catapults = kinds.filter((kind) => kind === "catapult").length;
    const grunts = total - catapults;

    assert(total >= 20, `expected ≥20 spawns to verify ratio, got ${total}`);
    assert(catapults > 0, "no catapults spawned in modern mode — feature off?");
    assert(grunts > 0, "no regular grunts spawned — all rolls hit catapult?");

    const ratio = catapults / total;
    // Loose bound: configured 25%. Allow ±15pp slack over ~20+ samples
    // (small-N variance). Tightening this risks flakiness.
    const minRatio = CATAPULT_SPAWN_CHANCE - 0.15;
    const maxRatio = CATAPULT_SPAWN_CHANCE + 0.15;
    assert(
      ratio >= minRatio && ratio <= maxRatio,
      `catapult ratio ${ratio.toFixed(3)} outside [${minRatio.toFixed(2)}, ${maxRatio.toFixed(2)}] (${catapults}/${total})`,
    );
  },
);

Deno.test(
  "catapult: classic mode never spawns a catapult",
  async () => {
    const sc = await createScenario({
      seed: SEED,
      mode: "classic",
      rounds: ROUNDS,
    });
    const kinds = collectSpawnKinds(sc);
    sc.runGame({ timeoutMs: 3_000_000 });

    assert(kinds.length > 0, "expected at least one grunt spawn");
    const catapults = kinds.filter((kind) => kind === "catapult").length;
    assertEquals(
      catapults,
      0,
      `classic mode produced ${catapults} catapults — feature should be gated off`,
    );
  },
);

function collectSpawnKinds(sc: Scenario): ("grunt" | "catapult")[] {
  const kinds: ("grunt" | "catapult")[] = [];
  sc.bus.on(GAME_EVENT.GRUNT_SPAWN, () => {
    // addGrunt emits GRUNT_SPAWN immediately after pushing — the newest
    // grunt is the last entry. Read its kind synchronously.
    const grunt = sc.state.grunts[sc.state.grunts.length - 1];
    if (!grunt) return;
    kinds.push(grunt.kind === "catapult" ? "catapult" : "grunt");
  });
  return kinds;
}

Deno.test(
  "catapult: walls in line of fire are sieged and destroyed within 10 rounds",
  async () => {
    let seedsWithSiegeTicks = 0;
    let seedsWithCatapultWallDestruction = 0;
    let totalSiegeTicks = 0;
    let totalCatapultWallKills = 0;

    for (const seed of WALL_SIEGE_SEEDS) {
      const { siegeTicks, wallKills } = await runWallSiegeProbe(seed);
      totalSiegeTicks += siegeTicks;
      totalCatapultWallKills += wallKills;
      if (siegeTicks > 0) seedsWithSiegeTicks++;
      if (wallKills > 0) seedsWithCatapultWallDestruction++;
    }

    // Most seeds should produce at least one wall-siege tick across 10
    // rounds of modern play (25% catapult spawn rate × AI wall placement
    // in front of towers ≈ very likely). Loose threshold so the test
    // isn't flaky on emergent variance.
    assert(
      seedsWithSiegeTicks >= 3,
      `expected ≥3/${WALL_SIEGE_SEEDS.length} seeds to trigger catapult wall siege; ` +
        `got ${seedsWithSiegeTicks}. totalSiegeTicks=${totalSiegeTicks}`,
    );
    assert(
      totalSiegeTicks > 50,
      `total siege ticks across all seeds (${totalSiegeTicks}) suggests the ` +
        `LoS code path is rarely or never triggered`,
    );
    assert(
      seedsWithCatapultWallDestruction >= 1,
      `no seed produced a catapult-attributed wall destruction in ` +
        `${WALL_SIEGE_SEEDS.length} games — sieging is happening but ` +
        `never finishing (countdown bug?). totalCatapultWallKills=${totalCatapultWallKills}`,
    );
    console.log(
      `  catapult wall-siege: ${seedsWithSiegeTicks}/${WALL_SIEGE_SEEDS.length} ` +
        `seeds with siege activity, ${totalSiegeTicks} total siege ticks, ` +
        `${totalCatapultWallKills} catapult-attributed wall destructions ` +
        `(${seedsWithCatapultWallDestruction}/${WALL_SIEGE_SEEDS.length} seeds)`,
    );
  },
);

async function runWallSiegeProbe(
  seed: number,
): Promise<{ siegeTicks: number; wallKills: number }> {
  const sc = await createScenario({ seed, mode: "modern", rounds: 10 });
  let siegeTicks = 0;
  let wallKills = 0;

  for (let tickIdx = 0; tickIdx < WALL_SIEGE_MAX_TICKS; tickIdx++) {
    // Snapshot catapult wall-targets BEFORE the tick. After the tick, any
    // targeted wall that no longer exists in any player's wall set is a
    // catapult-attributed destruction.
    const preTickTargets: TileKey[] = [];
    if (sc.state.phase === Phase.BATTLE) {
      for (const grunt of sc.state.grunts) {
        if (
          grunt.kind === "catapult" &&
          grunt.attackingWall &&
          grunt.targetedWall !== undefined
        ) {
          siegeTicks++;
          preTickTargets.push(grunt.targetedWall as TileKey);
        }
      }
    }

    const preWalls = new Set<number>();
    for (const player of sc.state.players) {
      for (const key of player.walls) preWalls.add(key);
    }

    sc.tick(1);

    for (const wallKey of preTickTargets) {
      if (!preWalls.has(wallKey)) continue;
      let stillExists = false;
      for (const player of sc.state.players) {
        if (player.walls.has(wallKey)) {
          stillExists = true;
          break;
        }
      }
      if (!stillExists) wallKills++;
    }

    if (sc.state.round > 10) break;
  }
  return { siegeTicks, wallKills };
}
