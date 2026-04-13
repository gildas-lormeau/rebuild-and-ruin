/**
 * Low Water modifier — converts shallow river-edge tiles to grass per zone.
 * Only selects water tiles with at least one orthogonal grass neighbor
 * and at least two orthogonal water neighbors (won't pinch the river).
 */

import { removeWallFromAllPlayers } from "../../shared/core/board-occupancy.ts";
import { FID } from "../../shared/core/feature-defs.ts";
import { GRID_COLS, GRID_ROWS } from "../../shared/core/grid.ts";
import { isPlayerSeated } from "../../shared/core/player-types.ts";
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

/** Low water: number of bank tiles converted per active zone. */
const LOW_WATER_TILES_PER_ZONE = 5;
export const lowWaterImpl: ModifierImpl = {
  apply: (state: GameState) => ({
    changedTiles: [...applyLowWater(state)],
    gruntsSpawned: 0,
  }),
  needsRecheck: true,
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

/** Apply low water: convert a few shallow river-edge tiles to grass per zone. */
function applyLowWater(state: GameState): ReadonlySet<number> {
  const modern = state.modern;
  if (!modern) return new Set();
  const tiles = state.map.tiles;
  const activeZones = state.players
    .filter(isPlayerSeated)
    .map((player) => player.homeTower.zone);
  const converted = new Set<number>();

  for (const zone of activeZones) {
    // Collect candidate bank tiles in this zone
    const candidates: number[] = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        if (!isWater(tiles, r, c)) continue;
        // Must border at least one grass tile (it's a bank)
        let grassNeighbors = 0;
        let waterNeighbors = 0;
        for (const [dr, dc] of DIRS_4) {
          const nr = r + dr;
          const nc = c + dc;
          if (isGrass(tiles, nr, nc)) grassNeighbors++;
          if (isWater(tiles, nr, nc)) waterNeighbors++;
        }
        if (grassNeighbors === 0) continue;
        // Must keep at least 2 water neighbors so removal doesn't pinch the river
        if (waterNeighbors < 2) continue;
        // Assign to the zone of the adjacent grass neighbor
        let matchesZone = false;
        for (const [dr, dc] of DIRS_4) {
          const nr = r + dr;
          const nc = c + dc;
          if (isGrass(tiles, nr, nc) && state.map.zones[nr]?.[nc] === zone) {
            matchesZone = true;
            break;
          }
        }
        if (!matchesZone) continue;
        candidates.push(packTile(r, c));
      }
    }
    if (candidates.length === 0) continue;
    state.rng.shuffle(candidates);
    const count = Math.min(LOW_WATER_TILES_PER_ZONE, candidates.length);
    for (let i = 0; i < count; i++) {
      converted.add(candidates[i]!);
    }
  }
  if (converted.size === 0) return converted;
  // Convert to grass
  for (const key of converted) {
    const { r, c } = unpackTile(key);
    setGrass(tiles, r, c);
  }
  modern.lowWaterTiles = converted;
  state.map.mapVersion++;
  return converted;
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
