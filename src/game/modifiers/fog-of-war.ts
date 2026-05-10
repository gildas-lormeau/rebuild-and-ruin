/**
 * Fog of War modifier — visual-only fog over every merged castle during
 * battle. No tile/entity mutation; the fog effect is rendered by
 * `createFogManager` in `src/render/3d/effects/fog.ts`. This impl declares
 * a no-op apply so the registry can dispatch hooks uniformly.
 */

import type { ModifierImpl } from "./modifier-types.ts";

export const fogOfWarImpl: ModifierImpl = {
  lifecycle: "instant",
  apply: () => ({ changedTiles: [] as number[], gruntsSpawned: 0 }),
  // Overlay-only effect — never touches walls or tile passability.
  skipsRecheck: true,
};
