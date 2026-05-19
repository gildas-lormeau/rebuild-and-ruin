/**
 * Frostbite modifier — grunts spawn as immobile ice cubes that take two
 * hits to break (first hit sets `grunt.chipped`; second kills). Chip state
 * rides on the grunt itself, so it dies with the grunt and survives host
 * migration via the standard grunt serialization.
 */

import type { TileKey } from "../../shared/core/grid.ts";
import { packTile } from "../../shared/core/spatial.ts";
import type { GameState, ModifierImpl } from "../../shared/core/types.ts";

export const frostbiteImpl: ModifierImpl = {
  lifecycle: "instant",
  apply: (state: GameState) => {
    // Reset stale chip flags from a prior frostbite round so the new battle
    // starts with every grunt at full ice-cube health. Then pulse the
    // existing grunt tiles — those are the units about to freeze.
    const changedTiles: TileKey[] = [];
    for (const grunt of state.grunts) {
      grunt.chipped = undefined;
      changedTiles.push(packTile(grunt.row, grunt.col));
    }
    return { changedTiles, gruntsSpawned: 0 };
  },
  // No walls touched, no tile passability change — pure entity-level effect.
  skipsRecheck: true,
};
