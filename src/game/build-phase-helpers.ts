/**
 * Pure game-domain helpers for cannon and build phase finalization.
 *
 * Consumed by runtime-phase-ticks.ts. All functions are network-agnostic.
 */

import { FID } from "../shared/feature-defs.ts";
import { MASTER_BUILDER_BONUS_SECONDS } from "../shared/game-constants.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import { unpackTile } from "../shared/spatial.ts";
import { type GameState, hasFeature } from "../shared/types.ts";

/** Detect walls added by a controller tick and return them as offset pairs.
 *  Used by the runtime to broadcast AI wall placements to network peers. */
export function diffNewWalls(
  state: GameState,
  playerId: ValidPlayerSlot,
  wallSnapshot: ReadonlySet<number>,
): [number, number][] {
  const player = state.players[playerId]!;
  if (player.walls.size <= wallSnapshot.size) return [];
  const offsets: [number, number][] = [];
  for (const key of player.walls) {
    if (!wallSnapshot.has(key)) {
      const { r, c } = unpackTile(key);
      offsets.push([r, c]);
    }
  }
  return offsets;
}

/** Decrement the Master Builder lockout timer. No-op in classic mode. */
export function tickMasterBuilderLockout(state: GameState, dt: number): void {
  if (!hasFeature(state, FID.UPGRADES)) return;
  const modern = state.modern;
  if (modern && modern.masterBuilderLockout > 0) {
    modern.masterBuilderLockout = Math.max(0, modern.masterBuilderLockout - dt);
  }
}

/** Compute the effective build timer max (includes Master Builder bonus). */
export function buildTimerMax(state: GameState): number {
  const hasMB = (state.modern?.masterBuilderOwners?.size ?? 0) > 0;
  return state.buildTimer + (hasMB ? MASTER_BUILDER_BONUS_SECONDS : 0);
}
