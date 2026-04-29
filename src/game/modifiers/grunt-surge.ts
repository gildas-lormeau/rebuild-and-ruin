/**
 * Grunt Surge modifier — spawns extra grunts distributed across all alive towers.
 *
 * The actual spawning call (spawnGruntSurgeOnZone) lives in a higher layer
 * (grunt-system.ts), so it's injected by modifier-system.ts via applyGruntSurge.
 */

import { FIRST_GRUNT_SPAWN_ROUND } from "../../shared/core/game-constants.ts";
import type { ValidPlayerSlot } from "../../shared/core/player-slot.ts";
import { isPlayerSeated } from "../../shared/core/player-types.ts";
import { packTile } from "../../shared/core/spatial.ts";
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
    lifecycle: "instant",
    apply: (state: GameState) => {
      const result = applyGruntSurge(state, spawnOnZone);
      return {
        changedTiles: result.spawnTiles,
        gruntsSpawned: result.count,
      };
    },
    // Spawns grunts only — no map / wall mutation.
    skipsRecheck: true,
  };
}

/** Apply grunt surge: spawn extra grunts distributed across all alive towers.
 *  Returns the spawn count (for the reveal banner) and the tile keys of
 *  newly spawned grunts (for the reveal-dwell tile pulse). */
function applyGruntSurge(
  state: GameState,
  spawnOnZone: (
    state: GameState,
    playerId: ValidPlayerSlot,
    count: number,
  ) => void,
): { count: number; spawnTiles: number[] } {
  if (state.round < FIRST_GRUNT_SPAWN_ROUND)
    return { count: 0, spawnTiles: [] };
  const gruntsBefore = state.grunts.length;
  const extraCount = state.rng.int(
    GRUNT_SURGE_COUNT_MIN,
    GRUNT_SURGE_COUNT_MAX,
  );
  for (const player of state.players) {
    if (!isPlayerSeated(player)) continue;
    spawnOnZone(state, player.id, extraCount);
  }
  const spawnTiles: number[] = [];
  for (let i = gruntsBefore; i < state.grunts.length; i++) {
    const grunt = state.grunts[i]!;
    spawnTiles.push(packTile(grunt.row, grunt.col));
  }
  return { count: state.grunts.length - gruntsBefore, spawnTiles };
}
