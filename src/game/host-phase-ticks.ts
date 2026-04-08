/**
 * Pure game-domain helpers for cannon and build phase finalization.
 *
 * Consumed by runtime-phase-ticks.ts. All functions are network-agnostic.
 */

import { snapshotAllWalls } from "../shared/board-occupancy.ts";
import { FID } from "../shared/feature-defs.ts";
import { MASTER_BUILDER_BONUS_SECONDS } from "../shared/game-constants.ts";
import type { EntityOverlay } from "../shared/overlay-types.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import { unpackTile } from "../shared/spatial.ts";
import type { PlayerController } from "../shared/system-interfaces.ts";
import { type GameState, hasFeature } from "../shared/types.ts";
import { snapshotEntities } from "./phase-banner.ts";

/** Finalize cannon controllers at end of cannon placement phase.
 *
 *  LOAD-BEARING SPLIT (do not merge local/remote):
 *    Remote humans: call initCannons() only (their cannons were flushed client-side).
 *    Local controllers: call finalizeCannonPhase() which flushes then inits.
 *    Using the wrong method corrupts cannon state — finalizeCannonPhase on a remote
 *    double-flushes; initCannons on a local skips the flush entirely.
 *
 *  CONTRAST with build finalization: build skips remote humans entirely because bag
 *  state is re-initialized via startBuildPhase. Cannon has no equivalent re-init step.
 *
 *  NOTE: Intentionally includes eliminated players — they need cannon state
 *  cleanup (flush + round-1 init) for potential castle reselection. */
export function finalizeCannonControllers(
  state: GameState,
  localControllers: readonly PlayerController[],
  remoteControllers: readonly PlayerController[],
): void {
  for (const ctrl of remoteControllers) {
    const max = state.cannonLimits[ctrl.playerId] ?? 0;
    ctrl.initCannons(state, max);
  }
  for (const ctrl of localControllers) {
    const max = state.cannonLimits[ctrl.playerId] ?? 0;
    ctrl.finalizeCannonPhase(state, max);
  }
}

/** Snapshot all walls THEN finalize the build phase. Enforces the invariant
 *  that the snapshot is captured before sweepAllPlayersWalls deletes isolated walls.
 *
 *  INVARIANT: Snapshot MUST precede finalizeBuildPhase(). Wall sweeping deletes
 *  isolated walls during finalization — snapshotting after would show post-sweep state
 *  in the banner, hiding destroyed walls from the player.
 *
 *  Zone-dependent entities (grunts, houses, pits, bonuses) are re-snapshotted
 *  AFTER finalize so that resetZoneState changes are reflected. Without this,
 *  the banner old-scene would flash stale grunts that were already removed
 *  before the life-lost dialog appeared. */
export function snapshotThenFinalize(
  state: GameState,
  finalizeBuildPhase: (state: GameState) => {
    needsReselect: ValidPlayerSlot[];
    eliminated: ValidPlayerSlot[];
  },
): {
  wallsBeforeSweep: Set<number>[];
  prevEntities: EntityOverlay;
  needsReselect: ValidPlayerSlot[];
  eliminated: ValidPlayerSlot[];
} {
  const wallsBeforeSweep = snapshotAllWalls(state);
  const prevEntities = snapshotEntities(state);
  const { needsReselect, eliminated } = finalizeBuildPhase(state);

  // Re-snapshot zone-dependent entities after finalize — resetZoneState
  // removes grunts/houses/pits/bonuses from eliminated/reselect zones,
  // and the player already sees them gone during the life-lost dialog.
  // towerAlive is also re-snapshotted: resetZoneState revives all zone
  // towers, and during CASTLE_RESELECT no banner plays to reveal the
  // change — so the snapshot must match the post-reset state.
  // Walls keep their pre-finalize snapshot (wall sweep is banner-visualized).
  if (needsReselect.length > 0 || eliminated.length > 0) {
    prevEntities.grunts = state.grunts.map((grunt) => ({ ...grunt }));
    prevEntities.houses = state.map.houses.map((house) => ({ ...house }));
    prevEntities.burningPits = state.burningPits.map((pit) => ({ ...pit }));
    prevEntities.bonusSquares = state.bonusSquares.map((bonus) => ({
      ...bonus,
    }));
    prevEntities.towerAlive = [...state.towerAlive];
  }

  return { wallsBeforeSweep, prevEntities, needsReselect, eliminated };
}

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
