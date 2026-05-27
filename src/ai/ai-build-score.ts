/**
 * AI build-phase scoring — territory gain evaluation, fat wall checks,
 * pocket analysis, and all compute* penalty/bonus functions.
 *
 * Called by the build placement orchestrator (ai-strategy-build.ts).
 */

import { computeCardinalObstacleMask } from "../shared/core/board-occupancy.ts";
import type {
  TilePos,
  TileRect,
  Tower,
} from "../shared/core/geometry-types.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  type Tile,
  type TileKey,
} from "../shared/core/grid.ts";
import {
  CORNERS_2X2,
  computeOutsideAfterAdd,
  DIRS_4,
  inBounds,
  isWater,
  manhattanDistance,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { BuildViewState } from "../shared/core/system-interfaces.ts";
import type {
  AiPlacement,
  Candidate,
  CandidateEnv,
  Scored,
  ScoringContext,
  ScoringRule,
} from "./ai-build-types.ts";
import { floodPocket } from "./ai-castle-rect.ts";
import { SMALL_POCKET_MAX_SIZE, TINY_POCKET_MAX_SIZE } from "./ai-constants.ts";

/** Result of scoring a top-candidate batch. Discriminated by `evaluated`:
 *  `true` carries a real winner; `false` means every candidate was hard-rejected
 *  by SCORING_RULES (or the batch was empty), and callers should fall through
 *  to the no-territory-gain path. */
type ScoreTopResult =
  | { evaluated: true; bestCandidate: Candidate; bestScore: number }
  | { evaluated: false };

/** Starting bonus for gap-filling placements before useful-gain reduction. */
const GAP_BONUS_BASE = 5;
/** Minimum gap bonus after useful-gain reduction (floor). */
const GAP_BONUS_MIN = 0.5;
/** How much each point of useful gain reduces the gap bonus. */
const GAP_BONUS_GAIN_FACTOR = 0.2;
/** Extra gap bonus per additional gap tile beyond the first. */
const GAP_BONUS_PER_EXTRA = 0.3;
/** Max Manhattan distance from cursor that still receives a proximity bonus. */
const CURSOR_PROXIMITY_MAX = 20;
/** Scales the cursor proximity bonus (higher = stronger cursor pull). */
const CURSOR_PROXIMITY_MULTIPLIER = 0.5;
/** Bonus per inner tile when placement fills gaps near water obstacles. */
const INNER_OBSTACLE_MULTIPLIER = 2;
/** Minimum penalty for a gap-closing placement that creates a 2x2 fat wall. */
const FAT_WALL_PENALTY_MIN = 5;
/** Fraction of useful gain used as penalty for gap-closing fat walls. */
const FAT_WALL_GAIN_FACTOR = 0.95;
/** Score bonus per obstacle around a 1x1 gap (prioritizes hard-to-fill gaps). */
const DIFFICULTY_MULTIPLIER = 3;
/** Score penalty per tile of new wasted pocket space created. */
const POCKET_DELTA_PENALTY = 3;
/** Score penalty for each house or bonus square tile covered by a placement. */
const OBSTACLE_HIT_PENALTY = 8;
/** Distance threshold (tiles) within which an unowned zone tower contributes a proximity bonus. */
const TOWER_PROXIMITY_RANGE = 8;
/** Score bonus per tile of proximity to an unowned zone tower (guides expansion). */
const TOWER_PROXIMITY_FACTOR = 0.3;
/** Bonus per gap tile that would survive the sweep (≥2 cardinal neighbors). */
const SWEEP_SAFE_BONUS = 2;
/** Max tile distance from candidate centroid to a peek-fit anchor that still
 *  receives a `cursor-anticipation` bonus (Direction #4 bag-lookahead). */
const CURSOR_ANTICIPATION_MAX = 18;
/** Per-tile weight on the cursor-anticipation bonus. Sized to compete with
 *  the gap-fill score among candidates that fill the SAME number of gaps —
 *  acts as a tiebreaker that picks the gap-filler closest to a future viable
 *  fill, without overriding the primary gap-fill ranking. */
const CURSOR_ANTICIPATION_WEIGHT = 2;
/** Reject candidates where all non-gap tiles are isolated (no wall adjacency).
 *  These placements bridge a gap but "float" — the non-gap portion is wasted. */
const rejectIsolatedGapTiles: ScoringRule = {
  name: "reject-isolated-gap-tiles",
  apply(candidate, _env, ctx) {
    const nonGapCount = candidate.piece.offsets.length - candidate.gapsFilled;
    if (
      !ctx.homeWasBroken &&
      !ctx.homeTowerEnclosed &&
      candidate.gapsFilled > 0 &&
      nonGapCount > 0 &&
      candidate.isolated >= nonGapCount
    )
      return null;
    return 0;
  },
};
/** Reject candidates that create too many 2×2 fat blocks relative to territory gain. */
const rejectFatWalls: ScoringRule = {
  name: "reject-fat-walls",
  apply(candidate, env, ctx) {
    const fatExempt = candidate.gapsFilled > 0 && !ctx.allCastlesEnclosed;
    if (
      shouldRejectForFatWalls(
        env.fatBlocks,
        ctx.skill.fatGainPerBlock,
        env.usefulGain,
        fatExempt,
      )
    )
      return null;
    return 0;
  },
};
/** Reject candidates that create tiny interior pockets without filling gaps. */
const rejectTinyPockets: ScoringRule = {
  name: "reject-tiny-pockets",
  apply(candidate, env, ctx) {
    if (!ctx.skill.tinyPocketReject) return 0;
    // Hard reject: placement results in a tiny pocket (≤ 3 tiles) —
    // always reject regardless of net pocketDelta, because a new tiny
    // pocket is wasteful even if another pocket was eliminated elsewhere.
    if (env.pocketInfo.smallestPocket <= TINY_POCKET_MAX_SIZE) return null;
    // Larger small pockets (< 9 tiles): only reject when net pocket waste
    // increased and no gaps are being filled.
    if (
      env.pocketDelta > 0 &&
      env.pocketInfo.smallestPocket < SMALL_POCKET_MAX_SIZE &&
      candidate.gapsFilled === 0
    )
      return null;
    return 0;
  },
};
/** Base territory gain: outside tiles reclaimed minus piece tiles placed. */
const usefulGainRule: ScoringRule = {
  name: "useful-gain",
  apply(_candidate, env) {
    return env.usefulGain;
  },
};
/** Bonus for filling gap tiles, penalized if the closure wastes interior space. */
const gapClosureRule: ScoringRule = {
  name: "gap-closure",
  apply(candidate, env, ctx) {
    const baseBonus = computeGapBonus(candidate.gapsFilled, env.usefulGain);
    const { gapBonus, wastefulClosurePenalty } =
      computeWastefulClosureAdjustment(
        candidate,
        ctx.targetGaps,
        ctx.castle,
        env.usefulGain,
        baseBonus,
      );
    return gapBonus - wastefulClosurePenalty;
  },
};
/** Bonus for filling gaps near water obstacles inside the castle rect. */
const innerObstacleRule: ScoringRule = {
  name: "inner-obstacle",
  apply(candidate, _env, ctx) {
    return computeInnerObstacleBonus(
      candidate,
      ctx.targetGaps,
      ctx.castle,
      ctx.state.map.tiles,
    );
  },
};
/** Bonus for 1×1 pieces filling hard-to-reach gaps (surrounded by obstacles). */
const difficultyRule: ScoringRule = {
  name: "difficulty",
  apply(candidate, _env, ctx) {
    return computeDifficultyBonus(ctx.state, candidate);
  },
};
/** Penalty for creating new small interior pockets. */
const pocketPenaltyRule: ScoringRule = {
  name: "pocket-penalty",
  apply(_candidate, env, ctx) {
    return -computePocketPenalty(env.pocketDelta, ctx.skill.pocketScale);
  },
};
/** Penalty for destroying houses or bonus squares. */
const obstacleHitRule: ScoringRule = {
  name: "obstacle-hit",
  apply(candidate, _env, ctx) {
    return -computeObstacleHitPenalty(
      candidate,
      ctx.caresAboutHouses,
      ctx.caresAboutBonuses,
    );
  },
};
const fatWallPenaltyRule: ScoringRule = {
  name: "fat-wall-penalty",
  apply(_candidate, env, ctx) {
    return -computeFatWallPenalty(
      env.gapClosingFat,
      env.hasFatWall,
      env.usefulGain,
      ctx.skill.fatPenaltyScale,
    );
  },
};
/** Bonus for gap tiles that would survive the post-build sweep (≥2 cardinal neighbors). */
const sweepSafeRule: ScoringRule = {
  name: "sweep-safe",
  apply(candidate, env, ctx) {
    return computeSweepSafeBonus(candidate, ctx.targetGaps, env.simulatedWalls);
  },
};
/** Bonus for placements near the current cursor (reduces travel time). */
const cursorProximityRule: ScoringRule = {
  name: "cursor-proximity",
  apply(candidate, env, ctx) {
    return computeCursorProximityBonus(
      candidate,
      env.batchHasWallAdjacent,
      ctx.cursorPos,
    );
  },
};
/** Bag-lookahead bonus (Direction #4): biases candidates toward leaving the
 *  cursor near a future viable gap-fill opportunity on a NEAR-COMPLETE
 *  unenclosed tower OTHER than the active target — peeking the next bag
 *  piece to validate fillability. Prevents the canonical NEAR_MISS_FLIP
 *  failure where the AI fills a far-away ring's gaps and runs out of build
 *  time before returning to close a 1–3 gap home/secondary ring. */
const cursorAnticipationRule: ScoringRule = {
  name: "cursor-anticipation",
  apply(candidate, _env, ctx) {
    return computeCursorAnticipationBonus(candidate, ctx);
  },
};
/** Bonus for placements near unowned zone towers (guides expansion). */
const towerProximityRule: ScoringRule = {
  name: "tower-proximity",
  apply(candidate, _env, ctx) {
    return computeTowerProximityBonus(
      candidate,
      ctx.targetGaps,
      ctx.zoneTowers,
      ctx.ownedTowers,
    );
  },
};
/** Hard-reject rules — return null to reject a candidate outright.
 *  Evaluated first; if any rejects, score contributions are skipped. */
const HARD_REJECT_RULES: readonly ScoringRule[] = [
  rejectIsolatedGapTiles,
  rejectFatWalls,
  rejectTinyPockets,
];
/** Score contribution rules — return a number to add to the candidate's score.
 *  Order does not matter (they're summed). */
const SCORE_CONTRIBUTION_RULES: readonly ScoringRule[] = [
  usefulGainRule,
  gapClosureRule,
  innerObstacleRule,
  difficultyRule,
  pocketPenaltyRule,
  obstacleHitRule,
  fatWallPenaltyRule,
  sweepSafeRule,
  cursorProximityRule,
  cursorAnticipationRule,
  towerProximityRule,
];
/** All scoring rules: hard-rejects first, then score contributions. */
const SCORING_RULES: readonly ScoringRule[] = [
  ...HARD_REJECT_RULES,
  ...SCORE_CONTRIBUTION_RULES,
];
/** Penalty per tile that would create a 2x2 fat wall block. */
export const FAT_WALL_TILE_PENALTY = 5;

export function compareByNumericScoreDesc<T extends { score: number }>(
  a: T,
  b: T,
): number {
  return b.score - a.score;
}

export function candidateObstacleHits(
  candidate: Pick<Candidate, "housesHit" | "bonusHit">,
  caresAboutHouses: boolean,
  caresAboutBonuses: boolean,
): number {
  return (
    (caresAboutHouses ? candidate.housesHit : 0) +
    (caresAboutBonuses ? candidate.bonusHit : 0)
  );
}

export function candidateToPlacement(candidate: Candidate): AiPlacement {
  return {
    piece: candidate.piece,
    row: candidate.row,
    col: candidate.col,
  };
}

/** Count 2×2 all-wall blocks a candidate would create (no exemptions). */
export function countFatBlocks(
  walls: ReadonlySet<TileKey>,
  candidate: Candidate,
  aliveHouseKeys: ReadonlySet<TileKey>,
): number {
  const { addedKeys, isWall } = buildCandidateWallInfo(
    walls,
    packCandidateTiles(candidate, aliveHouseKeys),
  );
  let blocks = 0;
  for (const key of addedKeys) {
    const { row, col } = unpackTile(key);
    if (tileCreatesFatBlock(row, col, isWall)) blocks++;
  }
  return blocks;
}

/** Cheap fat-wall check — no Set copy, just checks if placing creates 2×2
 *  blocks (`hasFatWall` / `gapClosingFat`) or the larger 2×3/3×2 all-wall
 *  RUN pattern (`hasFatRun`) that produces the visible touching-walls
 *  pathology. The RUN check has no gap-closing exemption — a placement
 *  that adds three adjacent doubled-wall cells is always rejected upstream,
 *  while the bare 2×2 case (length 2, single corner crossing) is tolerated
 *  for gap-fill candidates per the existing scorer trade-off. */
export function checkFatWall(
  walls: ReadonlySet<TileKey>,
  candidate: Candidate,
  aliveHouseKeys: ReadonlySet<TileKey>,
): { hasFatWall: boolean; hasFatRun: boolean; gapClosingFat: boolean } {
  const { addedKeys, isWall } = buildCandidateWallInfo(
    walls,
    packCandidateTiles(candidate, aliveHouseKeys),
  );
  let hasFatWall = false;
  let hasFatRun = false;
  let gapClosingFat = false;
  for (const key of addedKeys) {
    const { row, col } = unpackTile(key);
    if (tileCompletesFatRun(row, col, isWall)) {
      hasFatRun = true;
      // Upstream filter rejects regardless of remaining flags, but keep
      // computing so the scorer sees consistent state if it ever consumes
      // hasFatWall / gapClosingFat in the same pass.
    }
    if (!tileCreatesFatBlock(row, col, isWall)) continue;
    if (candidate.gapsFilled > 0) {
      gapClosingFat = true;
      continue;
    }
    hasFatWall = true;
  }
  return { hasFatWall, hasFatRun, gapClosingFat };
}

/** Evaluate territory-gain scoring on pre-filtered top candidates.
 *  Runs each ScoringRule per candidate; null = hard-reject, number = contribution. */
export function scoreTopCandidates(
  topCandidates: readonly Scored[],
  ctx: ScoringContext,
): ScoreTopResult {
  const batchHasWallAdjacent = topCandidates.some(
    (sc) => sc.candidate.wallAdjacent > 0 || sc.candidate.connectedTiles > 0,
  );

  let bestCandidate: Candidate | undefined;
  let bestScore = -Infinity;

  for (const {
    candidate,
    gapClosingFat,
    hasFatWall,
    fatBlocks,
  } of topCandidates) {
    const env = computeCandidateEnv(
      candidate,
      ctx,
      gapClosingFat,
      hasFatWall,
      fatBlocks,
      batchHasWallAdjacent,
    );

    let score = 0;
    let rejected = false;
    // null = hard-reject (skip remaining rules), 0 = no opinion, number = bonus/penalty.
    // See ScoringRule in ai-build-types.ts — null and 0 have different meanings.
    for (const rule of SCORING_RULES) {
      const contribution = rule.apply(candidate, env, ctx);
      if (contribution === null) {
        rejected = true;
        break;
      }
      score += contribution;
    }
    if (rejected) continue;

    if (
      bestCandidate === undefined ||
      score > bestScore ||
      (score === bestScore && candidate.gapsFilled > bestCandidate.gapsFilled)
    ) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  if (bestCandidate === undefined) return { evaluated: false };
  return { evaluated: true, bestCandidate, bestScore };
}

/** True when (r,c) is part of any 2×3 or 3×2 all-wall rectangle under the
 *  given `isWall` predicate. Two adjacent 2×2 blocks share three cells of a
 *  2×3, so this is equivalent to "two consecutive fat blocks side by side" —
 *  the minimum geometry that produces the visible ##/## stack or ####/####
 *  bar the user identified as the fat-wall pathology. */
function tileCompletesFatRun(
  r: number,
  c: number,
  isWall: (k: TileKey) => boolean,
): boolean {
  // Horizontal 2×3: top-left at (br, bc); (r,c) somewhere inside.
  for (let dRow = -1; dRow <= 0; dRow++) {
    for (let dCol = -2; dCol <= 0; dCol++) {
      const br = r + dRow;
      const bc = c + dCol;
      if (br < 0 || br + 1 >= GRID_ROWS) continue;
      if (bc < 0 || bc + 2 >= GRID_COLS) continue;
      if (
        isWall(packTile(br, bc)) &&
        isWall(packTile(br, bc + 1)) &&
        isWall(packTile(br, bc + 2)) &&
        isWall(packTile(br + 1, bc)) &&
        isWall(packTile(br + 1, bc + 1)) &&
        isWall(packTile(br + 1, bc + 2))
      ) {
        return true;
      }
    }
  }
  // Vertical 3×2.
  for (let dRow = -2; dRow <= 0; dRow++) {
    for (let dCol = -1; dCol <= 0; dCol++) {
      const br = r + dRow;
      const bc = c + dCol;
      if (br < 0 || br + 2 >= GRID_ROWS) continue;
      if (bc < 0 || bc + 1 >= GRID_COLS) continue;
      if (
        isWall(packTile(br, bc)) &&
        isWall(packTile(br, bc + 1)) &&
        isWall(packTile(br + 1, bc)) &&
        isWall(packTile(br + 1, bc + 1)) &&
        isWall(packTile(br + 2, bc)) &&
        isWall(packTile(br + 2, bc + 1))
      ) {
        return true;
      }
    }
  }
  return false;
}

function computeGapBonus(gapsFilled: number, usefulGain: number): number {
  if (gapsFilled <= 0) return 0;
  const base = Math.max(
    GAP_BONUS_MIN,
    GAP_BONUS_BASE - usefulGain * GAP_BONUS_GAIN_FACTOR,
  );
  return base + (gapsFilled - 1) * GAP_BONUS_PER_EXTRA;
}

function computeFatWallPenalty(
  gapClosingFat: boolean,
  hasFatWall: boolean,
  usefulGain: number,
  fatPenaltyScale: number,
): number {
  if (gapClosingFat) {
    return (
      Math.max(FAT_WALL_PENALTY_MIN, usefulGain * FAT_WALL_GAIN_FACTOR) *
      fatPenaltyScale
    );
  }
  if (hasFatWall) {
    return FAT_WALL_TILE_PENALTY * fatPenaltyScale;
  }
  return 0;
}

function computePocketPenalty(
  pocketDelta: number,
  pocketScale: number,
): number {
  return Math.max(0, pocketDelta) * POCKET_DELTA_PENALTY * pocketScale;
}

function computeObstacleHitPenalty(
  candidate: Pick<Candidate, "housesHit" | "bonusHit">,
  caresAboutHouses: boolean,
  caresAboutBonuses: boolean,
): number {
  return (
    (caresAboutHouses ? candidate.housesHit * OBSTACLE_HIT_PENALTY : 0) +
    (caresAboutBonuses ? candidate.bonusHit * OBSTACLE_HIT_PENALTY : 0)
  );
}

function computeTowerProximityBonus(
  candidate: Candidate,
  targetGaps: Set<TileKey>,
  zoneTowers: readonly Tower[],
  ownedTowers: readonly Tower[],
): number {
  if (targetGaps.size !== 0) return 0;

  let towerProximityBonus = 0;
  for (const tower of zoneTowers) {
    if (ownedTowers.includes(tower)) continue;
    for (const [dr, dc] of candidate.piece.offsets) {
      const distance = manhattanDistance(
        candidate.row + dr,
        candidate.col + dc,
        tower.row + 0.5,
        tower.col + 0.5,
      );
      towerProximityBonus = Math.max(
        towerProximityBonus,
        Math.max(0, TOWER_PROXIMITY_RANGE - distance) * TOWER_PROXIMITY_FACTOR,
      );
    }
  }

  return towerProximityBonus;
}

function computeSweepSafeBonus(
  candidate: Candidate,
  targetGaps: Set<TileKey>,
  simulatedWalls: Set<TileKey>,
): number {
  if (candidate.gapsFilled <= 0) return 0;

  let sweepSafeBonus = 0;
  for (const [dr, dc] of candidate.piece.offsets) {
    const pr = candidate.row + dr;
    const pc = candidate.col + dc;
    if (!inBounds(pr, pc)) continue;
    if (!targetGaps.has(packTile(pr, pc))) continue;
    let cardinalCount = 0;
    for (const [ar, ac] of DIRS_4) {
      const nr = pr + ar;
      const nc = pc + ac;
      if (!inBounds(nr, nc)) continue;
      if (simulatedWalls.has(packTile(nr, nc))) cardinalCount++;
    }
    if (cardinalCount >= 2) sweepSafeBonus += SWEEP_SAFE_BONUS;
  }

  return sweepSafeBonus;
}

function computeCursorProximityBonus(
  candidate: Candidate,
  batchHasWallAdjacent: boolean,
  cursorPos?: TilePos,
): number {
  if (batchHasWallAdjacent || candidate.gapsFilled <= 0 || !cursorPos) return 0;

  let avgDistance = 0;
  for (const [dr, dc] of candidate.piece.offsets) {
    avgDistance += manhattanDistance(
      candidate.row + dr,
      candidate.col + dc,
      cursorPos.row,
      cursorPos.col,
    );
  }
  avgDistance /= candidate.piece.offsets.length;
  return (
    Math.max(0, CURSOR_PROXIMITY_MAX - avgDistance) *
    CURSOR_PROXIMITY_MULTIPLIER
  );
}

function computeCursorAnticipationBonus(
  candidate: Candidate,
  ctx: ScoringContext,
): number {
  if (ctx.peekFitTargets.length === 0) return 0;
  let avgRow = 0;
  let avgCol = 0;
  for (const [dr, dc] of candidate.piece.offsets) {
    avgRow += candidate.row + dr;
    avgCol += candidate.col + dc;
  }
  const tileCount = candidate.piece.offsets.length;
  avgRow /= tileCount;
  avgCol /= tileCount;
  let minDist = Infinity;
  for (const target of ctx.peekFitTargets) {
    const dist =
      Math.abs(target.anchorRow - avgRow) + Math.abs(target.anchorCol - avgCol);
    if (dist < minDist) minDist = dist;
  }
  if (minDist === Infinity) return 0;
  return (
    Math.max(0, CURSOR_ANTICIPATION_MAX - minDist) * CURSOR_ANTICIPATION_WEIGHT
  );
}

function computeInnerObstacleBonus(
  candidate: Candidate,
  targetGaps: Set<TileKey>,
  castle: TileRect,
  tiles: readonly (readonly Tile[])[],
): number {
  if (candidate.gapsFilled < 2) return 0;

  let hasInnerObstacle = false;
  for (const [dr, dc] of candidate.piece.offsets) {
    const pr = candidate.row + dr;
    const pc = candidate.col + dc;
    const key = packTile(pr, pc);
    if (!targetGaps.has(key)) continue;
    for (const [ar, ac] of DIRS_4) {
      const nr = pr + ar;
      const nc = pc + ac;
      if (
        nr >= castle.top &&
        nr <= castle.bottom &&
        nc >= castle.left &&
        nc <= castle.right &&
        isWater(tiles, nr, nc)
      ) {
        hasInnerObstacle = true;
      }
    }
  }

  if (!hasInnerObstacle) return 0;

  const { inside: innerTiles } = countNonGapTilesInCastle(
    candidate,
    targetGaps,
    castle,
  );

  return innerTiles * INNER_OBSTACLE_MULTIPLIER;
}

function computeDifficultyBonus(
  state: BuildViewState,
  candidate: Candidate,
): number {
  if (candidate.piece.offsets.length !== 1 || candidate.gapsFilled !== 1)
    return 0;

  const pr = candidate.row + candidate.piece.offsets[0]![0];
  const pc = candidate.col + candidate.piece.offsets[0]![1];
  // Track obstacle directions: [north, south, west, east]
  const obstacles = computeCardinalObstacleMask(state, pr, pc);
  const total = obstacles.filter(Boolean).length;
  const hasOpposite =
    (obstacles[0] && obstacles[1]) || (obstacles[2] && obstacles[3]);
  if (total >= 2 && hasOpposite) return total * DIFFICULTY_MULTIPLIER;
  if (total >= 1) return total;
  return 0;
}

function computeWastefulClosureAdjustment(
  candidate: Candidate,
  targetGaps: Set<TileKey>,
  castle: TileRect,
  usefulGain: number,
  baseGapBonus: number,
): { gapBonus: number; wastefulClosurePenalty: number } {
  if (candidate.gapsFilled <= 0 || castle.top > castle.bottom) {
    return { gapBonus: baseGapBonus, wastefulClosurePenalty: 0 };
  }

  const { inside: insideNonGap, outside: outsideNonGap } =
    countNonGapTilesInCastle(candidate, targetGaps, castle);

  if (outsideNonGap === 0 && insideNonGap > candidate.gapsFilled) {
    return {
      gapBonus: 0,
      wastefulClosurePenalty: usefulGain + insideNonGap,
    };
  }

  return { gapBonus: baseGapBonus, wastefulClosurePenalty: 0 };
}

function shouldRejectForFatWalls(
  rawFatBlocks: number,
  fatGainPerBlock: number,
  usefulGain: number,
  fatExempt: boolean,
): boolean {
  return (
    rawFatBlocks > 0 &&
    fatGainPerBlock > 0 &&
    usefulGain < rawFatBlocks * fatGainPerBlock &&
    !fatExempt
  );
}

/** Build the added-key set and wall predicate for a candidate placement. */
function buildCandidateWallInfo(
  walls: ReadonlySet<TileKey>,
  addedKeys: TileKey[],
): { addedKeys: TileKey[]; isWall: (k: TileKey) => boolean } {
  const addedSet = new Set(addedKeys);
  const isWall = (k: TileKey) => walls.has(k) || addedSet.has(k);
  return { addedKeys, isWall };
}

/** Check if a tile creates any 2x2 all-wall block when added to existing walls. */
function tileCreatesFatBlock(
  r: number,
  c: number,
  isWall: (k: TileKey) => boolean,
): boolean {
  for (const [cr, cc] of CORNERS_2X2) {
    const tr = r + cr,
      tc = c + cc;
    if (tr < 0 || tr + 1 >= GRID_ROWS || tc < 0 || tc + 1 >= GRID_COLS)
      continue;
    if (
      isWall(packTile(tr, tc)) &&
      isWall(packTile(tr, tc + 1)) &&
      isWall(packTile(tr + 1, tc)) &&
      isWall(packTile(tr + 1, tc + 1))
    ) {
      return true;
    }
  }
  return false;
}

/** Count non-gap candidate tiles inside vs outside the castle rect. */
function countNonGapTilesInCastle(
  candidate: Candidate,
  targetGaps: Set<TileKey>,
  castle: TileRect,
): { inside: number; outside: number } {
  let inside = 0;
  let outside = 0;
  for (const [dr, dc] of candidate.piece.offsets) {
    const pr = candidate.row + dr;
    const pc = candidate.col + dc;
    if (targetGaps.has(packTile(pr, pc))) continue;
    if (
      pr >= castle.top &&
      pr <= castle.bottom &&
      pc >= castle.left &&
      pc <= castle.right
    ) {
      inside++;
    } else {
      outside++;
    }
  }
  return { inside, outside };
}

/** Build the per-candidate environment used by scoring rules.
 *  Computed once per candidate after the cheap pre-filter passes. */
function computeCandidateEnv(
  candidate: Candidate,
  ctx: ScoringContext,
  gapClosingFat: boolean,
  hasFatWall: boolean,
  fatBlocks: number,
  batchHasWallAdjacent: boolean,
): CandidateEnv {
  const candidateWallTiles = packCandidateTiles(candidate, ctx.aliveHouseKeys);
  const simulatedWalls = createSimulatedWalls(ctx.walls, candidateWallTiles);
  const simulatedOutside = computeOutsideAfterAdd(
    ctx.outside,
    candidateWallTiles,
  );
  const rawGain = ctx.baselineOutside - simulatedOutside.size;
  const pieceTiles = candidate.piece.offsets.length;
  const usefulGain = rawGain - pieceTiles;
  const pocketInfo = countSmallPocketTiles(simulatedWalls, simulatedOutside);
  const pocketDelta = pocketInfo.wasted - ctx.baselinePocketWaste;
  return {
    simulatedWalls,
    simulatedOutside,
    usefulGain,
    pocketDelta,
    pocketInfo,
    gapClosingFat,
    hasFatWall,
    fatBlocks,
    batchHasWallAdjacent,
  };
}

/** Pack the WALL tiles of a candidate placement into a TileKey[]. Piece
 *  offsets that overlap an alive house are excluded — those tiles spawn
 *  a grunt instead of laying a wall (see `applyPiecePlacement`), so
 *  every simulated-wall predictor that consumes this set must agree.
 *  Hot path: called per candidate by every scoring stage. */
export function packCandidateTiles(
  candidate: Candidate,
  aliveHouseKeys: ReadonlySet<TileKey>,
): TileKey[] {
  const tiles: TileKey[] = [];
  for (const [dr, dc] of candidate.piece.offsets) {
    const key = packTile(candidate.row + dr, candidate.col + dc);
    if (aliveHouseKeys.has(key)) continue;
    tiles.push(key);
  }
  return tiles;
}

export function countSmallPocketTiles(
  walls: ReadonlySet<TileKey>,
  outsideSet: Set<TileKey>,
): { wasted: number; smallestPocket: number } {
  let wasted = 0;
  let smallestPocket = Infinity;
  const visited = new Set<TileKey>();
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const key = packTile(r, c);
      if (visited.has(key) || outsideSet.has(key) || walls.has(key)) continue;
      const pocket = floodPocket(key, visited, walls, outsideSet);
      if (pocket.length < SMALL_POCKET_MAX_SIZE) {
        wasted += pocket.length;
        if (pocket.length < smallestPocket) smallestPocket = pocket.length;
      }
    }
  }
  return { wasted, smallestPocket };
}

/** Build the simulated wall set for a candidate's pre-packed tiles. */
function createSimulatedWalls(
  walls: ReadonlySet<TileKey>,
  candidateWallTiles: readonly TileKey[],
): Set<TileKey> {
  const simulatedWalls = new Set(walls);
  for (const key of candidateWallTiles) simulatedWalls.add(key);
  return simulatedWalls;
}
