/**
 * AI build target selection — determines which tower ring to repair or expand.
 *
 * Called by the build placement orchestrator (ai-strategy-build.ts).
 * The main selectBuildTarget function is in ai-strategy-build.ts (nested logic).
 * These are the helper functions it depends on.
 */

import { canPlacePiece } from "../game/index.ts";
import type { TileRect } from "../shared/geometry-types.ts";
import {
  ALL_PIECE_SHAPES,
  type PieceShape,
  rotateCW,
} from "../shared/pieces.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import type { FreshInterior } from "../shared/player-types.ts";
import { DIRS_8, isGrass, packTile, unpackTile } from "../shared/spatial.ts";
import type { BuildViewState } from "../shared/system-interfaces.ts";
import { filterUnfillableGaps } from "./ai-castle-rect.ts";

export function canPieceFillAnyGap(
  state: BuildViewState,
  playerId: ValidPlayerSlot,
  piece: PieceShape,
  interior: ReadonlySet<number>,
  gaps: Set<number>,
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
  gaps: Set<number>,
  rect: TileRect | null,
  state: BuildViewState,
  playerId: ValidPlayerSlot,
  walls: ReadonlySet<number>,
  interior: FreshInterior,
): boolean {
  if (!rect || gaps.size === 0) return false;
  const unreachable: number[] = [];
  for (const gapKey of gaps) {
    if (!isGapFillableByAnyShape(state, playerId, interior, gapKey, rect)) {
      unreachable.push(gapKey);
    }
  }
  if (unreachable.length === 0) return false;
  for (const gapKey of unreachable) gaps.delete(gapKey);
  // Add interior-facing grass neighbors as plug gaps (same diagonal-leak seal as water/pits)
  for (const gapKey of unreachable) {
    const { r: gr, c: gc } = unpackTile(gapKey);
    for (const [dr, dc] of DIRS_8) {
      const nr = gr + dr,
        nc = gc + dc;
      if (
        nr < rect.top ||
        nr > rect.bottom ||
        nc < rect.left ||
        nc > rect.right
      )
        continue;
      const neighborKey = packTile(nr, nc);
      if (walls.has(neighborKey)) continue;
      if (!isGrass(state.map.tiles, nr, nc)) continue;
      gaps.add(neighborKey);
    }
  }
  filterUnfillableGaps(gaps, state, interior);
  return true;
}

/** Check if ANY standard piece shape (in any rotation) could fill a single gap tile. */
function isGapFillableByAnyShape(
  state: BuildViewState,
  playerId: ValidPlayerSlot,
  interior: ReadonlySet<number>,
  gapKey: number,
  rect?: TileRect | null,
): boolean {
  const singleGap = new Set([gapKey]);
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
  interior: ReadonlySet<number>,
  gaps: Set<number>,
  rect?: TileRect | null,
): Set<number> {
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
  gaps: Set<number>,
  adjusted: ReadonlySet<number>,
  state: BuildViewState,
  playerId: ValidPlayerSlot,
): boolean {
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
