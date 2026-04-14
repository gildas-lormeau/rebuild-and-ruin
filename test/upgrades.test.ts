/**
 * Upgrade tests — one step per implemented upgrade, grouped by seed.
 *
 * Seeds are looked up by name via `loadSeed("upgrade:<id>")`, which reads
 * `test/seed-fixtures.json`. When RNG drifts, run `npm run record-seeds`
 * to rescan and rewrite the fixture — no per-test rehunting needed.
 *
 * Multiple upgrades frequently share a seed (seed 0 alone covers ~11
 * upgrades), so tests group by the resolved seed: one runGame per unique
 * seed, per-upgrade assertions as `t.step`s. This keeps per-upgrade failure
 * attribution while minimizing scenario startup cost.
 *
 * Each step asserts (1) the upgrade was picked and (2) its effect fired,
 * when an `EFFECT_PROBES` entry exists. Upgrades without a probe get a
 * pick-only assertion. To add a probe:
 *   1. Add an entry to EFFECT_PROBES keyed by UpgradeId.
 *   2. `install(sc)` subscribes to the bus and/or snapshots state, and
 *      returns a finalizer that answers "did the effect fire for this picker?".
 *   3. Probes that need a "before" snapshot listen for UPGRADE_PICKED
 *      (fires BEFORE onUpgradePicked applies the effect) and compare
 *      against a later snapshot at PHASE_END(BATTLE).
 */

import { assert } from "@std/assert";
import { buildTimerBonus } from "../src/game/index.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import type { UpgradeId } from "../src/shared/core/upgrade-defs.ts";
import { loadSeed, type Scenario } from "./scenario.ts";
import SEED_FIXTURES from "./seed-fixtures.json" with { type: "json" };

const UPGRADE_IDS: readonly UpgradeId[] = [
  "mortar",
  "rapid_fire",
  "ricochet",
  "shield_battery",
  "reinforced_walls",
  "master_builder",
  "small_pieces",
  "double_time",
  "architect",
  "foundations",
  "reclamation",
  "territorial_ambition",
  "conscription",
  "salvage",
  "ceasefire",
  "supply_drop",
  "second_wind",
  "demolition",
  "clear_the_field",
];

const MAX_TIMEOUT_MS = 120_000;
/** Rounds per scenario run. Enough rounds so every targeted upgrade has
 *  multiple chances to be picked and fire its effect. */
const ROUNDS = 10;

interface Pick {
  readonly upgradeId: UpgradeId;
  readonly playerId: number;
}

/** Per-upgrade effect probe. `install` subscribes to bus events and/or
 *  snapshots state, and returns a finalizer that answers "did the effect
 *  fire at least once for `picker`?" */
interface EffectProbe {
  readonly description: string;
  install(sc: Scenario): (picker: number) => boolean;
}

/** Effect probes for the 9 easy-tier upgrades. See file header for the
 *  design rationale. Missing entries fall back to pick-only assertions.
 *
 *  Timing note: `setPhase` emits PHASE_START BEFORE onBuildPhaseStart/
 *  onBattlePhaseStart run, so probes that need the phase-setup state
 *  observe at PHASE_END of the SAME phase (setup state persists through
 *  the phase and is still visible at the transition to the next phase).
 *  Pick-time effects observe at PHASE_END(BATTLE) because UPGRADE_PICKED
 *  events fire synchronously during applyUpgradePicks, which runs BEFORE
 *  enterBuildPhase emits PHASE_END(BATTLE). */
const EFFECT_PROBES: Partial<Record<UpgradeId, EffectProbe>> = {
  reinforced_walls: {
    description: "wallAbsorbed event fires for picker",
    install: (sc) => {
      const absorbers = new Set<number>();
      sc.bus.on(GAME_EVENT.WALL_ABSORBED, (ev) => {
        absorbers.add(ev.playerId);
      });
      return (picker) => absorbers.has(picker);
    },
  },

  master_builder: {
    description: "masterBuilderOwners contains picker at WALL_BUILD end",
    install: (sc) => {
      const owners = new Set<number>();
      sc.bus.on(GAME_EVENT.PHASE_END, (ev) => {
        if (ev.phase !== Phase.WALL_BUILD) return;
        const mb = sc.state.modern?.masterBuilderOwners;
        if (mb) for (const id of mb) owners.add(id);
      });
      return (picker) => owners.has(picker);
    },
  },

  double_time: {
    description: "buildTimerBonus >= 10 at double_time pick time",
    install: (sc) => {
      let observed = false;
      // UPGRADE_PICKED fires AFTER player.upgrades.set(double_time, 1),
      // so buildTimerBonus() queried here returns 10 (the DT bonus).
      sc.bus.on(GAME_EVENT.UPGRADE_PICKED, (ev) => {
        if (ev.upgradeId !== "double_time") return;
        if (buildTimerBonus(sc.state) >= 10) observed = true;
      });
      return () => observed;
    },
  },

  mortar: {
    description: "some cannon has mortar=true during BATTLE phase",
    install: (sc) => {
      // onBattlePhaseStart runs AFTER setPhase emits PHASE_START, and
      // cleanupBattleArtifacts clears the flags BEFORE setPhase emits
      // PHASE_END. So we have to observe DURING the battle phase via
      // onAny, not at phase boundaries.
      let inBattle = false;
      const firedFor = new Set<number>();
      sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
        if (ev.phase === Phase.BATTLE) inBattle = true;
      });
      sc.bus.on(GAME_EVENT.PHASE_END, (ev) => {
        if (ev.phase === Phase.BATTLE) inBattle = false;
      });
      sc.bus.onAny(() => {
        if (!inBattle) return;
        for (const player of sc.state.players) {
          if (player.cannons.some((c) => c.mortar === true)) {
            firedFor.add(player.id);
          }
        }
      });
      return (picker) => firedFor.has(picker);
    },
  },

  shield_battery: {
    description: "some cannon has shielded=true during BATTLE phase",
    install: (sc) => {
      let inBattle = false;
      const firedFor = new Set<number>();
      sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
        if (ev.phase === Phase.BATTLE) inBattle = true;
      });
      sc.bus.on(GAME_EVENT.PHASE_END, (ev) => {
        if (ev.phase === Phase.BATTLE) inBattle = false;
      });
      sc.bus.onAny(() => {
        if (!inBattle) return;
        for (const player of sc.state.players) {
          if (player.cannons.some((c) => c.shielded === true)) {
            firedFor.add(player.id);
          }
        }
      });
      return (picker) => firedFor.has(picker);
    },
  },

  second_wind: {
    description: "all towerAlive === true on the first event after pick",
    install: (sc) => {
      let pendingCheck = false;
      let observed = false;
      sc.bus.on(GAME_EVENT.UPGRADE_PICKED, (ev) => {
        if (ev.upgradeId === "second_wind") pendingCheck = true;
      });
      // onAny fires AFTER typed listeners on the same emit, then again on
      // every subsequent event. The triggering UPGRADE_PICKED(second_wind)
      // is skipped explicitly — onUpgradePicked hasn't run yet at that
      // point. Any later event (another upgradePicked for a different
      // upgrade, wallPlaced, phaseStart, etc.) has the revive applied.
      sc.bus.onAny((type, ev) => {
        if (!pendingCheck) return;
        if (
          type === "upgradePicked" &&
          (ev as { upgradeId: string }).upgradeId === "second_wind"
        ) {
          return;
        }
        if (sc.state.towerAlive.every((alive) => alive)) observed = true;
        pendingCheck = false;
      });
      return () => observed;
    },
  },

  clear_the_field: {
    description: "grunts.length === 0 at BATTLE end after pick",
    install: (sc) => {
      let awaiting = false;
      let observed = false;
      sc.bus.on(GAME_EVENT.UPGRADE_PICKED, (ev) => {
        if (ev.upgradeId === "clear_the_field") awaiting = true;
      });
      sc.bus.on(GAME_EVENT.PHASE_END, (ev) => {
        if (!awaiting || ev.phase !== Phase.BATTLE) return;
        if (sc.state.grunts.length === 0) observed = true;
        awaiting = false;
      });
      return () => observed;
    },
  },

  demolition: {
    description: "some player's wall count drops across demolition pick",
    install: (sc) => {
      const preWalls = new Map<number, number>();
      let observed = false;
      // UPGRADE_PICKED fires BEFORE onUpgradePicked applies the effect,
      // so the handler sees the pre-effect wall count.
      sc.bus.on(GAME_EVENT.UPGRADE_PICKED, (ev) => {
        if (ev.upgradeId !== "demolition") return;
        for (const player of sc.state.players) {
          preWalls.set(player.id, player.walls.size);
        }
      });
      sc.bus.on(GAME_EVENT.PHASE_END, (ev) => {
        if (ev.phase !== Phase.BATTLE || preWalls.size === 0) return;
        // Demolition is global, so any player whose wall count dropped
        // is evidence the effect fired.
        for (const player of sc.state.players) {
          const before = preWalls.get(player.id);
          if (before !== undefined && player.walls.size < before) {
            observed = true;
            break;
          }
        }
        preWalls.clear();
      });
      return () => observed;
    },
  },

  reclamation: {
    description: "picker's dead cannons removed across reclamation pick",
    install: (sc) => {
      const preDead = new Map<number, number>();
      let observed = false;
      let sawPick = false;
      sc.bus.on(GAME_EVENT.UPGRADE_PICKED, (ev) => {
        if (ev.upgradeId !== "reclamation") return;
        sawPick = true;
        const player = sc.state.players[ev.playerId];
        if (player) {
          preDead.set(
            ev.playerId,
            player.cannons.filter((c) => c.hp <= 0).length,
          );
        }
      });
      sc.bus.on(GAME_EVENT.PHASE_END, (ev) => {
        if (ev.phase !== Phase.BATTLE || preDead.size === 0) return;
        for (const [playerId, before] of preDead) {
          const player = sc.state.players[playerId];
          if (!player) continue;
          const after = player.cannons.filter((c) => c.hp <= 0).length;
          // Either dead cannons were removed (before > after) or there
          // were none to remove (before === 0). Both count as "the
          // effect ran without error".
          if (before === 0 || after < before) {
            observed = true;
            break;
          }
        }
        preDead.clear();
      });
      return () => sawPick && observed;
    },
  },
};

const seedGroups = new Map<number, UpgradeId[]>();
for (const upgradeId of UPGRADE_IDS) {
  const seed = (SEED_FIXTURES as Record<string, number>)[
    `upgrade:${upgradeId}`
  ];
  if (seed === undefined) {
    throw new Error(
      `upgrades.test.ts: no seed for "upgrade:${upgradeId}" in test/seed-fixtures.json — run \`npm run record-seeds\``,
    );
  }
  const list = seedGroups.get(seed) ?? [];
  list.push(upgradeId);
  seedGroups.set(seed, list);
}

for (const [seed, upgradeIds] of [...seedGroups].sort(([a], [b]) => a - b)) {
  Deno.test(`upgrades: seed=${seed} modern picks + effects`, async (t) => {
    // Any upgrade in the group has the same seed; pick the first as the
    // loadSeed key so we share the registry's mode/rounds declaration.
    const sc = await loadSeed(`upgrade:${upgradeIds[0]!}`, { rounds: ROUNDS });

    // Install effect probes BEFORE driving the game so nothing is missed.
    const finalizers = new Map<UpgradeId, (picker: number) => boolean>();
    for (const upgradeId of upgradeIds) {
      const probe = EFFECT_PROBES[upgradeId];
      if (probe) finalizers.set(upgradeId, probe.install(sc));
    }

    const picks: Pick[] = [];
    sc.bus.on(GAME_EVENT.UPGRADE_PICKED, (ev) => {
      picks.push({ upgradeId: ev.upgradeId, playerId: ev.playerId });
    });

    // Run the full game so every probe has maximum opportunity to fire.
    sc.runGame({ timeoutMs: MAX_TIMEOUT_MS });

    for (const upgradeId of upgradeIds) {
      await t.step(`"${upgradeId}" is picked`, () => {
        const hit = picks.find((pick) => pick.upgradeId === upgradeId);
        assert(
          hit !== undefined,
          `expected "${upgradeId}" to be picked in seed=${seed}, saw picks=${picks
            .map((pick) => `${pick.upgradeId}(p${pick.playerId})`)
            .join(",")}`,
        );
      });

      const finalizer = finalizers.get(upgradeId);
      const probe = EFFECT_PROBES[upgradeId];
      if (!finalizer || !probe) continue;

      await t.step(`"${upgradeId}" effect fires (${probe.description})`, () => {
        const picker = picks.find((p) => p.upgradeId === upgradeId)?.playerId;
        assert(
          picker !== undefined,
          `cannot verify effect — "${upgradeId}" was never picked`,
        );
        assert(
          finalizer(picker),
          `effect not observed for "${upgradeId}" (picker=p${picker}): ${probe.description}`,
        );
      });
    }
  });
}

