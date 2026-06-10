/**
 * Shared types for the AI build-phase pipeline.
 *
 * Used by ai-strategy-build.ts (orchestrator), ai-build-target.ts,
 * ai-build-score.ts, and ai-build-shared.ts.
 */

import type { PlacementContext } from "../game/index.ts";
import type { OccupancyCache } from "../shared/core/board-occupancy.ts";
import type {
  Castle,
  TilePos,
  TileRect,
  Tower,
  TowerIdx,
} from "../shared/core/geometry-types.ts";
import type { TileKey } from "../shared/core/grid.ts";
import type { PieceShape } from "../shared/core/pieces.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import type { BuildViewState } from "../shared/core/system-interfaces.ts";

/** Result of enclosure analysis — which towers need walling, skip-home logic, etc. */
export interface EnclosureAnalysis {
  outside: Set<TileKey>;
  homeTowerEnclosed: boolean;
  zoneTowers: Tower[];
  unenclosedTowers: Tower[];
  otherUnenclosed: Tower[];
  allCastlesEnclosed: boolean;
  effectiveSkipHome: boolean;
}

/** Result of target selection — which gaps to fill and the bounding rect. */
export type TargetResult = {
  targetGaps: Set<TileKey>;
  targetRect: TileRect | null;
  /** Set only when the planner committed to an alive solo tower that meets ALL
   *  cache-write invariants (alive, manageable gap count, piece-feasible).
   *  Threaded back to the strategy so the next tick can short-circuit the
   *  per-tick re-decision and avoid Mode #2 churn. Never set for merges,
   *  dead-tower targets, expand-territory, or strategicFallbackTarget — those
   *  are not commitments worth persisting. */
  chosenTowerIndex?: TowerIdx;
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
  homeTowerEnclosed: boolean;
  allCastlesEnclosed: boolean;
  unenclosedTowers: Tower[];
  otherUnenclosed: Tower[];
  /** Tower the strategy committed to on the previous tick (from a prior
   *  planner cache write). The planner checks this at entry and short-circuits
   *  when the cached tower remains a closeable candidate, skipping the per-tick
   *  re-ranking that drives Mode #2 churn. */
  lastTargetTowerIndex: TowerIdx | undefined;
  /** Occupancy cache built once per pickPlacement to skip rebuilding inside
   *  every canPlacePiece sweep called by selectTarget's sub-helpers. */
  cache: OccupancyCache;
  /** PlacementContext built once per pickPlacement — pairs with `cache`. */
  placementCtx: PlacementContext;
}

/** AI personality / context parameters for placement. Filled in by
 *  DefaultStrategy.pickPlacement before invoking the internal pipeline. */
export interface PlacementOptions {
  cursorPos: TilePos | undefined;
  homeWasBroken: boolean;
  castleMargin: number;
  bankHugging: boolean;
  caresAboutHouses: boolean;
  caresAboutBonuses: boolean;
  buildSkill: 1 | 2 | 3 | 4 | 5;
  /** Enclosure-target commitment carried over from the previous build tick
   *  (if any). Threaded into `selectTarget` for the short-circuit. */
  lastTargetTowerIndex: TowerIdx | undefined;
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
  /** Pre-computed alive-house tile keys — threaded in from pickPlacement so
   *  this fallback path doesn't re-walk `state.map.houses`. */
  aliveHouseKeys: ReadonlySet<TileKey>;
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
  enclosedTowers: Tower[];
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
  homeWasBroken: boolean;
  baselineOutside: number;
  baselinePocketWaste: number;
  /** Tile keys of every alive house. Piece offsets that hit one of these
   *  tiles do NOT become walls on placement (they spawn a grunt instead),
   *  so the simulated-wall predictors filter them out. Computed once per
   *  AI tick at scoring-context construction. */
  aliveHouseKeys: ReadonlySet<TileKey>;
  /** 1-step bag lookahead anchors (Direction #4 — search-based placement).
   *  Each entry marks an unenclosed tower OTHER than the active target whose
   *  ring is near-complete (≤ MANAGEABLE_GAP_LIMIT gaps) AND whose gaps the
   *  next peeked piece in the bag CAN fill. Used by `cursor-anticipation`
   *  scoring rule to bias placements toward leaving the cursor close to a
   *  future viable gap-fill — preventing wasted long-cursor travel after
   *  filling a far-away gap when a near-complete home/secondary ring is
   *  still pending. Empty when bag has no peek, no near-complete alternates
   *  exist, or peeked piece doesn't fit any. */
  peekFitTargets: readonly PeekFitTarget[];
};

/** Anchor for the cursor-anticipation lookahead bonus.
 *  `anchorRow`/`anchorCol` are the gap centroid (fractional) — the rule
 *  rewards placements close to this position via Manhattan distance.
 *  `gapsCount` is informational (smaller rings get slightly higher pull). */
export interface PeekFitTarget {
  anchorRow: number;
  anchorCol: number;
  gapsCount: number;
}
