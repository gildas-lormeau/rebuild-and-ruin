/**
 * Bag-coverage / winnability solver shared between the standalone diagnostic
 * (`test/diag/winnability.ts`) and the AI build-survival runner
 * (`test/survival/runner.ts`).
 *
 * For a captured LATE_PLATEAU stall state — remaining ring gaps, focal walls,
 * blocked tiles, the focal player's grass set, and the upcoming piece queue
 * — decides whether ANY placement sequence (any rotation, any anchor; skipping
 * a piece models a wasteful placement that advances the bag) could close all
 * remaining gaps. Optimistic upper bound on winnability (skip doesn't add
 * wasteful-placement walls).
 *
 * Companion helpers `countIsolatedGaps` and `isNarrowPieceName` quantify the
 * mechanical-forcing signal: an isolated gap (all 4 cardinal neighbors are
 * walls/blockers/oob) can only be filled by a narrow piece (1x1, 1x2, 1x3,
 * Corner). When isolatedGapCount > narrowPieceCount, the bag mechanically
 * cannot close the rect — UNWINNABLE is forced by the bag-vs-geometry
 * mismatch, no matter what the AI does.
 */

import type { PieceShape } from "../src/shared/core/pieces.ts";
import { rotateCW } from "../src/shared/core/pieces.ts";
import { GRID_COLS, GRID_ROWS, type TileKey } from "../src/shared/core/grid.ts";
import { packTile, unpackTile } from "../src/shared/core/spatial.ts";

export interface SolverResult {
  result: boolean | "TIMEOUT";
  nodes: number;
}

const NARROW_PIECE_NAMES = new Set(["1x1", "1x2", "1x3", "Corner"]);
const CARDINAL_DIRS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];
/** Solver search-tree budget. LATE_PLATEAU stalls have small gap counts
 *  (median 1-5 by sub-mode classifier construction) so the branching is
 *  bounded — this cap is a safety net to keep one pathological stall from
 *  hanging the run. TIMEOUT in output signals the budget hit. */
export const SOLVER_NODE_BUDGET = 500_000;

export function countNarrowPieces(pieceNames: readonly string[]): number {
  let count = 0;
  for (const name of pieceNames) if (isNarrowPieceName(name)) count++;
  return count;
}

export function isNarrowPieceName(name: string): boolean {
  return NARROW_PIECE_NAMES.has(name);
}

/** Count gaps whose all 4 cardinal neighbors are walls/blockers/non-grass/oob.
 *  Such gaps can only be filled by a 1x1 piece (no larger piece can be placed
 *  there without overlapping a non-grass / blocked / walled cell). */
export function countIsolatedGaps(
  gaps: ReadonlySet<TileKey>,
  walls: ReadonlySet<TileKey>,
  blocked: ReadonlySet<TileKey>,
  grass: ReadonlySet<TileKey>,
): number {
  let count = 0;
  for (const gapKey of gaps) {
    if (isIsolatedGap(gapKey, walls, blocked, grass)) count++;
  }
  return count;
}

/** Per-isolated-gap blame attribution: how many of the 4 cardinal "blocker"
 *  cells (walls/blockers/oob/non-grass) come from the focal player's
 *  THIS-ROUND walls vs preexisting state (initial walls + enemy walls +
 *  static blockers + oob/non-grass)?
 *
 *  Buckets:
 *  - self: all blockers are this-round focal-player walls (AI is fully
 *    responsible for the isolation)
 *  - mixed: at least one this-round focal-player wall + at least one
 *    preexisting blocker
 *  - pre: zero this-round focal walls — geometry forced the isolation
 *    (preexisting walls / enemy walls / map edge / static obstacles)
 *
 *  Sums to the total isolated-gap count for the input set. */
export function classifyIsolatedGapBlame(
  gaps: ReadonlySet<TileKey>,
  focalWalls: ReadonlySet<TileKey>,
  initialFocalWalls: ReadonlySet<TileKey>,
  blocked: ReadonlySet<TileKey>,
  grass: ReadonlySet<TileKey>,
): { self: number; mixed: number; pre: number } {
  let self = 0;
  let mixed = 0;
  let pre = 0;
  for (const gapKey of gaps) {
    if (!isIsolatedGap(gapKey, focalWalls, blocked, grass)) continue;
    const { row, col } = unpackTile(gapKey);
    let thisRound = 0;
    let preexisting = 0;
    for (const [dr, dc] of CARDINAL_DIRS) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) {
        preexisting++;
        continue;
      }
      const nkey = packTile(nr, nc);
      if (focalWalls.has(nkey) && !initialFocalWalls.has(nkey)) {
        thisRound++;
      } else {
        preexisting++;
      }
    }
    if (thisRound > 0 && preexisting === 0) self++;
    else if (thisRound > 0) mixed++;
    else pre++;
  }
  return { self, mixed, pre };
}

export function solveWinnable(
  initialGaps: ReadonlySet<TileKey>,
  initialWalls: ReadonlySet<TileKey>,
  blocked: ReadonlySet<TileKey>,
  grass: ReadonlySet<TileKey>,
  pieces: readonly PieceShape[],
): SolverResult {
  const walls = new Set<TileKey>(initialWalls);
  const gaps = new Set<TileKey>(initialGaps);
  let nodes = 0;
  let timedOut = false;

  const rotationCache = new Map<string, PieceShape[]>();
  const rotationsOf = (piece: PieceShape): PieceShape[] => {
    const cached = rotationCache.get(piece.name);
    if (cached) return cached;
    const out: PieceShape[] = [];
    const seen = new Set<string>();
    let current = piece;
    for (let i = 0; i < 4; i++) {
      const k = shapeKey(current);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(current);
      }
      current = rotateCW(current);
    }
    rotationCache.set(piece.name, out);
    return out;
  };

  // Enumerate placements of `piece` covering ≥1 cell of `gaps`. Anchors
  // derived from each (gap, piece-offset) pair — bounds candidates to
  // |gaps| × |offsets| per rotation instead of the full board.
  const enumerate = (
    piece: PieceShape,
  ): { cells: TileKey[]; coverCount: number }[] => {
    const seen = new Set<string>();
    const out: { cells: TileKey[]; coverCount: number }[] = [];
    for (const gapKey of gaps) {
      const { row: gr, col: gc } = unpackTile(gapKey);
      for (const [dr, dc] of piece.offsets) {
        const ar = gr - dr;
        const ac = gc - dc;
        const cells: TileKey[] = [];
        let ok = true;
        let cover = 0;
        for (const [odr, odc] of piece.offsets) {
          const r = ar + odr;
          const c = ac + odc;
          if (r < 0 || r >= GRID_ROWS || c < 0 || c >= GRID_COLS) {
            ok = false;
            break;
          }
          const key = packTile(r, c);
          if (!grass.has(key) || blocked.has(key) || walls.has(key)) {
            ok = false;
            break;
          }
          cells.push(key);
          if (gaps.has(key)) cover++;
        }
        if (!ok || cover === 0) continue;
        const sig = [...cells].sort().join(",");
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push({ cells, coverCount: cover });
      }
    }
    out.sort((a, b) => b.coverCount - a.coverCount);
    return out;
  };

  const search = (pieceIdx: number): boolean => {
    if (gaps.size === 0) return true;
    if (pieceIdx >= pieces.length) return false;
    nodes++;
    if (nodes >= SOLVER_NODE_BUDGET) {
      timedOut = true;
      return false;
    }
    // Lower-bound prune: if max remaining coverage can't reach |gaps|, give up.
    let maxRemainingCover = 0;
    for (let i = pieceIdx; i < pieces.length; i++) {
      maxRemainingCover += pieces[i]!.offsets.length;
    }
    if (maxRemainingCover < gaps.size) return false;

    const piece = pieces[pieceIdx]!;
    for (const rot of rotationsOf(piece)) {
      const candidates = enumerate(rot);
      for (const cand of candidates) {
        const removed: TileKey[] = [];
        for (const cell of cand.cells) {
          walls.add(cell);
          if (gaps.delete(cell)) removed.push(cell);
        }
        const ok = search(pieceIdx + 1);
        for (const cell of cand.cells) walls.delete(cell);
        for (const cell of removed) gaps.add(cell);
        if (ok) return true;
        if (timedOut) return false;
      }
    }
    // Skip-piece: models a wasteful placement that advances the bag.
    return search(pieceIdx + 1);
  };

  const won = search(0);
  if (timedOut) return { result: "TIMEOUT", nodes };
  return { result: won, nodes };
}

function isIsolatedGap(
  gapKey: TileKey,
  walls: ReadonlySet<TileKey>,
  blocked: ReadonlySet<TileKey>,
  grass: ReadonlySet<TileKey>,
): boolean {
  const { row, col } = unpackTile(gapKey);
  for (const [dr, dc] of CARDINAL_DIRS) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
    const nkey = packTile(nr, nc);
    if (!grass.has(nkey)) continue;
    if (blocked.has(nkey)) continue;
    if (walls.has(nkey)) continue;
    return false;
  }
  return true;
}

function shapeKey(piece: PieceShape): string {
  let minR = Infinity;
  let minC = Infinity;
  for (const [r, c] of piece.offsets) {
    if (r < minR) minR = r;
    if (c < minC) minC = c;
  }
  return [...piece.offsets]
    .map(([r, c]): [number, number] => [r - minR, c - minC])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([r, c]) => `${r},${c}`)
    .join(";");
}
