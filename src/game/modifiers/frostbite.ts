/**
 * Frostbite modifier — grunts spawn as immobile ice cubes that take two hits
 * to break. The first hit chips the ice (tracked in `chippedGrunts`); the
 * second kills normally. Lasts one battle.
 *
 * No tile mutation — `chippedGrunts` is the only state, mirrored into
 * checkpoints so host migrations mid-battle keep host/watcher in sync on
 * which grunts have already absorbed their first hit.
 */

import type { GameState } from "../../shared/core/types.ts";
import type { ModifierImpl, ModifierTileData } from "./modifier-types.ts";

export const frostbiteImpl: ModifierImpl = {
  lifecycle: "round-scoped",
  apply: (state: GameState) => {
    if (state.modern) state.modern.chippedGrunts = new Set();
    return { changedTiles: [], gruntsSpawned: 0 };
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
