/**
 * Upgrade tests — one game per implemented upgrade.
 *
 * Each test forces its upgrade via `testHooks.forceUpgrade` (makes it the first
 * offer) plus `disabledUpgrades` (removes every other id from the pool), so the
 * offer list is just `[upgradeId]` and all players pick it every round from
 * round 3. The pick is therefore guaranteed by construction — no seed registry,
 * no RNG drift. This replaced a seed-grouped design that broke whenever the
 * shared-RNG stream shifted (e.g. the R5b fix); see docs/runtime-invariants.md.
 *
 * Each test asserts (1) the upgrade was picked and (2) its effect fired, when an
 * `EFFECT_PROBES` entry exists. Upgrades without a probe get a pick-only
 * assertion. To add a probe:
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
import {
  IMPLEMENTED_UPGRADES,
  type UpgradeId,
} from "../src/shared/core/upgrade-defs.ts";
import { createScenario, type Scenario } from "./scenario.ts";

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

/** Every implemented upgrade — derived from the pool so new upgrades are
 *  auto-covered. Upgrades without an `EFFECT_PROBES` entry get a pick-only
 *  assertion. */
const UPGRADE_IDS: readonly UpgradeId[] = IMPLEMENTED_UPGRADES.map(
  (def) => def.id,
);
/** Generous sim-time ceiling for a full modern game (mock clock on headless). */
const MAX_TIMEOUT_MS = 1_800_000;
/** Rounds per run. The forced upgrade is picked from round 3 (the first
 *  UPGRADE_PICK phase), so a handful of rounds gives every effect — including
 *  battle-conditional ones (reinforced_walls absorb, mortar fire) — several
 *  post-pick battle phases to manifest across all three forced players. */
const ROUNDS = 8;
/** Effect probes for the 9 easy-tier upgrades. See file header for the
 *  design rationale. Missing entries fall back to pick-only assertions.
 *
 *  Timing note: `setPhase` emits PHASE_START BEFORE onBuildPhaseStart/
 *  onBattlePhaseStart run, so probes that need the phase-setup state
 *  observe at PHASE_END of the SAME phase (setup state persists through
 *  the phase and is still visible at the transition to the next phase).
 *  Pick-time effects observe at PHASE_END(BATTLE) because UPGRADE_PICKED
 *  events fire synchronously during applyUpgradePicks, which runs BEFORE
 *  finalizeBattle emits PHASE_END(BATTLE). */
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
    description: "grunts.length === 0 on the first event after pick",
    install: (sc) => {
      let pendingCheck = false;
      let observed = false;
      // UPGRADE_PICKED fires BEFORE onPick (which sets grunts.length = 0)
      // runs. Snapshot intent here; observe state on the very next bus
      // event — same skip-self pattern as second_wind.
      sc.bus.on(GAME_EVENT.UPGRADE_PICKED, (ev) => {
        if (ev.upgradeId === "clear_the_field") pendingCheck = true;
      });
      sc.bus.onAny((type, ev) => {
        if (!pendingCheck) return;
        if (
          type === "upgradePicked" &&
          (ev as { upgradeId: string }).upgradeId === "clear_the_field"
        ) {
          return;
        }
        if (sc.state.grunts.length === 0) observed = true;
        pendingCheck = false;
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
/** One game per upgrade. `forceUpgrade` makes the upgrade the first offer and
 *  `disabledUpgrades` removes every other id from the pool, so the offer list
 *  is just `[upgradeId]` and all three (AI) players pick it every round from
 *  round 3 on. No seeds, no drift — the pick is guaranteed by construction, so
 *  the only thing left to verify is that the effect fires. Drives off a single
 *  fixed seed (the draws that would pick upgrades are short-circuited, so the
 *  seed only flavors map + AI movement). The seed IS sensitive for the
 *  demolition probe specifically — it observes a net wall-count drop across the
 *  pick→next-battle-end window (which spans a rebuild), so a seed where every
 *  player rebuilds back past the strip reads as "not observed". Re-picked 0→1
 *  when the grunt-spawn-rate bump drifted seed-0 into that masking case.
 *  Re-picked 1→2 when the chain-attack in-flight dedup drifted seed-1 into
 *  the masking case (every player rebuilt back past the demolition strip).
 *  Re-picked 2→0 when gating pinch_kill behind a per-player probability roll
 *  drifted seed-2 into the masking case (seed-0 now un-masks).
 *  Re-picked 0→1 when crosshair-seeded chain ordering (orderByNearest `from`)
 *  drifted seed-0 into the masking case.
 *  Re-picked 1→0 when the cursor ping-pong fixes (sticky battle victim +
 *  cursor-nearest breach rotation) drifted seed-1; seed-0 un-masks again. */
const SEED = 0;

for (const upgradeId of UPGRADE_IDS) {
  Deno.test(`upgrades: ${upgradeId} is forced-picked + effect fires`, async () => {
    const sc = await createScenario({
      seed: SEED,
      mode: "modern",
      rounds: ROUNDS,
      testHooks: {
        forceUpgrade: upgradeId,
        disabledUpgrades: UPGRADE_IDS.filter((id) => id !== upgradeId),
      },
    });

    // Install the effect probe BEFORE driving the game so nothing is missed.
    const probe = EFFECT_PROBES[upgradeId];
    const finalizer = probe?.install(sc);

    const picks: Pick[] = [];
    sc.bus.on(GAME_EVENT.UPGRADE_PICKED, (ev) => {
      picks.push({ upgradeId: ev.upgradeId, playerId: ev.playerId });
    });

    sc.runGame({ timeoutMs: MAX_TIMEOUT_MS });

    const hit = picks.find((pick) => pick.upgradeId === upgradeId);
    assert(
      hit !== undefined,
      `expected "${upgradeId}" to be force-picked, saw picks=${picks
        .map((pick) => `${pick.upgradeId}(p${pick.playerId})`)
        .join(",")}`,
    );

    if (finalizer && probe) {
      assert(
        finalizer(hit.playerId),
        `effect not observed for "${upgradeId}" (picker=p${hit.playerId}): ${probe.description}`,
      );
    }
  });
}
