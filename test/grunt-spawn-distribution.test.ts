/**
 * Regression: spawning grunts on an enemy's zone across multiple events
 * within a single round must not reuse the same tile. The spawn picker
 * rotates the sorted bank/edge list by `gruntSpawnSeq % length`,
 * advancing the seq once per call, AND distance-filters against a
 * per-zone "tiles used this round" set that clears at the round-end
 * transition. Cross-round reuse is allowed by design (the used-tile
 * set clears) — only within-round reuse is asserted here.
 *
 * Failure mode: the test prints a per-zone, per-round breakdown so a
 * regression points directly at the offending (zone, round, tile).
 */

import { assert } from "@std/assert";
import { createScenario, waitUntilRound } from "./scenario.ts";
import { GRUNT_SPAWN_MIN_DISTANCE } from "../src/shared/core/game-constants.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { packTile, zoneAt } from "../src/shared/core/spatial.ts";
import type { TileKey } from "../src/shared/core/grid.ts";
import type { ZoneId } from "../src/shared/core/zone-id.ts";

type SpawnRecord = {
  round: number;
  row: number;
  col: number;
  zone: ZoneId | undefined;
  tile: TileKey;
};

const ROUNDS_OBSERVED = 4;
const MAX_REUSE_PER_TILE = 1;
const MIN_PAIRWISE_DISTANCE = GRUNT_SPAWN_MIN_DISTANCE;
const SEEDS = [42, 7, 0, 13] as const;

for (const seed of SEEDS) {
  Deno.test(
    `grunt zone-pick spawns within a single round do not reuse tiles (seed=${seed}, ${ROUNDS_OBSERVED} rounds)`,
    async () => {
      const sc = await createScenario({
        seed,
        rounds: ROUNDS_OBSERVED + 1,
      });

      const spawns: SpawnRecord[] = [];
      sc.bus.on(GAME_EVENT.GRUNT_SPAWN, (ev) => {
        // House-crush spawns intentionally land on the crushed tile —
        // they bypass the distribution picker. Only zone-pick spawns
        // are subject to the no-cluster rule.
        if (ev.source !== "zone-pick") return;
        spawns.push({
          round: ev.round,
          row: ev.row,
          col: ev.col,
          zone: zoneAt(sc.state.map, ev.row, ev.col),
          tile: packTile(ev.row, ev.col),
        });
      });

      waitUntilRound(sc, ROUNDS_OBSERVED + 1, { timeoutMs: 480_000 });

      // Group spawns by (zone, round), count reuse per tile. The seq
      // resets each round, so we only assert uniqueness within one
      // round.
      const byZoneRound = new Map<string, Map<TileKey, SpawnRecord[]>>();
      for (const spawn of spawns) {
        if (spawn.zone === undefined) continue;
        const key = `${spawn.zone}/${spawn.round}`;
        let tileMap = byZoneRound.get(key);
        if (!tileMap) {
          tileMap = new Map();
          byZoneRound.set(key, tileMap);
        }
        const list = tileMap.get(spawn.tile) ?? [];
        list.push(spawn);
        tileMap.set(spawn.tile, list);
      }

      const violations: string[] = [];
      for (const [zoneRound, tileMap] of byZoneRound) {
        for (const [, records] of tileMap) {
          if (records.length > MAX_REUSE_PER_TILE) {
            const first = records[0]!;
            violations.push(
              `  zone/round=${zoneRound} tile=(${first.row},${first.col}) ` +
                `reused ${records.length}x in the same round`,
            );
          }
        }
        // Pairwise check: every pair of spawn tiles in this (zone,round)
        // must be at least MIN_PAIRWISE_DISTANCE apart. Catches the case
        // where tiles are "unique" but visually adjacent.
        const tilesInBucket = Array.from(tileMap.values())
          .flat()
          .filter(
            (rec, idx, all) =>
              all.findIndex((other) => other.tile === rec.tile) === idx,
          );
        let minPair = Infinity;
        let closestA: SpawnRecord | undefined;
        let closestB: SpawnRecord | undefined;
        for (let i = 0; i < tilesInBucket.length; i++) {
          for (let j = i + 1; j < tilesInBucket.length; j++) {
            const a = tilesInBucket[i]!;
            const b = tilesInBucket[j]!;
            const dist =
              Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
            if (dist < minPair) {
              minPair = dist;
              closestA = a;
              closestB = b;
            }
          }
        }
        if (closestA && closestB && minPair < MIN_PAIRWISE_DISTANCE) {
          violations.push(
            `  zone/round=${zoneRound} closest pair (${closestA.row},${closestA.col})` +
              ` & (${closestB.row},${closestB.col}) at distance ${minPair}` +
              ` (< ${MIN_PAIRWISE_DISTANCE})`,
          );
        }
      }

      for (const [zoneRound, tileMap] of byZoneRound) {
        const total = Array.from(tileMap.values()).reduce(
          (sum, recs) => sum + recs.length,
          0,
        );
        console.log(
          `seed=${seed} zone/round ${zoneRound}: ${total} spawns across ${tileMap.size} unique tiles`,
        );
      }

      assert(
        violations.length === 0,
        `grunt spawns clustered (max reuse per tile = ${MAX_REUSE_PER_TILE}):\n` +
          violations.join("\n"),
      );
    },
  );
}
