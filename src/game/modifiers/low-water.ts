/**
 * Low Water modifier — converts all shallow river-edge tiles to grass
 * (river banks narrow by 1 tile). Mirror of high tide.
 */

import { FID } from "../../shared/core/feature-defs.ts";
import { GRID_COLS, GRID_ROWS, type Tile } from "../../shared/core/grid.ts";
import { removeWallFromAllPlayers } from "../../shared/core/player-walls.ts";
// jscpd:ignore-start
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

export const lowWaterImpl: ModifierImpl = {
  lifecycle: "round-scoped",
  apply: (state: GameState) => ({
    changedTiles: [...applyLowWater(state)],
    gruntsSpawned: 0,
  }),
  clear: clearLowWater,
  zoneReset: resetLowWaterTilesForZone,
  restore: (state: GameState, data: ModifierTileData) => {
    state.modern!.lowWaterTiles = data.lowWaterTiles
      ? new Set(data.lowWaterTiles)
      : null;
    reapplyLowWaterTiles(state);
  },
};

/** Re-apply low water tile mutations on a map regenerated from seed.
 *  Called during checkpoint restore and full-state recovery. Idempotent. */
function reapplyLowWaterTiles(state: GameState): void {
  const lowWater = state.modern?.lowWaterTiles;
  if (!lowWater || lowWater.size === 0) return;
  const tiles = state.map.tiles;
  for (const key of lowWater) {
    const { r, c } = unpackTile(key);
    setGrass(tiles, r, c);
  }
  state.map.mapVersion++;
}

/** Apply low water: erode one layer of bank tiles, preserving 2×2 water
 *  blocks so the river never thins to a 1-wide channel. */
function applyLowWater(state: GameState): ReadonlySet<number> {
  const modern = state.modern;
  if (!modern) return new Set();
  const tiles = state.map.tiles;
  const converted = new Set<number>();
  // Snapshot bank tiles before any mutations.
  const banks: number[] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (!isWater(tiles, r, c)) continue;
      for (const [dr, dc] of DIRS_4) {
        if (isGrass(tiles, r + dr, c + dc)) {
          banks.push(packTile(r, c));
          break;
        }
      }
    }
  }
  // Greedy erosion: convert each bank tile only if every remaining water
  // neighbor still belongs to at least one 2×2 water block afterwards.
  for (const key of banks) {
    const { r, c } = unpackTile(key);
    if (!isWater(tiles, r, c)) continue;
    // Tentatively convert
    setGrass(tiles, r, c);
    // Check all water neighbors still have a 2×2
    let safe = true;
    for (const [dr, dc] of DIRS_4) {
      const nr = r + dr;
      const nc = c + dc;
      if (!isWater(tiles, nr, nc)) continue;
      if (!inWater2x2(tiles, nr, nc)) {
        safe = false;
        break;
      }
    }
    if (safe) {
      converted.add(key);
    } else {
      // Revert
      setWater(tiles, r, c);
    }
  }
  if (converted.size === 0) return converted;
  modern.lowWaterTiles = converted;
  state.map.mapVersion++;
  return converted;
}

/** True when (r,c) belongs to at least one 2×2 all-water square. */
function inWater2x2(
  tiles: readonly (readonly Tile[])[],
  r: number,
  c: number,
): boolean {
  return (
    (isWater(tiles, r, c + 1) &&
      isWater(tiles, r + 1, c) &&
      isWater(tiles, r + 1, c + 1)) ||
    (isWater(tiles, r, c - 1) &&
      isWater(tiles, r + 1, c) &&
      isWater(tiles, r + 1, c - 1)) ||
    (isWater(tiles, r, c + 1) &&
      isWater(tiles, r - 1, c) &&
      isWater(tiles, r - 1, c + 1)) ||
    (isWater(tiles, r, c - 1) &&
      isWater(tiles, r - 1, c) &&
      isWater(tiles, r - 1, c - 1))
  );
}

/** Revert low water: restore converted tiles back to water. */
function clearLowWater(state: GameState): void {
  const modern = state.modern;
  if (!modern || !hasFeature(state, FID.MODIFIERS)) return;
  if (!modern.lowWaterTiles) return;
  const tiles = state.map.tiles;
  for (const key of modern.lowWaterTiles) {
    const { r, c } = unpackTile(key);
    setWater(tiles, r, c);
  }
  // Destroy walls and structures that players built on the now-reflooded tiles
  for (const key of modern.lowWaterTiles) {
    removeWallFromAllPlayers(state, key);
  }
  state.grunts = state.grunts.filter(
    (gr) => !modern.lowWaterTiles!.has(packTile(gr.row, gr.col)),
  );
  state.burningPits = state.burningPits.filter(
    (pit) => !modern.lowWaterTiles!.has(packTile(pit.row, pit.col)),
  );
  // Remove cannons on reflooded tiles
  for (const player of state.players) {
    player.cannons = player.cannons.filter((cannon) => {
      const sz = cannonSize(cannon.mode);
      for (let dr = 0; dr < sz; dr++) {
        for (let dc = 0; dc < sz; dc++) {
          if (
            modern.lowWaterTiles!.has(
              packTile(cannon.row + dr, cannon.col + dc),
            )
          )
            return false;
        }
      }
      return true;
    });
  }
  modern.lowWaterTiles = null;
  state.map.mapVersion++;
}

/** Per-zone tile revert for low water (adjacent grass in zone → water). */
function resetLowWaterTilesForZone(state: GameState, zone: number): void {
  const lowWater = state.modern?.lowWaterTiles;
  if (!lowWater) return;
  for (const key of lowWater) {
    const { r, c } = unpackTile(key);
    const adjacentToZone = DIRS_4.some(([dr, dc]) => {
      const nr = r + dr;
      const nc = c + dc;
      return state.map.zones[nr]?.[nc] === zone;
    });
    if (adjacentToZone) {
      setWater(state.map.tiles, r, c);
      lowWater.delete(key);
    }
  }
  if (lowWater.size === 0) state.modern!.lowWaterTiles = null;
  state.map.mapVersion++;
}
