/**
 * Re-flood-fill `state.map.zones` after a tile-mutating modifier changes
 * the grass topology. Stability strategy: each zone's ID is anchored on
 * the towers it contains, so a tower's `.zone` (and the player→zone
 * mapping in `state.playerZones`) stays valid across recomputes. Brand
 * new regions with no tower anchor (e.g. a low-water grass island) get
 * fresh IDs above the existing range.
 *
 * Bumps `state.map.mapVersion` so caches keyed on it (terrain bitmap,
 * sinkhole clusters, runtime camera zone-bounds) invalidate.
 */

import { GRID_COLS, GRID_ROWS } from "../shared/core/grid.ts";
import type { GameState } from "../shared/core/types.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";
import { floodFillZones } from "./map-generation.ts";

export function recomputeMapZones(state: GameState): void {
  const { zones: rawZones } = floodFillZones(state.map.tiles);

  // Anchor each raw region back to the tower's prior zone ID so cached
  // `tower.zone` and `state.playerZones[pid]` stay valid.
  const remap = new Map<number, ZoneId>();
  let nextId = 0;
  for (const tower of state.map.towers) {
    const rawId = rawZones[tower.row]?.[tower.col] ?? 0;
    if (rawId === 0) continue;
    if (remap.has(rawId)) continue;
    remap.set(rawId, tower.zone);
    if (tower.zone > nextId) nextId = tower.zone;
  }

  // Any raw region with no tower anchor gets a fresh ID above the
  // existing range so it never collides with an anchored zone.
  for (let r = 0; r < GRID_ROWS; r++) {
    const row = rawZones[r]!;
    for (let c = 0; c < GRID_COLS; c++) {
      const rawId = row[c]!;
      if (rawId === 0 || remap.has(rawId)) continue;
      remap.set(rawId, ++nextId as ZoneId);
    }
  }

  // Write remapped IDs into the live zones array. `tower.zone` is the
  // canonical anchor — by construction `state.map.zones[tower.row][tower.col]
  // === tower.zone` after this loop, so towers, players, houses, and
  // bonus squares keep their cached `.zone` fields valid.
  //
  // Caveat: if a future modifier ever bisects a zone (two towers with
  // the same `tower.zone` end up in disconnected components), this
  // remap collapses both halves to the same id. No current modifier
  // can trigger this — sinkhole/high-tide/low-water all leave towers
  // and their tile-grass connectivity intact. Bisecting modifiers
  // would need a different identity strategy.
  const dest = state.map.zones;
  for (let r = 0; r < GRID_ROWS; r++) {
    const srcRow = rawZones[r]!;
    const dstRow = dest[r]!;
    for (let c = 0; c < GRID_COLS; c++) {
      const rawId = srcRow[c]!;
      dstRow[c] = rawId === 0 ? 0 : (remap.get(rawId) ?? 0);
    }
  }

  state.map.mapVersion++;
}
