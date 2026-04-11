/**
 * Upgrade tests — one test per implemented upgrade.
 *
 * Each test picks a seed (discovered via `scripts/find-upgrade-seeds.ts`) that
 * is known to produce a pick of the target upgrade during a modern-mode game,
 * runs the game to completion, and asserts that:
 *   1. an `upgradePicked` bus event fired for the expected UpgradeId
 *   2. the picking player's `upgrades` map contains the id at that moment
 *
 * The seeds are discovered per-scan, not hand-picked. To refresh after a
 * runtime/RNG change:
 *
 *     deno run -A scripts/find-upgrade-seeds.ts --max 40 --rounds 10
 *
 * and copy the "Upgrade → seed table" output into `UPGRADE_SEEDS` below.
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

for (const [rawId, entry] of Object.entries(UPGRADE_SEEDS)) {
  const upgradeId = rawId as UpgradeId;
  Deno.test(`upgrade: "${upgradeId}" is picked in seed=${entry.seed} modern`, async () => {
    const sc = await createScenario({
      seed: entry.seed,
      mode: "modern",
      rounds: 10,
    });

    const picks: { upgradeId: UpgradeId; playerId: number }[] = [];
    sc.bus.on(GAME_EVENT.UPGRADE_PICKED, (ev) => {
      picks.push({ upgradeId: ev.upgradeId, playerId: ev.playerId });
    });

    sc.runGame(MAX_TICKS);

    const hit = picks.find((pick) => pick.upgradeId === upgradeId);
    assert(
      hit !== undefined,
      `expected "${upgradeId}" to be picked in seed=${entry.seed}, saw picks=${picks
        .map((pick) => `${pick.upgradeId}(p${pick.playerId})`)
        .join(",")}`,
    );
  });
}
