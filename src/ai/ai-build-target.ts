/**
 * AI build target selection — determines which tower ring to repair or expand.
 *
 * Called by the build placement orchestrator (ai-strategy-build.ts).
 * The main selectBuildTarget function is in ai-strategy-build.ts (nested logic).
 * These are the helper functions it depends on.
 */

import { buildPlacementContext, canPlacePiece } from "../game/index.ts";
import { buildOccupancyCache } from "../shared/core/board-occupancy.ts";
import type { TileRect } from "../shared/core/geometry-types.ts";
import type { TileKey } from "../shared/core/grid.ts";
import {
  ALL_PIECE_SHAPES,
  type PieceShape,
  rotateCW,
} from "../shared/core/pieces.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { FreshInterior } from "../shared/core/player-types.ts";
import { packTile, unpackTile } from "../shared/core/spatial.ts";
import type { BuildViewState } from "../shared/core/system-interfaces.ts";
import { addInteriorPlugGaps, filterUnfillableGaps } from "./ai-castle-rect.ts";

export function canPieceFillAnyGap(
  state: BuildViewState,
  playerId: ValidPlayerId,
  piece: PieceShape,
  interior: ReadonlySet<TileKey>,
  gaps: Set<TileKey>,
  rect?: TileRect | null,
): boolean {
  const adjusted = adjustInterior(interior, gaps, rect);
  return canAnyRotationFillGap([piece], gaps, adjusted, state, playerId);
}

/**
 * When the current piece can't fill any gap, check if some gaps are
 * structurally unreachable by ANY piece shape.  For those, add interior plug
 * tiles (seal diagonal leaks from inside, same as water/pit plugs).
 * Returns true if the gap set was modified.
 */
export function plugUnreachableGaps(
  gaps: Set<TileKey>,
  rect: TileRect | null,
  state: BuildViewState,
  playerId: ValidPlayerId,
  walls: ReadonlySet<TileKey>,
  interior: FreshInterior,
): boolean {
  if (!rect || gaps.size === 0) return false;
  const unreachable: TileKey[] = [];
  for (const gapKey of gaps) {
    if (!isGapFillableByAnyShape(state, playerId, interior, gapKey, rect)) {
      unreachable.push(gapKey);
    }
  }
  if (unreachable.length === 0) return false;
  for (const gapKey of unreachable) gaps.delete(gapKey);
  // Seal diagonal-leak through interior-facing grass (same shape as water/pit plug)
  addInteriorPlugGaps(gaps, unreachable, rect, walls, state.map.tiles);
  filterUnfillableGaps(gaps, state, interior);
  return true;
}

/** Check if ANY standard piece shape (in any rotation) could fill a single gap tile. */
function isGapFillableByAnyShape(
  state: BuildViewState,
  playerId: ValidPlayerId,
  interior: ReadonlySet<TileKey>,
  gapKey: TileKey,
  rect?: TileRect | null,
): boolean {
  const singleGap = new Set<TileKey>([gapKey]);
  const adjusted = adjustInterior(interior, singleGap, rect);
  return canAnyRotationFillGap(
    ALL_PIECE_SHAPES,
    singleGap,
    adjusted,
    state,
    playerId,
  );
}

/**
 * Build an adjusted interior set by removing gap tiles and castle-rect interior.
 * Gap tiles are ring holes, not forbidden interior; the rect interior is open
 * so the AI is free to extend pieces into it while filling gaps.
 */
function adjustInterior(
  interior: ReadonlySet<TileKey>,
  gaps: Set<TileKey>,
  rect?: TileRect | null,
): Set<TileKey> {
  const adjusted = new Set(interior);
  for (const gapKey of gaps) adjusted.delete(gapKey);
  if (rect) {
    for (let r = rect.top; r <= rect.bottom; r++) {
      for (let c = rect.left; c <= rect.right; c++) {
        adjusted.delete(packTile(r, c));
      }
    }
  }
  return adjusted;
}

/** Try all rotations of each piece against each gap anchor; return true on first fit. */
function canAnyRotationFillGap(
  pieces: readonly PieceShape[],
  gaps: Set<TileKey>,
  adjusted: ReadonlySet<TileKey>,
  state: BuildViewState,
  playerId: ValidPlayerId,
): boolean {
  const cache = buildOccupancyCache(state);
  const placementCtx = buildPlacementContext(state, playerId);
  if (!placementCtx) return false;
  for (const shape of pieces) {
    let rot = shape;
    for (let rotIdx = 0; rotIdx < 4; rotIdx++) {
      for (const gapKey of gaps) {
        const { r: gr, c: gc } = unpackTile(gapKey);
        for (const [dr, dc] of rot.offsets) {
          if (
            canPlacePiece(
              state,
              playerId,
              rot.offsets,
              gr - dr,
              gc - dc,
              adjusted,
              cache,
              placementCtx,
            )
          )
            return true;
        }
      }
      rot = rotateCW(rot);
    }
  }
  return false;
}
