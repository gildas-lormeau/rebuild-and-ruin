/**
 * Tetris-like wall piece types for the repair/build phase. Universal
 * vocabulary: the Player struct embeds `currentPiece`/`bag`, and renderers +
 * AI read `PieceShape`. The shape catalog, bag generation, and rotation logic
 * live in the sim tier at shared/sim/pieces.ts.
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
