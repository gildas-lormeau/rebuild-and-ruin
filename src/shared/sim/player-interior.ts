/**
 * Interior freshness — lazy epoch pairs (wallsEpoch, interiorEpoch).
 * Contract: `markWallsDirty` after wall mutation, `recomputeInterior` to
 * refresh, `assertInteriorFresh` before reading (no-op while epochs are
 * undefined — first-write lazy init). Battle keeps interior intentionally
 * stale while walls are destroyed frame-by-frame; rebuilt at the next
 * build via recheckTerritory.
 */

import type { TileKey } from "../core/grid.ts";
import {
  brandFreshInterior,
  type FreshInterior,
  type Player,
} from "../core/player-types.ts";

const wallsEpoch = new WeakMap<Player, number>();
const interiorEpoch = new WeakMap<Player, number>();

/** Return a player's interior after asserting it's fresh.
 *  Use this in build/cannon game logic — it guarantees the set reflects the
 *  current wall state. During battle, use `getBattleInterior()` instead
 *  (interior is intentionally stale while walls are being destroyed). */
export function getInterior(player: Player): FreshInterior {
  assertInteriorFresh(player);
  return player.interior;
}

/** Assert that a player's interior is not stale (walls haven't changed since
 *  the last recheckTerritory). Throws if stale — this is a programming error,
 *  not a runtime condition. No-op if epochs were never initialized (e.g. tests
 *  that don't call markWallsDirty). */
export function assertInteriorFresh(player: Player): void {
  const currentWallsEpoch = wallsEpoch.get(player);
  if (currentWallsEpoch === undefined) return; // epoch tracking not active for this player
  const currentInteriorEpoch = interiorEpoch.get(player) ?? -1;
  if (currentInteriorEpoch < currentWallsEpoch) {
    throw new Error(
      `Stale interior for player ${player.id}: walls epoch ${currentWallsEpoch} > interior epoch ${currentInteriorEpoch}. ` +
        `Call recheckTerritory() after wall mutations before reading interior.`,
    );
  }
}

/** Mark a player's wall set as modified. Call after any .add/.delete/.clear
 *  on player.walls. Omitting this call is safe (assertion may false-negative)
 *  but including it catches stale-interior bugs. */
export function markWallsDirty(player: Player): void {
  wallsEpoch.set(player, (wallsEpoch.get(player) ?? 0) + 1);
}

/** Mark a player's interior as freshly recomputed and brand the set.
 *  Called by recomputeInterior inside recheckTerritory — do NOT call from other code.
 *  When `fresh` is provided, assigns it as the new interior (handles branded-type cast). */
export function markInteriorFresh(
  player: Player,
  fresh?: Set<TileKey>,
): FreshInterior {
  if (fresh !== undefined) {
    player.interior = brandFreshInterior(fresh);
  }
  interiorEpoch.set(player, wallsEpoch.get(player) ?? 0);
  return player.interior;
}
