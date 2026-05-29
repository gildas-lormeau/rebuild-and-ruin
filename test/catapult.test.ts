/**
 * Catapult variant — spawn behaviour.
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
 */

import { assert, assertEquals } from "@std/assert";
import { CATAPULT_SPAWN_CHANCE } from "../src/shared/core/game-constants.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { createScenario, type Scenario } from "./scenario.ts";

const SEED = 12345;
const ROUNDS = 10;

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
