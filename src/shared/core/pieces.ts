/**
 * Tetris-like wall piece vocabulary for the repair/build phase: the shape
 * catalog, round-weighted pool composition, and pure shape ops (rotation,
 * equality). Determinism-irrelevant — the `Player` struct embeds
 * `currentPiece`/`bag`, AI derives the round pool via `piecesInRoundPool`
 * with no RNG. The stateful RNG bag DRAW lives in shared/sim/pieces.ts.
 */

import { Rng } from "../platform/rng.ts";

export interface PieceShape {
  name: string;
  offsets: [number, number][]; // [dr, dc] from top-left anchor
  width: number;
  height: number;
  /** Rotation pivot [row, col] — stays at the same grid cell when rotating. */
  pivot: [number, number];
}

export interface BagState {
  round: number;
  queue: PieceShape[];
  rng: Rng;
  smallPieces: boolean;
}

export interface PieceWeight {
  piece: PieceShape;
  /** Difficulty tier: 1 = simple, 2 = medium, 3 = hard. */
  tier: number;
  /** Weight at round 2 (first repair round). */
  early: number;
  /** Weight at round 8+. */
  late: number;
}

const PIECE_Z: PieceShape = {
  name: "Z",
  offsets: [
    [0, 0],
    [0, 1],
    [1, 1],
    [2, 1],
    [2, 2],
  ],
  width: 3,
  height: 3,
  pivot: [1, 1],
};
const PIECE_ZR: PieceShape = {
  name: "ZR",
  offsets: [
    [0, 1],
    [0, 2],
    [1, 1],
    [2, 0],
    [2, 1],
  ],
  width: 3,
  height: 3,
  pivot: [1, 1],
};
const PIECE_CORNER: PieceShape = {
  name: "Corner",
  offsets: [
    [0, 0],
    [0, 1],
    [1, 0],
  ],
  width: 2,
  height: 2,
  pivot: [0, 0],
};
const PIECE_T: PieceShape = {
  name: "T",
  offsets: [
    [0, 0],
    [0, 1],
    [0, 2],
    [1, 1],
  ],
  width: 3,
  height: 2,
  pivot: [1, 1],
};
const PIECE_1x1: PieceShape = {
  name: "1x1",
  offsets: [[0, 0]],
  width: 1,
  height: 1,
  pivot: [0, 0],
};
const PIECE_1x2: PieceShape = {
  name: "1x2",
  offsets: [
    [0, 0],
    [0, 1],
  ],
  width: 2,
  height: 1,
  pivot: [0, 0],
};
const PIECE_1x3: PieceShape = {
  name: "1x3",
  offsets: [
    [0, 0],
    [0, 1],
    [0, 2],
  ],
  width: 3,
  height: 1,
  pivot: [0, 1],
};
const PIECE_L: PieceShape = {
  name: "L",
  offsets: [
    [0, 2],
    [1, 0],
    [1, 1],
    [1, 2],
  ],
  width: 3,
  height: 2,
  pivot: [1, 1],
};
const PIECE_C: PieceShape = {
  name: "C",
  offsets: [
    [0, 0],
    [0, 1],
    [0, 2],
    [1, 0],
    [1, 2],
  ],
  width: 3,
  height: 2,
  pivot: [1, 1],
};
const PIECE_S: PieceShape = {
  name: "S",
  offsets: [
    [0, 1],
    [0, 2],
    [1, 0],
    [1, 1],
  ],
  width: 3,
  height: 2,
  pivot: [1, 1],
};
const PIECE_J: PieceShape = {
  name: "J",
  offsets: [
    [0, 0],
    [1, 0],
    [1, 1],
    [1, 2],
  ],
  width: 3,
  height: 2,
  pivot: [1, 1],
};
const PIECE_SR: PieceShape = {
  name: "SR",
  offsets: [
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 2],
  ],
  width: 3,
  height: 2,
  pivot: [1, 1],
};
const PIECE_PLUS: PieceShape = {
  name: "+",
  offsets: [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, 2],
    [2, 1],
  ],
  width: 3,
  height: 3,
  pivot: [1, 1],
};
/** Round-weight table for bag composition. Read by `piecesInRoundPool` (pure,
 *  AI lookahead) and by the RNG bag generator `piecePool` in sim/pieces.ts. */
export const PIECE_WEIGHTS: PieceWeight[] = [
  { piece: PIECE_1x1, tier: 1, early: 5, late: 1 },
  { piece: PIECE_1x2, tier: 1, early: 5, late: 1 },
  { piece: PIECE_1x3, tier: 1, early: 4, late: 1 },
  { piece: PIECE_CORNER, tier: 1, early: 3, late: 1 },
  { piece: PIECE_T, tier: 2, early: 1, late: 2 },
  { piece: PIECE_L, tier: 2, early: 1, late: 2 },
  { piece: PIECE_J, tier: 2, early: 1, late: 2 },
  { piece: PIECE_S, tier: 2, early: 1, late: 2 },
  { piece: PIECE_SR, tier: 2, early: 1, late: 2 },
  { piece: PIECE_C, tier: 3, early: 0, late: 2 },
  { piece: PIECE_Z, tier: 3, early: 0, late: 3 },
  { piece: PIECE_ZR, tier: 3, early: 0, late: 3 },
  { piece: PIECE_PLUS, tier: 3, early: 0, late: 3 },
];
/** Every distinct piece shape in the game (one canonical rotation each). */
export const ALL_PIECE_SHAPES: readonly PieceShape[] = [
  PIECE_1x1,
  PIECE_1x2,
  PIECE_1x3,
  PIECE_CORNER,
  PIECE_T,
  PIECE_L,
  PIECE_J,
  PIECE_S,
  PIECE_SR,
  PIECE_C,
  PIECE_Z,
  PIECE_ZR,
  PIECE_PLUS,
];
/** Round at which piece pool interpolation starts. */
export const PIECE_POOL_START_ROUND = 2;
/** Round at which piece pool interpolation ends. */
export const PIECE_POOL_END_ROUND = 8;

/** Distinct piece shapes that appear in the bag pool for the given round
 *  configuration. Deterministic from `(round, smallPieces)` — does NOT
 *  consume RNG. Mirrors `piecePool`'s composition logic without the shuffle.
 *  Used by the AI build lookahead so the rule consumes only information a
 *  human could also derive from the round counter + visible modifier state
 *  (no actual bag-queue peek, which would be asymmetric info). */
export function piecesInRoundPool(
  round: number,
  smallPieces?: boolean,
): readonly PieceShape[] {
  if (smallPieces) {
    return PIECE_WEIGHTS.filter((pw) => pw.tier === 1).map((pw) => pw.piece);
  }
  const interpolationFactor = Math.min(
    1,
    Math.max(
      0,
      (round - PIECE_POOL_START_ROUND) /
        (PIECE_POOL_END_ROUND - PIECE_POOL_START_ROUND),
    ),
  );
  const present: PieceShape[] = [];
  for (const pw of PIECE_WEIGHTS) {
    if (interpolatedCopies(pw, interpolationFactor) > 0) present.push(pw.piece);
  }
  return present;
}

/** Rotate a piece 90 degrees clockwise. Pivot transforms with the offsets. */
export function rotateCW(piece: PieceShape): PieceShape {
  const h = piece.height;
  const newOffsets: [number, number][] = piece.offsets.map(([dr, dc]) => [
    dc,
    h - 1 - dr,
  ]);
  return {
    name: piece.name,
    offsets: newOffsets,
    width: piece.height,
    height: piece.width,
    pivot: [piece.pivot[1], h - 1 - piece.pivot[0]],
  };
}

/** Check if two pieces have the same shape (ignoring position). */
export function sameShape(a: PieceShape, b: PieceShape): boolean {
  return pieceKey(a) === pieceKey(b);
}

/** Round-interpolated copy count for a piece weight: linear early→late over
 *  rounds `PIECE_POOL_START_ROUND`..`PIECE_POOL_END_ROUND`. Shared by the pure
 *  pool query here and the RNG bag generator in sim/pieces.ts. */
export function interpolatedCopies(
  pieceWeight: PieceWeight,
  interpolationFactor: number,
): number {
  return Math.round(
    pieceWeight.early +
      (pieceWeight.late - pieceWeight.early) * interpolationFactor,
  );
}

/** Normalized key for a piece shape (origin-independent). */
function pieceKey(pieceShape: PieceShape): string {
  let minR = Infinity;
  let minC = Infinity;
  for (const [r, c] of pieceShape.offsets) {
    if (r < minR) minR = r;
    if (c < minC) minC = c;
  }
  return [...pieceShape.offsets]
    .map(([r, c]) => [r - minR, c - minC] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map((offset) => `${offset[0]},${offset[1]}`)
    .join(";");
}
