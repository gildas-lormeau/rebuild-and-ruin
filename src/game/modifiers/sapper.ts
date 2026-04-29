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
  apply: (_state: GameState) => ({ changedTiles: [], gruntsSpawned: 0 }),
  skipsRecheck: true,
};
