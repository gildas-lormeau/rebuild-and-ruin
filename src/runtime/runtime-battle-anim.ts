/** Translate per-frame battle combat results into battleAnim render entries.
 *
 *  The engine tick (`tickBattlePhase` / `resolveBattleCombatStep`) returns a
 *  `BattleCombatResult` describing what happened in sim-space: impact tiles
 *  and emitted impact events. The render layer needs the same data with an
 *  `age` field for fade-out animation. Both host and watcher run the engine
 *  tick locally and must populate `battleAnim` identically — this helper is
 *  the shared translation step so neither side drifts.
 *
 *  Replaces the former bus-subscription path that pushed visuals from
 *  `BATTLE_MESSAGE.*` events: runtime control flow (battle-end gate) reads
 *  `battleAnim.*.length`, so the bus must not be the source of truth (see
 *  feedback_bus_observation_only). All visuals are now derived from the
 *  same engine return value the bus events were synthesised from. */

import type { BattleCombatResult } from "../game/index.ts";
import { BATTLE_MESSAGE } from "../shared/core/battle-events.ts";
import type { BattleAnimState } from "../shared/core/battle-types.ts";
import { cannonSize } from "../shared/core/spatial.ts";
import type { GameState } from "../shared/core/types.ts";

/** Push impact-position + ice-thaw + destruction-burst entries from a
 *  combat result into the render-anim buffers. All entries push with
 *  `age: 0` so the renderer fades them in from frame 0. `state` is read
 *  for the `cannonDamaged → cannonDestroys` lookup (event carries
 *  playerId/cannonIdx; the visual needs row/col/size). */
export function recordBattleVisualEvents(
  result: Pick<BattleCombatResult, "newImpacts" | "impactEvents">,
  battleAnim: BattleAnimState,
  state: Pick<GameState, "players">,
): void {
  for (const imp of result.newImpacts) {
    battleAnim.impacts.push({ ...imp, age: 0 });
  }
  for (const evt of result.impactEvents) {
    switch (evt.type) {
      case BATTLE_MESSAGE.ICE_THAWED:
        battleAnim.thawing.push({ row: evt.row, col: evt.col, age: 0 });
        break;
      case BATTLE_MESSAGE.WALL_DESTROYED:
        battleAnim.wallBurns.push({ row: evt.row, col: evt.col, age: 0 });
        break;
      case BATTLE_MESSAGE.GRUNT_KILLED:
        battleAnim.gruntKills.push({ row: evt.row, col: evt.col, age: 0 });
        break;
      case BATTLE_MESSAGE.HOUSE_DESTROYED:
        battleAnim.houseDestroys.push({ row: evt.row, col: evt.col, age: 0 });
        break;
      case BATTLE_MESSAGE.CANNON_DAMAGED: {
        if (evt.newHp > 0) break;
        const cannon = state.players[evt.playerId]?.cannons[evt.cannonIdx];
        if (!cannon) break;
        battleAnim.cannonDestroys.push({
          row: cannon.row,
          col: cannon.col,
          size: cannonSize(cannon.mode),
          age: 0,
        });
        break;
      }
      // Other ImpactEvent variants (wallAbsorbed, wallShielded, gruntChipped,
      // gruntSpawned, pitCreated) have no visual-burst representation here —
      // their rendering is driven by the underlying state changes (chipped
      // grunts, shielded walls, burning pits) instead.
    }
  }
}
