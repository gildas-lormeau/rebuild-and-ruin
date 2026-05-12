import type { ModifierImpl } from "../../shared/core/types.ts";

export const fogOfWarImpl: ModifierImpl = {
  lifecycle: "instant",
  apply: () => ({ changedTiles: [] as number[], gruntsSpawned: 0 }),
  // Overlay-only effect — never touches walls or tile passability.
  skipsRecheck: true,
};
