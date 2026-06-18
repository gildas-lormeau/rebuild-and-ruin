/**
 * Publishes gap-centroid anchors for near-complete unenclosed-tower rings
 * (≤MANAGEABLE_GAP_LIMIT gaps) other than the active target whose remaining
 * gaps some piece in the round's pool could fill. `cursor-anticipation` in
 * ai-build-score.ts biases placement toward these anchors via Manhattan
 * distance. Uses `piecesInRoundPool` (info a human can derive from the round
 * counter), not bag.queue shuffle order — no info asymmetry.
 */

import { type PlacementContext } from "../game/index.ts";
import type { TileRect, Tower } from "../shared/core/geometry-types.ts";
import { type TileKey } from "../shared/core/grid.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import { unpackTile } from "../shared/core/spatial.ts";
import type { BuildViewState } from "../shared/core/system-interfaces.ts";
import { type OccupancyCache } from "../shared/sim/board-occupancy.ts";
import { piecesInRoundPool } from "../shared/sim/pieces.ts";
import { getInterior } from "../shared/sim/player-interior.ts";
import { poolFillableTowerRing } from "./ai-build-target.ts";
import type { PeekFitTarget } from "./ai-build-types.ts";

/** Compute peek-fit anchors for the cursor-anticipation rule. Returns the
 *  empty array when no near-complete alternate ring exists or none of the
 *  round's pool pieces can fill any. Uses `piecesInRoundPool` (deterministic
 *  from public state) instead of `bag.queue`, so the AI and a human player
 *  consume the same info. */
export function computePeekFitTargets(
  state: BuildViewState,
  playerId: ValidPlayerId,
  player: Player,
  unenclosedTowers: readonly Tower[],
  activeTargetRect: TileRect | null,
  castleMargin: number,
  bankHugging: boolean,
  cache: OccupancyCache,
  placementCtx: PlacementContext,
): readonly PeekFitTarget[] {
  const bag = player.bag;
  if (!bag) return [];
  const poolPieces = piecesInRoundPool(bag.round, bag.smallPieces);
  if (poolPieces.length === 0) return [];
  const interior = getInterior(player);
  const targets: PeekFitTarget[] = [];
  for (const tower of unenclosedTowers) {
    if (towerOverlapsRect(tower, activeTargetRect)) continue;
    const ring = poolFillableTowerRing(
      tower,
      state,
      player,
      interior,
      castleMargin,
      bankHugging,
      poolPieces,
      playerId,
      cache,
      placementCtx,
    );
    if (!ring) continue;
    const anchor = gapCentroid(ring.gaps);
    targets.push({
      anchorRow: anchor.row,
      anchorCol: anchor.col,
      gapsCount: ring.gaps.size,
    });
  }
  return targets;
}

function towerOverlapsRect(tower: Tower, rect: TileRect | null): boolean {
  if (!rect) return false;
  const lastRow = tower.row + 1;
  const lastCol = tower.col + 1;
  return (
    tower.row <= rect.bottom &&
    lastRow >= rect.top &&
    tower.col <= rect.right &&
    lastCol >= rect.left
  );
}

function gapCentroid(gaps: ReadonlySet<TileKey>): {
  row: number;
  col: number;
} {
  let sumRow = 0;
  let sumCol = 0;
  let count = 0;
  for (const key of gaps) {
    const { row, col } = unpackTile(key);
    sumRow += row;
    sumCol += col;
    count++;
  }
  // Callers only reach here with a non-empty ring (poolFillableTowerRing
  // returns null on zero gaps, guarded at the call site). Guard the divide
  // anyway so a future caller passing an empty set can't NaN-poison the anchor.
  if (count === 0) return { row: 0, col: 0 };
  return { row: sumRow / count, col: sumCol / count };
}
