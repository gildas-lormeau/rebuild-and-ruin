/**
 * Fog of War modifier — visual-only fog over every merged castle during
 * battle. No tile/entity mutation; fog is painted by drawFogOfWar in
 * render-effects.ts and this impl declares a no-op apply so the registry
 * can dispatch banner/clear/zoneReset hooks uniformly.
 */

import type { ModifierImpl } from "./modifier-types.ts";

export const fogOfWarImpl: ModifierImpl = {
  lifecycle: "instant",
  apply: () => ({ changedTiles: [] as number[], gruntsSpawned: 0 }),
  // Overlay-only effect — never touches walls or tile passability.
  skipsRecheck: true,
};
