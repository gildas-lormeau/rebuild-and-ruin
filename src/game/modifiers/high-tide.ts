/**
 * High Tide modifier — floods grass tiles adjacent to water (river banks widen by 1 tile).
 * Destroys walls, houses, grunts, bonus squares, burning pits, and cannons on flooded tiles.
 */

import { FID } from "../../shared/core/feature-defs.ts";
import { GRID_COLS, GRID_ROWS } from "../../shared/core/grid.ts";
import { hasTowerAt } from "../../shared/core/occupancy-queries.ts";
import { removeWallFromAllPlayers } from "../../shared/core/player-walls.ts";
import {
  cannonSize,
  DIRS_4,
  isGrass,
  isWater,
  packTile,
  setGrass,
  setWater,
  unpackTile,
} from "../../shared/core/spatial.ts";
import { type GameState, hasFeature } from "../../shared/core/types.ts";
import type { ModifierImpl, ModifierTileData } from "./modifier-types.ts";

export const highTideImpl: ModifierImpl = {
  apply: (state: GameState) => ({
    changedTiles: [...applyHighTide(state)],
    gruntsSpawned: 0,
  }),
  needsRecheck: true,
  clear: clearHighTide,
  zoneReset: resetHighTideTilesForZone,
  restore: (state: GameState, data: ModifierTileData) => {
    state.modern!.highTideTiles = data.highTideTiles
      ? new Set(data.highTideTiles)
      : null;
    reapplyHighTideTiles(state);
  },
};

/** Re-apply high tide tile mutations on a map regenerated from seed.
 *  Called during checkpoint restore and full-state recovery. Idempotent. */
function reapplyHighTideTiles(state: GameState): void {
  const highTide = state.modern?.highTideTiles;
  if (!highTide || highTide.size === 0) return;
  const tiles = state.map.tiles;
  for (const key of highTide) {
    const { r, c } = unpackTile(key);
    setWater(tiles, r, c);
  }
  state.map.mapVersion++;
}

/** Apply high tide: flood grass tiles adjacent to water. */
function applyHighTide(state: GameState): ReadonlySet<number> {
  const modern = state.modern;
  if (!modern) return new Set();
  const tiles = state.map.tiles;
  const flooded = new Set<number>();
  // Find all grass tiles that are 4-dir adjacent to water
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (!isGrass(tiles, r, c)) continue;
      if (hasTowerAt(state, r, c)) continue;
      for (const [dr, dc] of DIRS_4) {
        if (isWater(tiles, r + dr, c + dc)) {
          flooded.add(packTile(r, c));
          break;
        }
      }
    }
  }
  if (flooded.size === 0) return flooded;
  // Convert to water
  for (const key of flooded) {
    const { r, c } = unpackTile(key);
    setWater(tiles, r, c);
  }
  // Destroy structures on flooded tiles
  for (const key of flooded) {
    removeWallFromAllPlayers(state, key);
  }
  for (const key of flooded) {
    const { r, c } = unpackTile(key);
    for (const house of state.map.houses) {
      if (house.alive && house.row === r && house.col === c)
        house.alive = false;
    }
  }
  state.grunts = state.grunts.filter(
    (gr) => !flooded.has(packTile(gr.row, gr.col)),
  );
  state.bonusSquares = state.bonusSquares.filter(
    (bonus) => !flooded.has(packTile(bonus.row, bonus.col)),
  );
  state.burningPits = state.burningPits.filter(
    (pit) => !flooded.has(packTile(pit.row, pit.col)),
  );
  // Remove cannons on flooded tiles
  for (const player of state.players) {
    player.cannons = player.cannons.filter((cannon) => {
      const sz = cannonSize(cannon.mode);
      for (let dr = 0; dr < sz; dr++) {
        for (let dc = 0; dc < sz; dc++) {
          if (flooded.has(packTile(cannon.row + dr, cannon.col + dc)))
            return false;
        }
      }
      return true;
    });
  }
  modern.highTideTiles = flooded;
  state.map.mapVersion++;
  return flooded;
}

/** Revert high tide: restore flooded tiles back to grass. */
function clearHighTide(state: GameState): void {
  const modern = state.modern;
  if (!modern || !hasFeature(state, FID.MODIFIERS)) return;
  if (!modern.highTideTiles) return;
  const tiles = state.map.tiles;
  for (const key of modern.highTideTiles) {
    const { r, c } = unpackTile(key);
    setGrass(tiles, r, c);
  }
  modern.highTideTiles = null;
  state.map.mapVersion++;
}

/** Per-zone tile revert for high tide (zones[r][c] === zone → grass). */
function resetHighTideTilesForZone(state: GameState, zone: number): void {
  const highTide = state.modern?.highTideTiles;
  if (!highTide) return;
  for (const key of highTide) {
    const { r, c } = unpackTile(key);
    if (state.map.zones[r]?.[c] === zone) {
      setGrass(state.map.tiles, r, c);
      highTide.delete(key);
    }
  }
  if (highTide.size === 0) state.modern!.highTideTiles = null;
  state.map.mapVersion++;
}
