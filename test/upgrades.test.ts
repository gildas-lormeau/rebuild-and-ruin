/**
 * Upgrade tests — one steps per implemented upgrade, grouped by seed.
 *
 * Many upgrades share a seed (seed 0 alone covers 11 of them), so tests are
 * grouped into one Deno.test per unique seed that runs the game ONCE and
 * emits a `t.step` per upgrade assigned to that seed. This cuts wall-clock
 * from ~76s (19 runGames) to ~24s (6 runGames) while keeping per-upgrade
 * failure attribution.
 *
 * Each step asserts an `upgradePicked` event fired for its target UpgradeId
 * during the run. Seeds come from `scripts/find-upgrade-seeds.ts`; refresh
 * alongside the determinism fixtures whenever the runtime RNG or draft
 * weights drift.
 */

import { assert } from "@std/assert";
import { createScenario } from "./scenario.ts";
import { GAME_EVENT } from "../src/shared/game-event-bus.ts";
import type { UpgradeId } from "../src/shared/upgrade-defs.ts";

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

interface Pick {
  readonly upgradeId: UpgradeId;
  readonly playerId: number;
}

const seedGroups = new Map<number, UpgradeId[]>();
for (const [rawId, entry] of Object.entries(UPGRADE_SEEDS)) {
  const list = seedGroups.get(entry.seed) ?? [];
  list.push(rawId as UpgradeId);
  seedGroups.set(entry.seed, list);
}

for (const [seed, upgradeIds] of [...seedGroups].sort(([a], [b]) => a - b)) {
  Deno.test(`upgrades: seed=${seed} modern picks ${upgradeIds.join(", ")}`, async (t) => {
    const sc = await createScenario({ seed, mode: "modern", rounds: 10 });
    const picks: Pick[] = [];
    const remaining = new Set<UpgradeId>(upgradeIds);
    sc.bus.on(GAME_EVENT.UPGRADE_PICKED, (ev) => {
      picks.push({ upgradeId: ev.upgradeId, playerId: ev.playerId });
      remaining.delete(ev.upgradeId);
    });
    sc.runUntil(() => remaining.size === 0, MAX_TICKS);

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
    }
  });
}
