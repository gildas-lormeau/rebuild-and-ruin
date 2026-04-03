/**
 * Shared types for the AI build-phase pipeline.
 *
 * Used by ai-strategy-build.ts (orchestrator), ai-build-target.ts,
 * ai-build-score.ts, and ai-build-fallback.ts.
 */

import type { TilePos, TileRect, Tower } from "./geometry-types.ts";
import type { PieceShape } from "./pieces.ts";

/** Optional AI personality / context parameters for placement. */
export interface PlacementOptions {
  cursorPos?: TilePos;
  homeWasBroken?: boolean;
  castleMargin?: number;
  bankHugging?: boolean;
  caresAboutHouses?: boolean;
  caresAboutBonuses?: boolean;
  buildSkill?: number;
}

/** Result of a single AI placement decision. null = no valid placement. */
export interface AiPlacement {
  piece: PieceShape;
  row: TilePos["row"];
  col: TilePos["col"];
}

export type Candidate = TilePos & {
  piece: PieceShape;
  gapsFilled: number;
  wallAdjacent: number;
  connectedTiles: number;
  gapAdjacent: number;
  isolated: number;
  housesHit: number;
  bonusHit: number;
};

export type Scored = {
  candidate: Candidate;
  score: number;
  gapClosingFat: boolean;
  hasFatWall: boolean;
  fatBlocks: number;
};

/** Shared context for fallback placement decisions — avoids threading 9 params. */
export interface FallbackContext {
  walls: ReadonlySet<number>;
  outside: Set<number>;
  interior: ReadonlySet<number>;
  castle: { tower: Tower };
  castleMargin: number;
  homeWasBroken: boolean;
  unenclosedTowers: readonly Tower[];
  caresAboutHouses: boolean;
  caresAboutBonuses: boolean;
}

/** Per-candidate computed values for the scoring pipeline. Built once per
 *  candidate after cheap pre-filter checks pass, then passed to each rule. */
export interface CandidateEnv {
  simulatedWalls: Set<number>;
  simulatedOutside: Set<number>;
  usefulGain: number;
  pocketDelta: number;
  pocketInfo: { wasted: number; smallestPocket: number };
  gapClosingFat: boolean;
  hasFatWall: boolean;
  fatBlocks: number;
  /** True when ANY candidate in the current batch has wallAdjacent or connectedTiles > 0.
   *  Batch-level flag — same for all candidates, computed once per scoring pass. */
  anyHasWallAdjacent: boolean;
}

/** A named scoring rule: returns a score contribution, or null to hard-reject.
 *  - Return `null` to hard-reject the candidate (skips remaining rules).
 *  - Return `0` for "no opinion" (candidate is NOT rejected).
 *  - Return positive for bonus, negative for penalty.
 *  IMPORTANT: `null` and `0` have different meanings — don't confuse them. */
export interface ScoringRule {
  readonly name: string;
  apply(
    candidate: Candidate,
    env: CandidateEnv,
    ctx: ScoringContext,
  ): number | null;
}

/** Shared context for the scoring loop — avoids threading 15+ params through closures. */
export type ScoringContext = {
  state: import("./types.ts").GameState;
  walls: ReadonlySet<number>;
  outside: Set<number>;
  targetGaps: Set<number>;
  castle: TileRect;
  cursorPos: TilePos | undefined;
  zoneTowers: Tower[];
  ownedTowers: Tower[];
  skill: {
    topCandidates: number;
    fatGainPerBlock: number;
    pocketScale: number;
    fatPenaltyScale: number;
    tinyPocketReject: boolean;
  };
  caresAboutHouses: boolean;
  caresAboutBonuses: boolean;
  allCastlesEnclosed: boolean;
  homeTowerEnclosed: boolean;
  homeWasBroken: boolean | undefined;
  baselineOutside: number;
  baselinePocketWaste: number;
};
