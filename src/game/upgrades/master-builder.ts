/**
 * Master Builder upgrade — all hook implementations live in this file.
 *
 * Hooks implemented:
 *   - onBuildPhaseStart — configure masterBuilderOwners + masterBuilderLockout
 *   - tickBuildUpgrades — decrement the lockout timer each frame
 *   - canBuildThisFrame — locked-out players cannot build
 *   - buildTimerBonus   — +N seconds while any player owns MB
 *
 * Wired through src/game/upgrade-system.ts. Do NOT call these directly from
 * outside the dispatcher — call sites use the semantic dispatcher functions.
 */

import { FID } from "../../shared/feature-defs.ts";
import { MASTER_BUILDER_BONUS_SECONDS } from "../../shared/game-constants.ts";
import type { ValidPlayerSlot } from "../../shared/player-slot.ts";
import { isPlayerAlive } from "../../shared/player-types.ts";
import { type GameState, hasFeature } from "../../shared/types.ts";
import { UID } from "../../shared/upgrade-defs.ts";

/** Configure Master Builder state at the start of a build phase.
 *  - 1 owner  → that player gets an exclusive head-start; others are locked out
 *  - 2+ owners → everyone's timer gets the bonus (cancels out competitively), no lockout
 *  - 0 owners → no-op */
export function masterBuilderOnBuildStart(state: GameState): void {
  if (!hasFeature(state, FID.UPGRADES)) return;
  const mbPlayers = state.players.filter(
    (player) =>
      isPlayerAlive(player) && player.upgrades.get(UID.MASTER_BUILDER),
  );
  state.modern!.masterBuilderOwners =
    mbPlayers.length > 0 ? new Set(mbPlayers.map((player) => player.id)) : null;
  state.modern!.masterBuilderLockout =
    mbPlayers.length === 1 ? MASTER_BUILDER_BONUS_SECONDS : 0;
}

/** Decrement the Master Builder lockout timer each build frame.
 *  No-op outside upgrades mode or when the lockout has already elapsed. */
export function masterBuilderTick(state: GameState, dt: number): void {
  if (!hasFeature(state, FID.UPGRADES)) return;
  const modern = state.modern;
  if (modern && modern.masterBuilderLockout > 0) {
    modern.masterBuilderLockout = Math.max(0, modern.masterBuilderLockout - dt);
  }
}

/** Whether this player is allowed to build this frame under Master Builder.
 *  Returns true unless exactly one player owns MB, the lockout is still
 *  running, and this player is not the owner. */
export function masterBuilderAllowsBuild(
  state: GameState,
  playerId: ValidPlayerSlot,
): boolean {
  if (!hasFeature(state, FID.UPGRADES)) return true;
  const modern = state.modern;
  if (!modern || modern.masterBuilderLockout <= 0) return true;
  return (
    modern.masterBuilderOwners === null ||
    modern.masterBuilderOwners.has(playerId)
  );
}

/** Build timer bonus contributed by Master Builder.
 *  Returns +N seconds while any player owns MB, 0 otherwise. */
export function masterBuilderTimerBonus(state: GameState): number {
  return (state.modern?.masterBuilderOwners?.size ?? 0) > 0
    ? MASTER_BUILDER_BONUS_SECONDS
    : 0;
}
