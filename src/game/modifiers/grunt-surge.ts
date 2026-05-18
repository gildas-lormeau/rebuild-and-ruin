/**
 * Grunt Surge modifier — spawns extra grunts distributed across all alive towers.
 *
 * Returns spawn descriptors via ModifierApplyResult.spawnRequests; the
 * orchestrator (phase-setup.applyBattleStartModifiers) executes them via
 * spawnGruntSurgeOnZone. Keeps this file in the deep-logic layer without
 * importing grunt-system.
 */

import { isPlayerSeated } from "../../shared/core/player-types.ts";
import type {
  ModifierImpl,
  ModifierSpawnRequest,
} from "../../shared/core/types.ts";

/** Extra grunts per player during a grunt surge.
 *  Baseline is ~15 grunts per territory in a typical game,
 *  so 6-10 extra is a serious but not overwhelming spike. */
const GRUNT_SURGE_COUNT_MIN = 6;
const GRUNT_SURGE_COUNT_MAX = 10;
export const gruntSurgeImpl: ModifierImpl = {
  lifecycle: "instant",
  apply: (state) => {
    const extraCount = state.rng.int(
      GRUNT_SURGE_COUNT_MIN,
      GRUNT_SURGE_COUNT_MAX,
    );
    const spawnRequests: ModifierSpawnRequest[] = [];
    for (const player of state.players) {
      if (!isPlayerSeated(player)) continue;
      spawnRequests.push({ playerId: player.id, count: extraCount });
    }
    // changedTiles + gruntsSpawned are populated by the orchestrator after
    // it executes spawnRequests — the spawn itself happens outside apply().
    return { changedTiles: [], gruntsSpawned: 0, spawnRequests };
  },
  // Spawns grunts only — no map / wall mutation.
  skipsRecheck: true,
};
