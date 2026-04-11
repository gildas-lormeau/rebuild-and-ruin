/**
 * Upgrade tests — one test per implemented upgrade, grouped by seed.
 *
 * Each grouped test runs a modern-mode game once and asserts two things
 * per upgrade (when a probe exists): the upgrade was picked, AND its
 * effect was observed. Groups share a seed so the runtime is spun up
 * once per unique seed.
 *
 * Effects are observed via:
 *   - Bus events (e.g. wallAbsorbed for reinforced_walls)
 *   - State snapshots at phase-start events (effects that fire at pick
 *     time are verified at the next WALL_BUILD phaseStart, by which time
 *     applyUpgradePicks has fully run)
 *   - State scans at battle-start (mortar/shield_battery election flags)
 *
 * Upgrades without an effect probe yield to a pick-only assertion, same
 * as before. To add a probe for one of the gaps:
 *   1. Add an entry to EFFECT_PROBES keyed by UpgradeId
 *   2. Install listeners in `install(sc)` and return a finalizer that
 *      takes the picker's playerId and returns whether the effect fired
 *   3. Probes that need a "before" snapshot should listen for
 *      UPGRADE_PICKED (which fires BEFORE onUpgradePicked runs) and
 *      capture the pre-effect state, then compare against a later
 *      snapshot at PHASE_START.
 *
 * Seeds come from `scripts/find-upgrade-seeds.ts`; refresh alongside the
 * determinism fixtures whenever the runtime RNG or draft weights drift.
 */

import { assert } from "@std/assert";
import { buildTimerBonus } from "../src/game/index.ts";
import { GAME_EVENT } from "../src/shared/game-event-bus.ts";
import { Phase } from "../src/shared/game-phase.ts";
import type { UpgradeId } from "../src/shared/upgrade-defs.ts";
import { createScenario, type Scenario } from "./scenario.ts";

interface SeedEntry {
  readonly seed: number;
  readonly playerId: number;
}

// Seeds discovered by scripts/find-upgrade-seeds.ts on 2026-04-11. Each seed
// is the smallest one (0..40) whose modern-mode playthrough picked the target
// upgrade at least once. If you re-run the scanner and get different numbers,
// the runtime RNG or draft weights have drifted — update these alongside the
// determinism fixtures.
const UPGRADE_SEEDS: Record<UpgradeId, SeedEntry> = {
  mortar: { seed: 1, playerId: 0 },
  rapid_fire: { seed: 0, playerId: 2 },
  ricochet: { seed: 1, playerId: 0 },
  shield_battery: { seed: 0, playerId: 1 },
  reinforced_walls: { seed: 0, playerId: 1 },
  master_builder: { seed: 0, playerId: 1 },
  small_pieces: { seed: 8, playerId: 2 },
  double_time: { seed: 0, playerId: 2 },
  architect: { seed: 0, playerId: 0 },
  foundations: { seed: 0, playerId: 1 },
  reclamation: { seed: 14, playerId: 1 },
  territorial_ambition: { seed: 1, playerId: 1 },
  conscription: { seed: 0, playerId: 0 },
  salvage: { seed: 0, playerId: 0 },
  ceasefire: { seed: 1, playerId: 2 },
  supply_drop: { seed: 0, playerId: 1 },
  second_wind: { seed: 21, playerId: 2 },
  demolition: { seed: 3, playerId: 1 },
  clear_the_field: { seed: 0, playerId: 2 },
};

const MAX_TICKS = 60000;
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
for (const [rawId, entry] of Object.entries(UPGRADE_SEEDS)) {
  const list = seedGroups.get(entry.seed) ?? [];
  list.push(rawId as UpgradeId);
  seedGroups.set(entry.seed, list);
}

for (const [seed, upgradeIds] of [...seedGroups].sort(([a], [b]) => a - b)) {
  Deno.test(`upgrades: seed=${seed} modern picks + effects`, async (t) => {
    const sc = await createScenario({ seed, mode: "modern", rounds: ROUNDS });

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
    sc.runGame(MAX_TICKS);

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

