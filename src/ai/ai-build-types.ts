/**
 * Shared types for the AI build-phase pipeline.
 *
 * Used by ai-strategy-build.ts (orchestrator), ai-build-target.ts,
 * ai-build-score.ts, and ai-build-fallback.ts.
 */

import type {
  Castle,
  PixelPos,
  TilePos,
  TileRect,
  Tower,
} from "../shared/core/geometry-types.ts";
import type { TileKey } from "../shared/core/grid.ts";
import type { PieceShape } from "../shared/core/pieces.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import type { BuildViewState } from "../shared/core/system-interfaces.ts";

/** Pixel position annotated with strategic flag (AI targeting). */
export type StrategicPixelPos = PixelPos & { strategic?: boolean };

/** Result of enclosure analysis — which towers need walling, skip-home logic, etc. */
export interface EnclosureAnalysis {
  outside: Set<TileKey>;
  homeTowerEnclosed: boolean;
  zoneTowers: Tower[];
  unenclosedTowers: Tower[];
  otherUnenclosed: Tower[];
  allCastlesEnclosed: boolean;
  effectiveSkipHome: boolean;
  homeHasRingGaps: boolean;
}

/** Result of target selection — which gaps to fill and the bounding rect. */
export type TargetResult = {
  targetGaps: Set<TileKey>;
  targetRect: TileRect | null;
};

/** Context for the target-selection pipeline (home repair → secondary → expand). */
export interface TargetContext {
  state: BuildViewState;
  playerId: ValidPlayerId;
  player: Player;
  castle: Castle;
  piece: PieceShape;
  castleMargin: number;
  bankHugging: boolean;
  cursorPos: TilePos | undefined;
  effectiveSkipHome: boolean;
  homeHasRingGaps: boolean;
  allCastlesEnclosed: boolean;
  unenclosedTowers: Tower[];
  otherUnenclosed: Tower[];
  outerRingHolesSnapshot: ReadonlySet<TileKey>;
}

/** Optional AI personality / context parameters for placement. */
export interface PlacementOptions {
  cursorPos?: TilePos;
  homeWasBroken?: boolean;
  castleMargin?: number;
  bankHugging?: boolean;
  caresAboutHouses?: boolean;
  caresAboutBonuses?: boolean;
  buildSkill?: number;
  /** Phase-stable snapshot of outer-ring breach tiles (computed by the
   *  strategy on first call of the build phase and held constant).
   *  tryRepairOuterRing uses this set verbatim (minus tiles the AI has
   *  since walled) instead of recomputing each tick — recomputation picks
   *  up "phantom" gaps formed by newly-placed walls pairing with existing
   *  walls, which would otherwise disperse the AI's focus. */
  outerRingHolesSnapshot: ReadonlySet<TileKey>;
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
  walls: ReadonlySet<TileKey>;
  outside: Set<TileKey>;
  playerInterior: ReadonlySet<TileKey>;
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
  simulatedWalls: Set<TileKey>;
  simulatedOutside: Set<TileKey>;
  usefulGain: number;
  pocketDelta: number;
  pocketInfo: { wasted: number; smallestPocket: number };
  gapClosingFat: boolean;
  hasFatWall: boolean;
  fatBlocks: number;
  /** True when ANY candidate in the current batch has wallAdjacent or connectedTiles > 0.
   *  Batch-level flag — same for all candidates, computed once per scoring pass. */
  batchHasWallAdjacent: boolean;
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
  state: BuildViewState;
  walls: ReadonlySet<TileKey>;
  outside: Set<TileKey>;
  targetGaps: Set<TileKey>;
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
