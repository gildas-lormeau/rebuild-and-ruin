/**
 * Frostbite modifier — grunts spawn as immobile ice cubes that take two hits
 * to break. The first hit chips the ice (tracked in `chippedGrunts`); the
 * second kills normally. Lasts one battle.
 *
 * No tile mutation — `chippedGrunts` is the only state, mirrored into
 * checkpoints so host migrations mid-battle keep host/watcher in sync on
 * which grunts have already absorbed their first hit.
 */

import { isPlayerSeated } from "../../shared/core/player-types.ts";
import { forEachTowerTile } from "../../shared/core/spatial.ts";
import type { GameState } from "../../shared/core/types.ts";
import type { ModifierImpl, ModifierTileData } from "./modifier-types.ts";

export const frostbiteImpl: ModifierImpl = {
  lifecycle: "round-scoped",
  apply: (state: GameState) => {
    if (state.modern) state.modern.chippedGrunts = new Set();
    // Pulse alive owned-tower tiles — those are the spawn origins for the
    // icy grunts that will appear at battle start.
    const changedTiles: number[] = [];
    for (const player of state.players) {
      if (!isPlayerSeated(player)) continue;
      for (const tower of player.ownedTowers) {
        if (!state.towerAlive[tower.index]) continue;
        forEachTowerTile(tower, (_r, _c, key) => changedTiles.push(key));
      }
    }
    return { changedTiles, gruntsSpawned: 0 };
  },
  // No walls touched, no tile passability change — pure entity-level effect.
  skipsRecheck: true,
  clear: (state: GameState) => {
    if (state.modern) state.modern.chippedGrunts = null;
  },
  restore: (state: GameState, data: ModifierTileData) => {
    if (!("chippedGrunts" in data)) return;
    if (state.modern) {
      state.modern.chippedGrunts = data.chippedGrunts
        ? new Set(data.chippedGrunts)
        : null;
    }
  },
};
