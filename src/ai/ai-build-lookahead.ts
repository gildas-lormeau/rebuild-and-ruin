/**
 * Publishes gap-centroid anchors for near-complete unenclosed-tower rings
 * (≤MANAGEABLE_GAP_LIMIT gaps) other than the active target whose remaining
 * gaps some piece in the round's pool could fill. `cursor-anticipation` in
 * ai-build-score.ts biases placement toward these anchors via Manhattan
 * distance. Uses `piecesInRoundPool` (info a human can derive from the round
 * counter), not bag.queue shuffle order — no info asymmetry.
 */

import { type PlacementContext } from "../game/index.ts";
import { type OccupancyCache } from "../shared/core/board-occupancy.ts";
import type { TileRect, Tower } from "../shared/core/geometry-types.ts";
import { type TileKey } from "../shared/core/grid.ts";
import { piecesInRoundPool } from "../shared/core/pieces.ts";
import { getInterior } from "../shared/core/player-interior.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import { unpackTile } from "../shared/core/spatial.ts";
import type { BuildViewState } from "../shared/core/system-interfaces.ts";
import {
  adjustInterior,
  canAnyRotationFillGap,
  MANAGEABLE_GAP_LIMIT,
} from "./ai-build-target.ts";
import type { PeekFitTarget } from "./ai-build-types.ts";
import { castleRect, findReachableRingGaps } from "./ai-castle-rect.ts";

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
    const rect = castleRect(
      tower,
      state.map.tiles,
      state.map.towers,
      castleMargin,
      !bankHugging,
    );
    const gaps = findReachableRingGaps(rect, player.walls, state, interior);
    if (gaps.size === 0 || gaps.size > MANAGEABLE_GAP_LIMIT) continue;
    const adjusted = adjustInterior(interior, gaps, rect);
    if (
      !canAnyRotationFillGap(
        poolPieces,
        gaps,
        adjusted,
        state,
        playerId,
        cache,
        placementCtx,
      )
    ) {
      continue;
    }
    const anchor = gapCentroid(gaps);
    targets.push({
      anchorRow: anchor.row,
      anchorCol: anchor.col,
      gapsCount: gaps.size,
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
  return { row: sumRow / count, col: sumCol / count };
}
