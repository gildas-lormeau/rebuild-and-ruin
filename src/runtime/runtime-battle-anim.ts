/** Translate per-frame battle combat results into battleAnim render entries.
 *
 *  The engine tick (`tickBattlePhase` / `resolveBattleCombatStep`) returns a
 *  `BattleCombatResult` describing what happened in sim-space: impact tiles
 *  and emitted impact events. The render layer needs the same data with an
 *  `age` field for fade-out animation, plus a filtered subset for ice-thaw
 *  visuals. Both host and watcher run the engine tick locally and must
 *  populate `battleAnim` identically — this helper is the shared translation
 *  step so neither side drifts. */

import type { BattleCombatResult } from "../game/index.ts";
import { BATTLE_MESSAGE } from "../shared/core/battle-events.ts";
import type { Impact, ThawingTile } from "../shared/core/battle-types.ts";

/** Push impact-position + ice-thaw entries from a combat result into the
 *  render-anim buffers. Both push entries with `age: 0` so the renderer
 *  fades them in from frame 0. */
export function recordBattleVisualEvents(
  result: Pick<BattleCombatResult, "newImpacts" | "impactEvents">,
  battleAnim: { impacts: Impact[]; thawing: ThawingTile[] },
): void {
  for (const imp of result.newImpacts) {
    battleAnim.impacts.push({ ...imp, age: 0 });
  }
  for (const evt of result.impactEvents) {
    if (evt.type === BATTLE_MESSAGE.ICE_THAWED) {
      battleAnim.thawing.push({ row: evt.row, col: evt.col, age: 0 });
    }
  }
}
