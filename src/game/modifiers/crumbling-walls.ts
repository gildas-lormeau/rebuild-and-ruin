/**
 * Crumbling Walls modifier — destroys a fraction of each player's outermost walls.
 */

import { getInterior } from "../../shared/core/board-occupancy.ts";
import { isPlayerSeated } from "../../shared/core/player-types.ts";
import { deletePlayerWallsBatch } from "../../shared/core/player-walls.ts";
import { DIRS_4, packTile, unpackTile } from "../../shared/core/spatial.ts";
import type { GameState } from "../../shared/core/types.ts";
import type { ModifierImpl } from "./modifier-types.ts";

/** Crumbling walls: fraction of outer walls destroyed. */
const CRUMBLE_FRACTION = 0.09;
const CRUMBLE_MIN = 2;
const CRUMBLE_MAX = 6;
export const crumblingWallsImpl: ModifierImpl = {
  apply: (state: GameState) => ({
    changedTiles: applyCrumblingWalls(state),
    gruntsSpawned: 0,
  }),
  needsRecheck: true,
};

/** Apply crumbling walls: destroy a fraction of each player's outermost walls.
 *  Returns the array of destroyed wall tile keys for the reveal banner. */
function applyCrumblingWalls(state: GameState): readonly number[] {
  const destroyed: number[] = [];

  for (const player of state.players) {
    if (!isPlayerSeated(player)) continue;
    if (player.walls.size === 0) continue;

    // Outer walls: wall tiles with at least one non-wall non-interior neighbor
    const interior = getInterior(player);
    const outerWalls: number[] = [];
    for (const key of player.walls) {
      const { r, c } = unpackTile(key);
      const isOuter = DIRS_4.some(([dr, dc]) => {
        const neighborKey = packTile(r + dr, c + dc);
        return !player.walls.has(neighborKey) && !interior.has(neighborKey);
      });
      if (isOuter) outerWalls.push(key);
    }

    if (outerWalls.length === 0) continue;

    // Protect castle wall tiles from crumbling
    const destructible = outerWalls.filter(
      (k) => !player.castleWallTiles.has(k),
    );
    if (destructible.length === 0) continue;

    const count = Math.min(
      Math.max(CRUMBLE_MIN, Math.round(destructible.length * CRUMBLE_FRACTION)),
      CRUMBLE_MAX,
      destructible.length,
    );

    // Shuffle and pick first `count`
    state.rng.shuffle(destructible);
    const batch = destructible.slice(0, count);
    deletePlayerWallsBatch(player, batch);
    destroyed.push(...batch);
  }
  return destroyed;
}
