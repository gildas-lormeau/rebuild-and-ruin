/**
 * Frostbite modifier — grunts spawn as immobile ice cubes that take two
 * hits to break (first chips, tracked in `chippedGrunts`; second kills).
 * Lasts one battle. `chippedGrunts` is mirrored into checkpoints so host
 * migrations mid-battle keep host/watcher in sync.
 */

import { packTile } from "../../shared/core/spatial.ts";
import type { GameState } from "../../shared/core/types.ts";
import type { ModifierImpl, ModifierTileData } from "./modifier-types.ts";

export const frostbiteImpl: ModifierImpl = {
  lifecycle: "round-scoped",
  apply: (state: GameState) => {
    if (state.modern) state.modern.chippedGrunts = new Set();
    // Pulse the existing grunt tiles — those are the units about to freeze
    // into immobile ice cubes for the battle.
    const changedTiles = state.grunts.map((grunt) =>
      packTile(grunt.row, grunt.col),
    );
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
