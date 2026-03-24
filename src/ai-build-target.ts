/**
 * AI build target selection — determines which tower ring to repair or expand.
 *
 * Called by the build placement orchestrator (ai-strategy-build.ts).
 * The main selectBuildTarget function is in ai-strategy-build.ts (nested logic).
 * These are the helper functions it depends on.
 */

import { filterUnfillableGaps } from "./ai-castle-rect.ts";
import type { TileRect } from "./geometry-types.ts";
import { canPlacePiece } from "./phase-build.ts";
import type { PieceShape } from "./pieces.ts";
import { ALL_PIECE_SHAPES, rotateCW } from "./pieces.ts";
import {
  DIRS_8,
  isGrass,
  packTile,
  unpackTile,
} from "./spatial.ts";
import type { GameState } from "./types.ts";

export function canPieceFillAnyGap(
  state: GameState,
  playerId: number,
  piece: PieceShape,
  interior: Set<number>,
  gaps: Set<number>,
  rect?: TileRect | null,
): boolean {
  // Interior excluding these gaps — gap tiles are ring holes, not forbidden interior.
  // Also exclude the castle rect interior: the enclosure has gaps so it's NOT closed,
  // and the AI should be free to extend pieces into it while filling those gaps.
  const adjusted = new Set(interior);
  for (const gk of gaps) adjusted.delete(gk);
  if (rect) {
    for (let r = rect.top; r <= rect.bottom; r++) {
      for (let c = rect.left; c <= rect.right; c++) {
        adjusted.delete(packTile(r, c));
      }
    }
  }
  let rot = piece;
  for (let ri = 0; ri < 4; ri++) {
    for (const gk of gaps) {
      const { r: gr, c: gc } = unpackTile(gk);
      for (const [dr, dc] of rot.offsets) {
        if (canPlacePiece(state, playerId, rot, gr - dr, gc - dc, adjusted)) return true;
      }
    }
    rot = rotateCW(rot);
  }
  return false;
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
  state: GameState,
  playerId: number,
  player: { walls: Set<number>; interior: Set<number> },
): boolean {
  if (!rect || gaps.size === 0) return false;
  const unreachable: number[] = [];
  for (const gk of gaps) {
    if (!isGapFillableByAnyShape(state, playerId, player.interior, gk, rect)) {
      unreachable.push(gk);
    }
  }
  if (unreachable.length === 0) return false;
  for (const gk of unreachable) gaps.delete(gk);
  // Add interior-facing grass neighbors as plug gaps (same diagonal-leak seal as water/pits)
  for (const gk of unreachable) {
    const { r: gr, c: gc } = unpackTile(gk);
    for (const [dr, dc] of DIRS_8) {
      const nr = gr + dr, nc = gc + dc;
      if (nr < rect.top || nr > rect.bottom || nc < rect.left || nc > rect.right) continue;
      const nk = packTile(nr, nc);
      if (player.walls.has(nk)) continue;
      if (!isGrass(state.map.tiles, nr, nc)) continue;
      gaps.add(nk);
    }
  }
  filterUnfillableGaps(gaps, state, player.interior);
  return true;
}

/** Check if ANY standard piece shape (in any rotation) could fill a single gap tile. */
function isGapFillableByAnyShape(
  state: GameState,
  playerId: number,
  interior: Set<number>,
  gapKey: number,
  rect?: TileRect | null,
): boolean {
  const { r: gr, c: gc } = unpackTile(gapKey);
  const adjusted = new Set(interior);
  adjusted.delete(gapKey);
  if (rect) {
    for (let r = rect.top; r <= rect.bottom; r++) {
      for (let c = rect.left; c <= rect.right; c++) {
        adjusted.delete(packTile(r, c));
      }
    }
  }
  for (const shape of ALL_PIECE_SHAPES) {
    let rot = shape;
    for (let ri = 0; ri < 4; ri++) {
      for (const [dr, dc] of rot.offsets) {
        if (canPlacePiece(state, playerId, rot, gr - dr, gc - dc, adjusted)) return true;
      }
      rot = rotateCW(rot);
    }
  }
  return false;
}
