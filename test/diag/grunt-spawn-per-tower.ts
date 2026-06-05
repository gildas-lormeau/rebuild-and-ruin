/**
 * Count zone-pick spawns per (zone, tower) per round. The fix asserts:
 * no single tower in any zone collects > X% of spawns in any round.
 *
 * Each spawn is attributed to its nearest tower (same metric a grunt
 * uses when picking a target). Output is a per-(zone,round,tower) table
 * so we can see whether spawns concentrate on one tower or spread.
 */

import { createScenario } from "../scenario.ts";
import { GAME_EVENT } from "../../src/shared/core/game-event-bus.ts";
import { zoneAt, manhattanDistance } from "../../src/shared/core/spatial.ts";

const SEEDS = [42, 7, 0, 13] as const;
const ROUNDS = 5;

for (const seed of SEEDS) {
  const sc = await createScenario({ seed, rounds: ROUNDS + 1 });

  // (round, zone, towerIdx) → count
  const counts = new Map<string, number>();

  sc.bus.on(GAME_EVENT.GRUNT_SPAWN, (ev) => {
    if (ev.source !== "zone-pick") return;
    const zone = zoneAt(sc.state.map, ev.row, ev.col);
    if (zone === undefined) return;
    let nearestIdx = -1;
    let nearestDist = Infinity;
    for (let i = 0; i < sc.state.map.towers.length; i++) {
      const tower = sc.state.map.towers[i]!;
      if (tower.zone !== zone) continue;
      const d = manhattanDistance(
        tower.row + 1,
        tower.col + 1,
        ev.row,
        ev.col,
      );
      if (d < nearestDist) {
        nearestDist = d;
        nearestIdx = i;
      }
    }
    const key = `${ev.round}|${zone}|${nearestIdx}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });

  sc.runUntil(() => sc.state.round > ROUNDS, { timeoutMs: 480_000 });

  // Group by (round, zone) and report distribution across towers.
  const byRoundZone = new Map<string, Map<number, number>>();
  for (const [key, count] of counts) {
    const [round, zone, tower] = key.split("|");
    const rz = `${round}|${zone}`;
    let m = byRoundZone.get(rz);
    if (!m) {
      m = new Map();
      byRoundZone.set(rz, m);
    }
    m.set(Number(tower), count);
  }

  console.log(`\n=== seed=${seed} ===`);
  const sortedKeys = [...byRoundZone.keys()].sort();
  for (const rz of sortedKeys) {
    const m = byRoundZone.get(rz)!;
    const [round, zone] = rz.split("|");
    const total = Array.from(m.values()).reduce((s, v) => s + v, 0);
    const parts = [...m.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([tower, n]) => `tower${tower}=${n}(${Math.round((n / total) * 100)}%)`)
      .join("  ");
    console.log(`  round=${round} zone=${zone} total=${total}  ${parts}`);
  }
}
