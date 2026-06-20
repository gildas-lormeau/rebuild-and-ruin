/**
 * Mortar upgrade — at battle start, one normal cannon per Mortar-owning
 * player is elected to fire slow splash shots that leave a burning pit.
 * Speed flows via the ballSpeedMult dispatcher (intentionally cancels
 * with Rapid Fire). Hooks: mortarSpeedMult (direct export) +
 * onBattlePhaseStart (election); election helpers are injected by
 * cannon-system to avoid an L5 → L6 import cycle.
 */

import {
  BOARD_LOCAL_SITE,
  deriveBoardLocalSeed,
} from "../../shared/core/ai-seed.ts";
import { type Cannon, CannonMode } from "../../shared/core/battle-types.ts";
import { isPlayerEliminated } from "../../shared/core/player-slot.ts";
import type {
  BattleStartCannonDeps,
  GameState,
  UpgradeImpl,
} from "../../shared/core/types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";
import { Rng } from "../../shared/platform/rng.ts";

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
    // R5b: one election per Mortar-owning player with eligible cannons — count
    // is board-dependent. Pick on a private Rng keyed by player so the shared
    // cursor advance is fixed.
    const elected = new Rng(
      deriveBoardLocalSeed(
        state.rng.seed,
        state.round,
        BOARD_LOCAL_SITE.MORTAR_ELECTION,
        player.id,
      ),
    ).pick(normalCannons);
    elected.mortar = true;
  }
}
