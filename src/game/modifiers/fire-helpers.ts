/**
 * Shared fire helpers — burn predicate and scar applicator used by both
 * wildfire and dry-lightning modifiers.
 */

import type { BurningPit } from "../../shared/core/battle-types.ts";
import {
  hasCannonAt,
  removeWallFromAllPlayers,
} from "../../shared/core/board-occupancy.ts";
import { BURNING_PIT_DURATION } from "../../shared/core/game-constants.ts";
import { GRID_COLS, GRID_ROWS } from "../../shared/core/grid.ts";
import {
  DIRS_4,
  isGrass,
  isWater,
  packTile,
  unpackTile,
} from "../../shared/core/spatial.ts";
import type { GameState } from "../../shared/core/types.ts";

/** Build a predicate for whether a tile can burn in a specific zone. */
export function buildCanBurnPredicate(
  state: GameState,
  targetZone: number,
): (row: number, col: number) => boolean {
  const tiles = state.map.tiles;
  const zones = state.map.zones;
  const burningSet = new Set(
    state.burningPits.map((pit) => packTile(pit.row, pit.col)),
  );
  return (row: number, col: number): boolean => {
    if (!isGrass(tiles, row, col)) return false;
    if (zones[row]?.[col] !== targetZone) return false;
    if (burningSet.has(packTile(row, col))) return false;
    if (hasCannonAt(state, row, col)) return false;
    // 1-tile gap from map edges and water so players can enclose the scar
    if (row <= 1 || row >= GRID_ROWS - 2 || col <= 1 || col >= GRID_COLS - 2)
      return false;
    for (const [dr, dc] of DIRS_4) {
      if (isWater(tiles, row + dr, col + dc)) return false;
    }
    return true;
  };
}

/** Destroy walls, houses, grunts, and bonus squares on all scar tiles; create burning pits. */
export function applyFireScar(
  state: GameState,
  scar: ReadonlySet<number>,
): void {
  const newPits: BurningPit[] = [];
  for (const key of scar) {
    const { r, c } = unpackTile(key);
    newPits.push({ row: r, col: c, roundsLeft: BURNING_PIT_DURATION });
    removeWallFromAllPlayers(state, key);
    for (const house of state.map.houses) {
      if (house.alive && house.row === r && house.col === c) {
        house.alive = false;
      }
    }
  }
  state.grunts = state.grunts.filter(
    (gr) => !scar.has(packTile(gr.row, gr.col)),
  );
  state.bonusSquares = state.bonusSquares.filter(
    (bonus) => !scar.has(packTile(bonus.row, bonus.col)),
  );
  state.burningPits.push(...newPits);
}
