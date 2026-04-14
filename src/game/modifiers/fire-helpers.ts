/**
 * Shared fire helpers — burn predicate and scar applicator used by both
 * wildfire and dry-lightning modifiers.
 */

import type { BurningPit } from "../../shared/core/battle-types.ts";
import { BURNING_PIT_DURATION } from "../../shared/core/game-constants.ts";
import { GRID_COLS, GRID_ROWS } from "../../shared/core/grid.ts";
import {
  hasCannonAt,
  hasTowerAt,
} from "../../shared/core/occupancy-queries.ts";
import { removeWallFromAllPlayers } from "../../shared/core/player-walls.ts";
import {
  DIRS_4,
  isGrass,
  isWater,
  packTile,
  unpackTile,
} from "../../shared/core/spatial.ts";
import type { GameState } from "../../shared/core/types.ts";
import { getProtectedCastleTiles } from "./modifier-eligibility.ts";

/** Build a predicate for whether a tile can burn in a specific zone. Tiles
 *  protected by a fresh castle's grace period are rejected so scars never
 *  land on the castle tower or its wall ring. */
export function buildCanBurnPredicate(
  state: GameState,
  targetZone: number,
): (row: number, col: number) => boolean {
  const protectedTiles = getProtectedCastleTiles(state);
  const tiles = state.map.tiles;
  const zones = state.map.zones;
  const burningSet = new Set(
    state.burningPits.map((pit) => packTile(pit.row, pit.col)),
  );
  return (row: number, col: number): boolean => {
    if (!isGrass(tiles, row, col)) return false;
    if (zones[row]?.[col] !== targetZone) return false;
    if (protectedTiles.has(packTile(row, col))) return false;
    if (burningSet.has(packTile(row, col))) return false;
    if (hasTowerAt(state, row, col)) return false;
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
  const protectedTiles = getProtectedCastleTiles(state);
  if (protectedTiles.size > 0) {
    for (const key of scar) {
      if (protectedTiles.has(key)) {
        const { r, c } = unpackTile(key);
        throw new Error(
          `applyFireScar touched fresh-castle tile (${r},${c}) — buildCanBurnPredicate already rejects these, so the caller likely bypassed the predicate`,
        );
      }
    }
  }
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
