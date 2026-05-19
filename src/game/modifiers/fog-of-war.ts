import type { TileKey } from "../../shared/core/grid.ts";
import type { ModifierImpl } from "../../shared/core/types.ts";

export const fogOfWarImpl: ModifierImpl = {
  lifecycle: "instant",
  apply: () => ({ changedTiles: [] as TileKey[], gruntsSpawned: 0 }),
  // Overlay-only effect — never touches walls or tile passability.
  skipsRecheck: true,
};
