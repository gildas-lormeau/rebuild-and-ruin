/**
 * Sapper modifier — grunts attack any adjacent wall on sight.
 *
 * No `apply`-time work: the behavior lives in `grunt-system.ts`, which checks
 * `state.modern?.activeModifier === MODIFIER_ID.SAPPER` to skip the
 * blocked-rounds + random-roll triggers and re-flags grunts every tick.
 * Reinforced Walls absorption + Rampart shielding still apply as normal.
 */

import { isPlayerSeated } from "../../shared/core/player-types.ts";
import type { GameState } from "../../shared/core/types.ts";
import type { ModifierImpl } from "./modifier-types.ts";

export const sapperImpl: ModifierImpl = {
  lifecycle: "instant",
  apply: (state: GameState) => {
    // Pulse all wall tiles for seated players — those are the targets the
    // sapper grunts will attack on sight.
    const changedTiles: number[] = [];
    for (const player of state.players) {
      if (!isPlayerSeated(player)) continue;
      for (const key of player.walls) changedTiles.push(key);
    }
    return { changedTiles, gruntsSpawned: 0 };
  },
  skipsRecheck: true,
};
