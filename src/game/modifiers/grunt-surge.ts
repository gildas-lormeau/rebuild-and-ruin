/**
 * Grunt Surge modifier — spawns extra grunts distributed across all alive towers.
 *
 * The actual spawning call (spawnGruntSurgeOnZone) lives in a higher layer
 * (grunt-system.ts), so it's injected by round-modifiers.ts via applyGruntSurge.
 */

import { FIRST_GRUNT_SPAWN_ROUND } from "../../shared/core/game-constants.ts";
import type { ValidPlayerSlot } from "../../shared/core/player-slot.ts";
import { isPlayerSeated } from "../../shared/core/player-types.ts";
import type { GameState } from "../../shared/core/types.ts";
import type { ModifierImpl } from "./modifier-types.ts";

/** Extra grunts per player during a grunt surge.
 *  Baseline is ~15 grunts per territory in a typical game,
 *  so 6-10 extra is a serious but not overwhelming spike. */
const GRUNT_SURGE_COUNT_MIN = 6;
const GRUNT_SURGE_COUNT_MAX = 10;

/** Build the grunt surge impl. Accepts a spawn function so this file stays
 *  in the deep-logic layer and doesn't import grunt-system directly. */
export function createGruntSurgeImpl(
  spawnOnZone: (
    state: GameState,
    playerId: ValidPlayerSlot,
    count: number,
  ) => void,
): ModifierImpl {
  return {
    apply: (state: GameState) => ({
      changedTiles: [] as number[],
      gruntsSpawned: applyGruntSurge(state, spawnOnZone),
    }),
    needsRecheck: false,
  };
}

/** Apply grunt surge: spawn extra grunts distributed across all alive towers.
 *  Returns the number of grunts spawned for the reveal banner. */
function applyGruntSurge(
  state: GameState,
  spawnOnZone: (
    state: GameState,
    playerId: ValidPlayerSlot,
    count: number,
  ) => void,
): number {
  if (state.round < FIRST_GRUNT_SPAWN_ROUND) return 0;
  const gruntsBefore = state.grunts.length;
  const extraCount = state.rng.int(
    GRUNT_SURGE_COUNT_MIN,
    GRUNT_SURGE_COUNT_MAX,
  );
  for (const player of state.players.filter(isPlayerSeated)) {
    spawnOnZone(state, player.id, extraCount);
  }
  return state.grunts.length - gruntsBefore;
}
