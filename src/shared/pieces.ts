/**
 * Tetris-like wall pieces for the repair/build phase.
 */

import { Rng } from "./rng.ts";

export interface PieceShape {
  name: string;
  offsets: [number, number][]; // [dr, dc] from top-left anchor
  width: number;
  height: number;
  /** Rotation pivot [row, col] — stays at the same grid cell when rotating. */
  pivot: [number, number];
}

interface PieceWeight {
  piece: PieceShape;
  /** Difficulty tier: 1 = simple, 2 = medium, 3 = hard. */
  tier: number;
  /** Weight at round 2 (first repair round). */
  early: number;
  /** Weight at round 8+. */
  late: number;
}

export interface BagState {
  round: number;
  queue: PieceShape[];
  rng: Rng;
  smallPieces: boolean;
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
/**
 * Compute the bag pool for a given round. Linearly interpolates early→late
 * over rounds 2–8 (slower ramp than before). Pieces are grouped by difficulty
 * tier: simple pieces come first (popped first), hard pieces last.
 * Within each tier the order is shuffled.
 */
/** Round at which piece pool interpolation starts. */
const PIECE_POOL_START_ROUND = 2;
/** Round at which piece pool interpolation ends. */
const PIECE_POOL_END_ROUND = 8;
/** Chance that a simple piece gets scattered into the harder section as relief. */
const SIMPLE_PIECE_SCATTER_CHANCE = 0.3;
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
const PIECE_WEIGHTS: PieceWeight[] = [
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

export function createBag(
  round: number,
  rng?: Rng,
  smallPieces?: boolean,
): BagState {
  return {
    round,
    queue: [],
    rng: rng ?? new Rng(),
    smallPieces: !!smallPieces,
  };
}

/** Draw the next piece from the bag. Refills queue when empty. */
export function nextPiece(bag: BagState): PieceShape {
  refillBagQueueIfNeeded(bag);
  return normalizeOrientation(bag.queue.pop()!);
}

/** Check if two pieces have the same shape (ignoring position). */
export function sameShape(a: PieceShape, b: PieceShape): boolean {
  return pieceKey(a) === pieceKey(b);
}

/** Ensure the piece is oriented with its longest side horizontal. */
function normalizeOrientation(piece: PieceShape): PieceShape {
  if (hasPortraitOrientation(piece)) {
    return rotateCW(piece);
  }
  return piece;
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

/** Normalized key for a piece shape (origin-independent). */
function pieceKey(pieceShape: PieceShape): string {
  const minR = Math.min(...pieceShape.offsets.map((offset) => offset[0]));
  const minC = Math.min(...pieceShape.offsets.map((offset) => offset[1]));
  return [...pieceShape.offsets]
    .map(([r, c]) => [r - minR, c - minC] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map((offset) => `${offset[0]},${offset[1]}`)
    .join(";");
}

function hasPortraitOrientation(piece: PieceShape): boolean {
  return piece.height > piece.width;
}

function refillBagQueueIfNeeded(bag: BagState): void {
  if (bag.queue.length === 0) {
    // piecePool returns pieces ordered: hard at front, simple at back.
    // pop() draws from the back -> simple pieces come first.
    bag.queue = piecePool(bag.round, bag.rng, bag.smallPieces);
  }
}

function piecePool(
  round: number,
  rng: Rng,
  smallPieces?: boolean,
): PieceShape[] {
  if (smallPieces) {
    const pool = PIECE_WEIGHTS.filter((pw) => pw.tier === 1).flatMap((pw) =>
      Array.from<PieceShape>({ length: 3 }).fill(pw.piece),
    );
    rng.shuffle(pool);
    return pool;
  }
  // t goes from 0 (round 2) to 1 (round 8+)
  const interpolationFactor = Math.min(
    1,
    Math.max(
      0,
      (round - PIECE_POOL_START_ROUND) /
        (PIECE_POOL_END_ROUND - PIECE_POOL_START_ROUND),
    ),
  );
  // Build one bucket per tier
  const buckets: PieceShape[][] = [[], [], []]; // tier 1, 2, 3
  for (const pw of PIECE_WEIGHTS) {
    const copies = interpolatedCopies(pw, interpolationFactor);
    for (let i = 0; i < copies; i++) buckets[pw.tier - 1]!.push(pw.piece);
  }
  // Shuffle within each bucket
  for (const bucket of buckets) rng.shuffle(bucket);
  // Queue order: hard first (drawn last) → simple last (drawn first via pop)
  const queue = [...buckets[2]!, ...buckets[1]!, ...buckets[0]!];

  // Scatter relief: randomly swap some simple pieces into the hard/medium section.
  // Pop() draws from the back, so simple pieces (at back) are drawn first.
  // Moving a simple piece toward the front means it'll appear later, among harder pieces.
  const harderCount = buckets[2]!.length + buckets[1]!.length;
  if (harderCount > 0) {
    for (let i = queue.length - 1; i >= harderCount; i--) {
      if (rng.bool(SIMPLE_PIECE_SCATTER_CHANCE)) {
        const target = rng.int(0, harderCount - 1);
        const tmp = queue[i]!;
        queue[i] = queue[target]!;
        queue[target] = tmp;
      }
    }
  }

  return queue;
}

function interpolatedCopies(
  pieceWeight: PieceWeight,
  interpolationFactor: number,
): number {
  return Math.round(
    pieceWeight.early +
      (pieceWeight.late - pieceWeight.early) * interpolationFactor,
  );
}
