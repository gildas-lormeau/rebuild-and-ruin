/** Render-side helpers over RenderOverlay: derive owner maps and snapshot
 *  interior set references for cache invalidation. Kept in render/ because
 *  the consumers (terrain, terrain-tile-data) are render-only and the
 *  helpers don't belong in overlay-types.ts (which is pure types). */

import { Phase } from "../shared/core/game-phase.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { RenderOverlay } from "../shared/ui/overlay-types.ts";

/** Build a tile-key → owning player map from the overlay. Hides the
 *  build/battle source split: in battle the snapshot lives in
 *  `overlay.battle.battleTerritory[pid]`; out of battle the live owners
 *  come from each castle's `interior` set. Renderers iterate the result
 *  per-tile to color castle interiors and owned-sinkhole banks. Walls
 *  are NOT included — callers that need them build a separate set. */
export function interiorOwnersFromOverlay(
  overlay: RenderOverlay | undefined,
): Map<number, ValidPlayerId> {
  const owners = new Map<number, ValidPlayerId>();
  if (!overlay) return owners;
  if (overlay.phase === Phase.BATTLE) {
    const territories = overlay.battle?.battleTerritory;
    if (territories) {
      for (let pid = 0; pid < territories.length; pid++) {
        const territory = territories[pid];
        if (!territory) continue;
        const playerSlot = pid as ValidPlayerId;
        for (const key of territory) owners.set(key, playerSlot);
      }
    }
  } else if (overlay.castles) {
    for (const castle of overlay.castles) {
      for (const key of castle.interior) owners.set(key, castle.playerId);
    }
  }
  return owners;
}

/** Snapshot the per-player interior Set references that owner-derived
 *  rendering depends on. Battle reads `battleAnim.territory[pid]`,
 *  peacetime reads each castle's `interior`. Paired with `interiorRefsMatch`
 *  for an allocation-free steady-state cache hit on subsequent frames. */
export function snapshotInteriorRefs(
  overlay: RenderOverlay,
  inBattle: boolean,
): ReadonlyArray<ReadonlySet<number>> {
  if (inBattle) return overlay.battle?.battleTerritory?.slice() ?? [];
  return overlay.castles?.map((castle) => castle.interior) ?? [];
}

/** Element-wise reference-compare a cached `snapshotInteriorRefs` result
 *  against the live overlay refs. No allocation — fast steady-state path
 *  for cache invalidation in renderers that key on territory changes. */
export function interiorRefsMatch(
  cached: ReadonlyArray<ReadonlySet<number>>,
  overlay: RenderOverlay,
  inBattle: boolean,
): boolean {
  if (inBattle) {
    const territory = overlay.battle?.battleTerritory;
    if (!territory) return cached.length === 0;
    if (cached.length !== territory.length) return false;
    for (let i = 0; i < cached.length; i++) {
      if (cached[i] !== territory[i]) return false;
    }
    return true;
  }
  const castles = overlay.castles;
  if (!castles) return cached.length === 0;
  if (cached.length !== castles.length) return false;
  for (let i = 0; i < cached.length; i++) {
    if (cached[i] !== castles[i]!.interior) return false;
  }
  return true;
}
