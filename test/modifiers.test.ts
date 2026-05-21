/**
 * Modifier tests — one Deno.test per implemented modifier.
 *
 * Each test boots a fresh scenario in modern mode with
 * `testHooks.forceModifier = <id>`, which pins `rollModifier` to that
 * value with no RNG consumption. Because `MODIFIER_FIRST_ROUND = 3`,
 * the forced modifier still won't fire until round 3 — so each test
 * runs a 5-round game, then asserts:
 *
 *   1. `MODIFIER_APPLIED` fired for the forced id (every test).
 *   2. The modifier's observable effect was seen by an `EffectProbe`
 *      installed before the game ran. Probes that need a "before"
 *      snapshot listen for `MODIFIER_APPLIED` (`prepareBattleState`
 *      emits it AFTER `applyBattleStartModifiers`, so the synchronous
 *      apply mutations are already visible).
 *
 * Modifiers without a probe entry get a pick-only assertion — see the
 * per-modifier notes in `EFFECT_PROBES` for why each is omitted.
 */

import { assert } from "@std/assert";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import type { ModifierId } from "../src/shared/core/game-constants.ts";
import {
  computeFloodedTiles,
  isWater,
  packTile,
} from "../src/shared/core/spatial.ts";
import { createScenario, type Scenario } from "./scenario.ts";

/** Per-modifier effect probe. `install` subscribes to bus events and/or
 *  snapshots state, and returns a finalizer that answers "did the effect
 *  fire?" */
interface EffectProbe {
  readonly description: string;
  install(sc: Scenario): () => boolean;
}

const MODIFIER_IDS: readonly ModifierId[] = [
  "wildfire",
  "grunt_surge",
  "frozen_river",
  "sinkhole",
  "high_tide",
  "dust_storm",
  "rubble_clearing",
  "low_water",
  "dry_lightning",
  "fog_of_war",
  "frostbite",
  "sapper",
  "supply_ship",
];
/** Number of rounds per scenario. The first modifier roll happens at
 *  round 3 (MODIFIER_FIRST_ROUND); 5 rounds is plenty of headroom for
 *  the forced modifier to land AND for round-3+ battle effects
 *  (frostbite chip, sapper wall drops) to be observed. */
const ROUNDS = 5;
/** Sim-time budget per test. A 5-round modern game runs ~150-200 sim-s
 *  end-to-end; the 10-minute cap is well above the worst case observed
 *  in `npm run record-seeds` scans. */
const MAX_TIMEOUT_MS = 600_000;
/** Per-modifier seed overrides for effects that depend on incidental
 *  collisions (e.g. frostbite needs a cannonball to actually hit a grunt
 *  during the forced-modifier battle). The default seed doesn't always
 *  produce those collisions — and which seed does depends on AI build/
 *  placement behavior, so this map can drift when the AI is retuned.
 *  Refresh by running the in-test seed-search probe and picking the first
 *  seed where the effect fires. */
const PER_MODIFIER_SEED: Partial<Record<ModifierId, number>> = {
  frostbite: 17,
};
/** Effect probes — see file header. Modifiers without an entry fall
 *  back to a pick-only assertion (the MODIFIER_APPLIED event itself is
 *  the evidence the impl ran).
 *
 *  Probes observe at MODIFIER_APPLIED because `prepareBattleState` emits
 *  it AFTER `applyBattleStartModifiers` runs — all synchronous mutations
 *  (burning pits added, modern.*Tiles populated, supplyShips spawned)
 *  are already visible in state at that point. */
const EFFECT_PROBES: Partial<Record<ModifierId, EffectProbe>> = {
  wildfire: {
    description: "burningPits.length > 0 at apply time",
    install: (sc) => {
      // phase-setup.ts emits MODIFIER_APPLIED AFTER applyBattleStartModifiers,
      // so listening here sees the post-apply count. burningPits is empty
      // at modern-mode battle start (pit decay clears them between rounds),
      // so length > 0 is sufficient evidence the scar was applied.
      let observed = false;
      sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
        if (ev.modifierId !== "wildfire") return;
        if (sc.state.burningPits.length > 0) observed = true;
      });
      return () => observed;
    },
  },

  grunt_surge: {
    description: "grunts.length > 0 at apply time",
    install: (sc) => {
      // Surge spawns 6-10 grunts per seated player at apply time, so
      // checking length > 0 at MODIFIER_APPLIED (which fires post-apply)
      // is a reliable signal. There may already be a few grunts from
      // house destruction, but the count is still > 0 either way.
      let observed = false;
      sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
        if (ev.modifierId !== "grunt_surge") return;
        if (sc.state.grunts.length > 0) observed = true;
      });
      return () => observed;
    },
  },

  frozen_river: {
    description: "state.modern.frozenTiles non-null + non-empty",
    install: (sc) => {
      let observed = false;
      sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
        if (ev.modifierId !== "frozen_river") return;
        const frozen = sc.state.modern?.frozenTiles;
        if (frozen && frozen.size > 0) observed = true;
      });
      return () => observed;
    },
  },

  sinkhole: {
    description: "state.modern.sinkholeTiles non-null + non-empty",
    install: (sc) => {
      let observed = false;
      sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
        if (ev.modifierId !== "sinkhole") return;
        const tiles = sc.state.modern?.sinkholeTiles;
        if (tiles && tiles.size > 0) observed = true;
      });
      return () => observed;
    },
  },

  high_tide: {
    description: "computeFloodedTiles(map) non-empty + flooded ring is wall-free",
    install: (sc) => {
      let observed = false;
      sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
        if (ev.modifierId !== "high_tide") return;
        const flooded = computeFloodedTiles(sc.state.map);
        if (flooded.size === 0) return;
        // Apply mass-evicts walls on flooded tiles — verify none remain.
        const remainingWall = sc.state.players.some((player) =>
          [...flooded].some((key) => player.walls.has(key)),
        );
        if (!remainingWall) observed = true;
      });
      return () => observed;
    },
  },

  low_water: {
    description: "state.modern.exposedRiverbedTiles non-null + non-empty",
    install: (sc) => {
      let observed = false;
      sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
        if (ev.modifierId !== "low_water") return;
        const tiles = sc.state.modern?.exposedRiverbedTiles;
        if (tiles && tiles.size > 0) observed = true;
      });
      return () => observed;
    },
  },

  dust_storm: {
    description: "precomputedDustStormJitters.length > 0",
    install: (sc) => {
      let observed = false;
      sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
        if (ev.modifierId !== "dust_storm") return;
        const jitters = sc.state.modern?.precomputedDustStormJitters;
        if (jitters && jitters.length > 0) observed = true;
      });
      return () => observed;
    },
  },

  supply_ship: {
    description: "state.modern.supplyShips non-null + non-empty",
    install: (sc) => {
      let observed = false;
      sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
        if (ev.modifierId !== "supply_ship") return;
        const ships = sc.state.modern?.supplyShips;
        if (ships && ships.length > 0) observed = true;
      });
      return () => observed;
    },
  },

  dry_lightning: {
    description: "burningPits.length > 0 at apply time",
    install: (sc) => {
      let observed = false;
      sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
        if (ev.modifierId !== "dry_lightning") return;
        if (sc.state.burningPits.length > 0) observed = true;
      });
      return () => observed;
    },
  },

  frostbite: {
    description: "some grunt has chipped=true during BATTLE phase",
    install: (sc) => {
      // Frostbite chip happens at cannonball impact during battle
      // (battle-system.ts:840), not at apply time. Observe DURING the
      // battle via onAny — mirrors the mortar/shield_battery probes
      // in upgrades.test.ts.
      let inBattle = false;
      let observed = false;
      sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
        if (ev.phase === Phase.BATTLE) inBattle = true;
      });
      sc.bus.on(GAME_EVENT.PHASE_END, (ev) => {
        if (ev.phase === Phase.BATTLE) inBattle = false;
      });
      sc.bus.onAny(() => {
        if (!inBattle || observed) return;
        for (const grunt of sc.state.grunts) {
          if (grunt.chipped === true) {
            observed = true;
            return;
          }
        }
      });
      return () => observed;
    },
  },

  sapper: {
    description: "some grunt has attackingWall=true at BATTLE phase start",
    install: (sc) => {
      // Sapper itself doesn't set attackingWall — `rollGruntWallAttacks`
      // (called from prepareBattleState AFTER MODIFIER_APPLIED) does,
      // and with sapper active it bypasses the random roll so every
      // grunt with an eligible adjacent wall flips the flag. Observe
      // at PHASE_START(BATTLE) so we see the post-roll state without
      // waiting for the wall to actually break.
      let observed = false;
      sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
        if (ev.phase !== Phase.BATTLE || observed) return;
        if (sc.state.modern?.activeModifier !== "sapper") return;
        if (sc.state.grunts.some((g) => g.attackingWall === true)) {
          observed = true;
        }
      });
      return () => observed;
    },
  },

  // No probe — see fog_of_war / rubble_clearing notes in the test
  // suite below. fog_of_war is a pure render overlay (impl has no
  // state mutation). rubble_clearing only mutates state when there's
  // dead-cannon debris or burning pits to clear; whether that's true
  // in round 3 depends on the seed, so a probe would be flaky.
};

for (const modifierId of MODIFIER_IDS) {
  Deno.test(`modifiers: ${modifierId} fires + effect observed`, async () => {
    using sc = await createScenario({
      seed: PER_MODIFIER_SEED[modifierId],
      mode: "modern",
      rounds: ROUNDS,
      testHooks: { forceModifier: modifierId },
    });

    const probe = EFFECT_PROBES[modifierId];
    const finalizer = probe?.install(sc);

    let fired = false;
    sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
      if (ev.modifierId === modifierId) fired = true;
    });

    sc.runGame({ timeoutMs: MAX_TIMEOUT_MS });

    assert(
      fired,
      `expected modifier "${modifierId}" to fire (round 3+) — MODIFIER_APPLIED never emitted with that id`,
    );

    if (finalizer && probe) {
      assert(
        finalizer(),
        `effect not observed for "${modifierId}": ${probe.description}`,
      );
    }
  });
}

/** Regression: low_water's clear must evict grunts that walked onto the
 *  exposed riverbed during the prior battle. Pre-fix, those grunts
 *  remained on water tiles after clear (frozenTiles + exposedRiverbedTiles
 *  both null) and were stuck for the rest of the match. The invariant
 *  asserted here — "a grunt on a water tile is on a passable-water tile"
 *  — holds for both frozen_river and low_water and would catch a
 *  recurrence of the same eviction gap in either. */
Deno.test("regression: no grunt is stranded on impassable water", async () => {
  // Seed 459757 modern rolls low_water at round 4 and reliably produces
  // 7 stranded grunts at round 5 WALL_BUILD pre-fix. Confirmed via
  // git-blame trace to commit 2707c7cb (the exposedRiverbedTiles
  // refactor that dropped clear-side eviction).
  using sc = await createScenario({ seed: 459757, mode: "modern", rounds: 6 });
  const violations: { round: number; phase: string; row: number; col: number }[] = [];
  sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
    if (ev.phase !== Phase.BATTLE && ev.phase !== Phase.WALL_BUILD) return;
    const tiles = sc.state.map.tiles;
    const exposed = sc.state.modern?.exposedRiverbedTiles;
    const frozen = sc.state.modern?.frozenTiles;
    for (const grunt of sc.state.grunts) {
      if (!isWater(tiles, grunt.row, grunt.col)) continue;
      const key = packTile(grunt.row, grunt.col);
      if (exposed?.has(key)) continue;
      if (frozen?.has(key)) continue;
      violations.push({
        round: sc.state.round,
        phase: ev.phase,
        row: grunt.row,
        col: grunt.col,
      });
    }
  });
  sc.runGame({ timeoutMs: MAX_TIMEOUT_MS });
  assert(
    violations.length === 0,
    `grunts stranded on impassable water: ${JSON.stringify(violations)}`,
  );
});
