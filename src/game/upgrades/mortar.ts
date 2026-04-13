/**
 * Mortar upgrade — at battle start, one normal cannon per Mortar-owning
 * player is randomly elected to fire mortar shots (slow, splash, leaves
 * a burning pit). Speed is encoded via the ballSpeedMult dispatcher,
 * which intentionally cancels out with Rapid Fire.
 *
 * Hooks implemented:
 *   - mortarSpeedMult            (cannonball speed contribution — direct export)
 *   - onBattlePhaseStart         (battle-phase-start election — via registry)
 *
 * Wired through src/game/upgrade-system.ts. Election helpers (filter
 * active firing cannons, isCannonEnclosed) are injected by cannon-system
 * to avoid an L5 → L6 import cycle.
 */

import { type Cannon, CannonMode } from "../../shared/core/battle-types.ts";
import { isPlayerEliminated } from "../../shared/core/player-types.ts";
import type { GameState } from "../../shared/core/types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";
import type { BattleStartCannonDeps, UpgradeImpl } from "./upgrade-types.ts";

/** Mortar cannonball speed multiplier (half speed). */
const MORTAR_SPEED_MULT = 0.5;
export const mortarImpl: UpgradeImpl = { onBattlePhaseStart };

/** Speed multiplier applied to a cannonball fired in mortar mode.
 *  Exported directly — used by the ballSpeedMult dispatcher which has
 *  cross-upgrade interaction logic (Rapid Fire + Mortar cancel out). */
export function mortarSpeedMult(): number {
  return MORTAR_SPEED_MULT;
}

/** Elect one mortar cannon per player who owns the Mortar upgrade.
 *  Only NORMAL cannons inside enclosed territory are eligible — super
 *  guns and balloons are excluded. Players with no eligible cannons are
 *  silently skipped (the upgrade is wasted that round). Uses synced RNG
 *  so election is deterministic for online play. */
function onBattlePhaseStart(
  state: GameState,
  deps: BattleStartCannonDeps,
): void {
  for (const player of state.players) {
    if (isPlayerEliminated(player)) continue;
    if (!player.upgrades.get(UID.MORTAR)) continue;
    const normalCannons = deps
      .filterActiveFiringCannons(player)
      .filter(
        (cannon: Cannon) =>
          cannon.mode === CannonMode.NORMAL &&
          deps.isCannonEnclosed(cannon, player),
      );
    if (normalCannons.length === 0) continue;
    const elected = state.rng.pick(normalCannons);
    elected.mortar = true;
  }
}
