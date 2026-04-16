/**
 * Fog of War modifier — thick fog covers every merged castle during battle.
 *
 * Visual-only: no tile mutation, no entity spawning, no wall changes.
 * Players must remember cannon/tower positions to aim effectively.
 * Fog is painted by drawFogOfWar in render-effects.ts; this impl just
 * declares the modifier with a no-op apply so the registry can dispatch
 * banner/clear/zoneReset hooks uniformly.
 */

import type { ModifierImpl } from "./modifier-types.ts";

export const fogOfWarImpl: ModifierImpl = {
  apply: () => ({ changedTiles: [] as number[], gruntsSpawned: 0 }),
  // Overlay-only effect — never touches walls or tile passability.
  skipsRecheck: true,
};
