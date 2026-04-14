/**
 * Dry Lightning modifier — random scattered burning pits on grass tiles per active zone.
 * Reuses shared fire helpers (burn predicate + scar applicator).
 */

import { GRID_COLS, GRID_ROWS } from "../../shared/core/grid.ts";
import { packTile } from "../../shared/core/spatial.ts";
import type { GameState } from "../../shared/core/types.ts";
import { applyFireScar, buildCanBurnPredicate } from "./fire-helpers.ts";
import { getActiveZones } from "./modifier-eligibility.ts";
import type { ModifierImpl } from "./modifier-types.ts";

/** Dry lightning: random scattered strikes per active zone. */
const DRY_LIGHTNING_MIN = 3;
const DRY_LIGHTNING_MAX = 5;
export const dryLightningImpl: ModifierImpl = {
  apply: (state: GameState) => ({
    changedTiles: [...applyDryLightning(state)],
    gruntsSpawned: 0,
  }),
  needsRecheck: true,
};

/** Apply dry lightning: scatter random burning pits on grass tiles per active zone. */
function applyDryLightning(state: GameState): ReadonlySet<number> {
  const activeZones = getActiveZones(state);
  const allStrikes = new Set<number>();
  for (const zone of activeZones) {
    const canBurn = buildCanBurnPredicate(state, zone);
    const candidates: number[] = [];
    for (let row = 1; row < GRID_ROWS - 1; row++) {
      for (let col = 1; col < GRID_COLS - 1; col++) {
        if (canBurn(row, col)) candidates.push(packTile(row, col));
      }
    }
    if (candidates.length === 0) continue;
    const count = Math.min(
      state.rng.int(DRY_LIGHTNING_MIN, DRY_LIGHTNING_MAX),
      candidates.length,
    );
    state.rng.shuffle(candidates);
    for (let idx = 0; idx < count; idx++) allStrikes.add(candidates[idx]!);
  }
  if (allStrikes.size === 0) return allStrikes;
  applyFireScar(state, allStrikes);
  return allStrikes;
}
