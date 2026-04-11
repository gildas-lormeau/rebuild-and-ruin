/**
 * Find seeds that pick each implemented upgrade (at least once, by any player).
 *
 * One pass — scans seeds 0..max, subscribing to `upgradePicked` bus events,
 * and records the first seed that produced each UpgradeId. Stops early once
 * every implemented upgrade has a seed.
 *
 * Usage:
 *   deno run -A scripts/find-upgrade-seeds.ts [--max N] [--rounds R]
 */

import { GAME_EVENT } from "../src/shared/game-event-bus.ts";
import { IMPLEMENTED_UPGRADES, type UpgradeId } from "../src/shared/upgrade-defs.ts";
import { createScenario } from "../test/scenario.ts";

const args = Deno.args;
let max = 80;
let rounds = 8;
for (let idx = 0; idx < args.length; idx++) {
  const arg = args[idx];
  if (arg === "--max" && args[idx + 1]) max = Number(args[++idx]);
  else if (arg === "--rounds" && args[idx + 1]) rounds = Number(args[++idx]);
}

const targets = new Set<UpgradeId>(IMPLEMENTED_UPGRADES.map((u) => u.id));
const found = new Map<UpgradeId, { seed: number; playerId: number }>();
const start = Date.now();

for (let seed = 0; seed < max && found.size < targets.size; seed++) {
  try {
    const sc = await createScenario({ seed, mode: "modern", rounds });
    const picks: { id: UpgradeId; playerId: number }[] = [];
    sc.bus.on(GAME_EVENT.UPGRADE_PICKED, (ev) => {
      picks.push({ id: ev.upgradeId, playerId: ev.playerId });
    });
    sc.runGame(60000);
    for (const pick of picks) {
      if (!found.has(pick.id)) {
        found.set(pick.id, { seed, playerId: pick.playerId });
      }
    }
    console.log(
      `seed=${seed}  covered=${found.size}/${targets.size}  picks=${picks.map((p) => p.id).join(",") || "(none)"}`,
    );
  } catch (err) {
    console.log(`seed=${seed}  ERROR: ${(err as Error).message}`);
  }
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\nScanned in ${elapsed}s\n`);
console.log("=== Upgrade → seed table ===");
for (const def of IMPLEMENTED_UPGRADES) {
  const hit = found.get(def.id);
  console.log(
    hit
      ? `  ${def.id.padEnd(22)} seed=${hit.seed}  player=${hit.playerId}`
      : `  ${def.id.padEnd(22)} NOT FOUND`,
  );
}
