/**
 * The RNG-driven, BagState-mutating bag draw — the one part of the piece
 * system that must run in lockstep on every peer. Static piece vocabulary
 * (shape catalog, weights, rotation, the RNG-free `piecesInRoundPool`) lives
 * in shared/core/pieces.ts; this file only composes + draws the bag, consuming
 * `state.rng`. Drives `state.rng`, so it must run on every peer in the same
 * order.
 */

import {
  type BagState,
  interpolatedCopies,
  PIECE_POOL_END_ROUND,
  PIECE_POOL_START_ROUND,
  PIECE_WEIGHTS,
  type PieceShape,
  rotateCW,
} from "../core/pieces.ts";
import { Rng } from "../platform/rng.ts";

/** Chance that a simple piece gets scattered into the harder section as relief. */
const SIMPLE_PIECE_SCATTER_CHANCE = 0.3;

export function createBag(
  round: number,
  rng: Rng,
  smallPieces?: boolean,
): BagState {
  return {
    round,
    queue: [],
    rng,
    smallPieces: !!smallPieces,
  };
}

/** Draw the next piece from the bag. Refills queue when empty. */
export function nextPiece(bag: BagState): PieceShape {
  refillBagQueueIfNeeded(bag);
  return normalizeOrientation(bag.queue.pop()!);
}

/** Ensure the piece is oriented with its longest side horizontal. */
function normalizeOrientation(piece: PieceShape): PieceShape {
  if (hasPortraitOrientation(piece)) {
    return rotateCW(piece);
  }
  return piece;
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

/**
 * Compute the bag pool for a given round. Linearly interpolates early→late
 * over rounds 2–8 (slower ramp than before). Pieces are grouped by difficulty
 * tier: simple pieces come first (popped first), hard pieces last.
 * Within each tier the order is shuffled.
 */
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
