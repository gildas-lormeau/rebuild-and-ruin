/**
 * Master Builder upgrade — all hook implementations: onBuildPhaseStart
 * (configure owners/lockout), tickBuild (decrement lockout), canPlayerBuild
 * (locked-out players can't build), buildTimerBonus (+N seconds while any
 * player owns MB). Do NOT call directly — go through the dispatcher.
 * `masterBuilderOwners`/`masterBuilderLockout` are SHARED with supply-ship
 * `extra_build_time` earners, unioned in by `enterWallBuildPhase`.
 */

import { FID } from "../../shared/core/feature-defs.ts";
import { BUILD_LOCKOUT_BONUS_SECONDS } from "../../shared/core/game-constants.ts";
import type { ValidPlayerId } from "../../shared/core/player-slot.ts";
import { isPlayerAlive } from "../../shared/core/player-types.ts";
import {
  type GameState,
  hasFeature,
  type UpgradeImpl,
} from "../../shared/core/types.ts";
import { UID } from "../../shared/core/upgrade-defs.ts";

export const masterBuilderImpl: UpgradeImpl = {
  onBuildPhaseStart,
  tickBuild,
  canPlayerBuild,
  buildTimerBonus,
};

/** Configure Master Builder state at the start of a build phase.
 *  - 1+ owners → owners get a 5s exclusive head-start; non-owners locked out
 *  - 0 owners → no-op */
function onBuildPhaseStart(state: GameState): void {
  if (!hasFeature(state, FID.UPGRADES)) return;
  const mbPlayers = state.players.filter(
    (player) =>
      isPlayerAlive(player) && player.upgrades.get(UID.MASTER_BUILDER),
  );
  state.modern!.masterBuilderOwners =
    mbPlayers.length > 0 ? new Set(mbPlayers.map((player) => player.id)) : null;
  state.modern!.masterBuilderLockout =
    mbPlayers.length > 0 ? BUILD_LOCKOUT_BONUS_SECONDS : 0;
}

/** Decrement the Master Builder lockout timer each build frame.
 *  No-op outside upgrades mode or when the lockout has already elapsed. */
function tickBuild(state: GameState, dt: number): void {
  if (!hasFeature(state, FID.UPGRADES)) return;
  const modern = state.modern;
  if (modern && modern.masterBuilderLockout > 0) {
    modern.masterBuilderLockout = Math.max(0, modern.masterBuilderLockout - dt);
  }
}

/** Whether this player is allowed to build this frame under Master Builder.
 *  Returns true unless exactly one player owns MB, the lockout is still
 *  running, and this player is not the owner. */
function canPlayerBuild(state: GameState, playerId: ValidPlayerId): boolean {
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
function buildTimerBonus(state: GameState): number {
  return (state.modern?.masterBuilderOwners?.size ?? 0) > 0
    ? BUILD_LOCKOUT_BONUS_SECONDS
    : 0;
}
