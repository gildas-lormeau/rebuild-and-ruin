/**
 * Sapper modifier — grunts attack any adjacent wall on sight.
 *
 * No `apply`-time work: the behavior lives in `grunt-system.ts`, which checks
 * `state.modern?.activeModifier === MODIFIER_ID.SAPPER` to skip the
 * blocked-rounds + random-roll triggers and re-flags grunts every tick.
 * Reinforced Walls absorption + Rampart shielding still apply as normal.
 */

import type { GameState } from "../../shared/core/types.ts";
import type { ModifierImpl } from "./modifier-types.ts";

export const sapperImpl: ModifierImpl = {
  lifecycle: "instant",
  apply: (state: GameState) => {
    // Pulse only the walls grunts will actually attack — each grunt's
    // `targetedWall` (the adjacent wall closest to its target tower,
    // computed at end-of-build in `finalizeRoundCleanup`). Deduped via Set
    // since multiple grunts can target the same wall.
    const changedTiles = new Set<number>();
    for (const grunt of state.grunts) {
      if (grunt.targetedWall !== undefined)
        changedTiles.add(grunt.targetedWall);
    }
    return { changedTiles: [...changedTiles], gruntsSpawned: 0 };
  },
  skipsRecheck: true,
};
