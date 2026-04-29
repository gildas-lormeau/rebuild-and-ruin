/**
 * Frozen River modifier — freezes the entire river, allowing cross-zone grunt movement.
 * Round-scoped: lasts from this round's BATTLE through UPGRADE_PICK + WALL_BUILD +
 * the next round's CANNON_PLACE, then thaws in `prepareBattleState`'s
 * `clearActiveModifiers` call (just before the next modifier rolls).
 * Thaw kills grunts stranded on water tiles.
 */

import { FID } from "../../shared/core/feature-defs.ts";
import { GRID_COLS, GRID_ROWS } from "../../shared/core/grid.ts";
import { isWater, packTile } from "../../shared/core/spatial.ts";
import { type GameState, hasFeature } from "../../shared/core/types.ts";
import type { ModifierImpl, ModifierTileData } from "./modifier-types.ts";

export const frozenRiverImpl: ModifierImpl = {
  lifecycle: "round-scoped",
  apply: (state: GameState) => ({
    changedTiles: [...applyFrozenRiver(state)],
    gruntsSpawned: 0,
  }),
  // Marks frozen positions in a Set; does not mutate `state.map.tiles`
  // (water stays water, just walkable). Interior is unaffected.
  skipsRecheck: true,
  clear: clearFrozenRiver,
  restore: (state: GameState, data: ModifierTileData) => {
    if ("frozenTiles" in data) {
      state.modern!.frozenTiles = data.frozenTiles
        ? new Set(data.frozenTiles)
        : null;
    }
  },
};

/** Apply frozen river: freeze the entire river, allowing grunts to walk
 *  across zones and target any tower. Returns the set of frozen tile keys. */
function applyFrozenRiver(state: GameState): ReadonlySet<number> {
  const modern = state.modern;
  if (!modern) return new Set();
  const frozen = new Set<number>();
  const tiles = state.map.tiles;
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (isWater(tiles, r, c)) frozen.add(packTile(r, c));
    }
  }
  if (frozen.size === 0) return frozen;
  modern.frozenTiles = frozen;
  state.map.mapVersion++;

  // Force all grunts to re-lock targets with zones open — grunts near the
  // river will pick cross-zone towers, grunts far away keep same-zone targets.
  for (const grunt of state.grunts) {
    grunt.targetTowerIdx = undefined;
  }
  return frozen;
}

/** Thaw frozen river: kill grunts stranded on water, clear frozen state.
 *  Also resets all surviving grunts' targets so they re-lock against the
 *  post-thaw zone filter (cross-zone targets picked while frozen are no
 *  longer reachable once water is impassable again). */
function clearFrozenRiver(state: GameState): void {
  const modern = state.modern;
  if (!modern || !hasFeature(state, FID.MODIFIERS)) return;
  if (modern.frozenTiles) {
    state.grunts = state.grunts.filter(
      (gr) => !modern.frozenTiles!.has(packTile(gr.row, gr.col)),
    );
    for (const grunt of state.grunts) {
      grunt.targetTowerIdx = undefined;
    }
  }
  modern.frozenTiles = null;
  state.map.mapVersion++;
}
