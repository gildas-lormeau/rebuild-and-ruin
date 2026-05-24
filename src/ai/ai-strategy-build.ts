/**
 * AI build-phase placement orchestrator: pick a target ring
 * (ai-build-target), enumerate candidates, score (ai-build-score), fall back
 * (ai-build-shared). Castle rectangle + gap analysis live in ai-castle-rect.
 */

import {
  buildPlacementContext,
  canPlacePiece,
  createCastle,
  effectivePlanTiles,
  type PlacementContext,
} from "../game/index.ts";
import {
  buildOccupancyCache,
  collectAliveHouseKeys,
  hasAliveHouseAt,
  type OccupancyCache,
} from "../shared/core/board-occupancy.ts";
import type { Castle, Tower, TowerIdx } from "../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, type TileKey } from "../shared/core/grid.ts";
import { type PieceShape, rotateCW } from "../shared/core/pieces.ts";
import { getInterior } from "../shared/core/player-interior.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import {
  computeOutside,
  DIRS_4,
  inBounds,
  packTile,
  towerReachesOutsideCardinal,
} from "../shared/core/spatial.ts";
import type { BuildViewState } from "../shared/core/system-interfaces.ts";
import { emitWallPlacedDiag } from "./ai-build-diag.ts";
import {
  candidateObstacleHits,
  candidateToPlacement,
  checkFatWall,
  compareByNumericScoreDesc,
  countFatBlocks,
  countSmallPocketTiles,
  FAT_WALL_TILE_PENALTY,
  scoreTopCandidates,
} from "./ai-build-score.ts";
import {
  createsSmallEnclosure,
  memoize,
  pickFallbackPlacement,
} from "./ai-build-shared.ts";
import {
  adjustInterior,
  MANAGEABLE_GAP_LIMIT,
  selectTarget,
} from "./ai-build-target.ts";
import type {
  AiPlacement,
  Candidate,
  EnclosureAnalysis,
  FallbackContext,
  PlacementOptions,
  Scored,
  ScoringContext,
} from "./ai-build-types.ts";
import { findGapTiles, hasMeaningfulHomeRingGaps } from "./ai-castle-rect.ts";

type BuildSkillConfig = (typeof BUILD_SKILL_TABLE)[number];

export interface PickPlacementResult {
  placement: AiPlacement | null;
  /** Tower committed to by trySecondaryTower this tick (undefined for home
   *  repair, expand-territory, or any path that didn't cache). The caller
   *  (DefaultStrategy) stores this and passes it back via PlacementOptions
   *  on the next tick to drive the persistence short-circuit. */
  chosenTowerIndex: TowerIdx | undefined;
}

const NO_PLACEMENT: PickPlacementResult = {
  placement: null,
  chosenTowerIndex: undefined,
};
/** Max gap tiles before AI deprioritizes home tower in favor of other unenclosed towers. */
const HOME_GAP_REPAIR_THRESHOLD = 5;
/** Score weight per gap tile filled by a placement. */
const GAP_FILLED_WEIGHT = 100;
/** Score weight per tile adjacent to a gap (supports gap closure). */
const GAP_ADJACENT_WEIGHT = 20;
/** Score weight per tile connected to existing walls. */
const CONNECTED_TILES_WEIGHT = 10;
const BUILD_SKILL_TABLE = [
  /*1*/ {
    topCandidates: 12,
    fatGainPerBlock: 0,
    pocketScale: 0.25,
    fatPenaltyScale: 0.25,
    tinyPocketReject: false,
  },
  /*2*/ {
    topCandidates: 20,
    fatGainPerBlock: 1,
    pocketScale: 0.5,
    fatPenaltyScale: 0.5,
    tinyPocketReject: false,
  },
  /*3*/ {
    topCandidates: 30,
    fatGainPerBlock: 2,
    pocketScale: 0.75,
    fatPenaltyScale: 0.75,
    tinyPocketReject: true,
  },
  /*4*/ {
    topCandidates: 36,
    fatGainPerBlock: 2,
    pocketScale: 1.0,
    fatPenaltyScale: 1.0,
    tinyPocketReject: true,
  },
  /*5*/ {
    topCandidates: 40,
    fatGainPerBlock: 3,
    pocketScale: 1.25,
    fatPenaltyScale: 1.25,
    tinyPocketReject: true,
  },
] as const;

export function pickPlacement(
  state: BuildViewState,
  playerId: ValidPlayerId,
  piece: PieceShape,
  options: PlacementOptions,
): PickPlacementResult {
  const {
    cursorPos,
    homeWasBroken,
    castleMargin,
    bankHugging,
    caresAboutHouses,
    caresAboutBonuses,
    buildSkill,
    outerRingHolesSnapshot,
    lastTargetTowerIndex,
  } = options;
  const maybePlayer = state.players[playerId];
  if (!maybePlayer || maybePlayer.castleWallTiles.size === 0) {
    return NO_PLACEMENT;
  }
  const player = maybePlayer;
  // Recompute the home castle rect on demand. Selection used the same
  // algorithm against the modifier-projected tiles; passing
  // `effectivePlanTiles(state)` here keeps AI scoring aligned with the
  // actual walls while the same modifier is active. After a modifier
  // clears between selection and now, the recomputed rect drifts to the
  // natural-shoreline shape — bounded suboptimality, never desync.
  if (!player.homeTower) {
    return NO_PLACEMENT;
  }
  const castle = createCastle(
    player.homeTower,
    effectivePlanTiles(state),
    state.map.towers,
  );

  // Skill-derived parameters (level 1 = clumsy, 5 = clean builder)
  //   topCandidates:    how many placements get full territory-gain evaluation
  //   fatGainPerBlock:  useful-gain required per 2×2 fat block to pass hard reject
  //   pocketScale:      multiplier on pocket delta penalty
  //   fatPenaltyScale:  multiplier on fat wall scoring penalty
  //   tinyPocketReject: whether tiny-pocket hard reject is active
  const skill = getBuildSkillConfig(buildSkill);
  const {
    outside,
    homeTowerEnclosed,
    zoneTowers,
    unenclosedTowers,
    otherUnenclosed,
    allCastlesEnclosed,
    effectiveSkipHome,
    homeHasRingGaps,
  } = analyzeEnclosures(state, player, castle, homeWasBroken);
  const walls = player.walls;

  // Build the occupancy cache + placement context once per pickPlacement.
  // Every sub-helper that walks candidates (enumerateCandidates,
  // canPieceFillAnyGap, plugUnreachableGaps) reads these — without this
  // hoist they get rebuilt up to ~10 times per tick during target selection.
  // State is read-only during pickPlacement so memoization is safe.
  const cache = buildOccupancyCache(state);
  const placementCtx = buildPlacementContext(state, playerId);
  if (!placementCtx) return NO_PLACEMENT;

  // Step 1: determine which rectangle to build/repair.
  // Pipeline: tryRepairHomeCastle → trySecondaryTower → tryExpandTerritory
  // Each phase only runs if the previous one found no gaps.
  const { targetGaps, targetRect, chosenTowerIndex } = selectTarget({
    state,
    playerId,
    player,
    castle,
    piece,
    castleMargin,
    bankHugging,
    cursorPos,
    effectiveSkipHome,
    homeHasRingGaps,
    allCastlesEnclosed,
    unenclosedTowers,
    otherUnenclosed,
    outerRingHolesSnapshot,
    lastTargetTowerIndex,
    cache,
    placementCtx,
  });
  // Step 2: score candidates
  const baselineOutside = outside.size;

  // Interior excluding gaps and castle-rect tiles — lets the AI place pieces
  // freely inside an open (gapped) enclosure. Without this exclusion, scoring
  // would penalize placements near gaps that need filling.
  const interiorExcludingGaps = adjustInterior(
    getInterior(player),
    targetGaps,
    targetRect,
  );

  const allCandidates = enumerateCandidates(
    state,
    playerId,
    piece,
    player.walls,
    outside,
    targetGaps,
    cache,
    placementCtx,
    interiorExcludingGaps,
  );
  if (allCandidates.length === 0) {
    return { placement: null, chosenTowerIndex };
  }

  // Step 3: pick best using territory gain
  const baselinePocketWaste = countSmallPocketTiles(
    player.walls,
    outside,
  ).wasted;

  const noTargetGaps = allCastlesEnclosed && targetGaps.size === 0;
  const noBuildTargets = noTargetGaps && unenclosedTowers.length === 0;
  const aliveHouseKeys = collectAliveHouseKeys(state);
  const scored = prescoreCandidates(
    allCandidates,
    player.walls,
    noTargetGaps,
    aliveHouseKeys,
  );

  const scoringCtx: ScoringContext = {
    state,
    walls,
    outside,
    targetGaps,
    castle,
    cursorPos,
    zoneTowers,
    ownedTowers: player.ownedTowers,
    skill,
    caresAboutHouses,
    caresAboutBonuses,
    allCastlesEnclosed,
    homeTowerEnclosed,
    homeWasBroken,
    baselineOutside,
    baselinePocketWaste,
    aliveHouseKeys,
  };

  const placement = selectBestPlacement(scored, allCandidates, scoringCtx, {
    player,
    castle,
    castleMargin,
    unenclosedTowers,
    noBuildTargets,
    hasManageableGaps:
      targetGaps.size > 0 && targetGaps.size <= MANAGEABLE_GAP_LIMIT,
  });
  if (placement !== null) {
    let cellsOnRingPerimeter = 0;
    if (targetRect !== null) {
      const ringTop = targetRect.top - 1;
      const ringBottom = targetRect.bottom + 1;
      const ringLeft = targetRect.left - 1;
      const ringRight = targetRect.right + 1;
      for (const [dr, dc] of placement.piece.offsets) {
        const r = placement.row + dr;
        const c = placement.col + dc;
        const inRingBox =
          r >= ringTop && r <= ringBottom && c >= ringLeft && c <= ringRight;
        const onRingEdge =
          r === ringTop ||
          r === ringBottom ||
          c === ringLeft ||
          c === ringRight;
        if (inRingBox && onRingEdge) cellsOnRingPerimeter++;
      }
    }
    emitWallPlacedDiag(
      playerId,
      state.round,
      placement.piece.offsets.map(([dr, dc]) =>
        packTile(placement.row + dr, placement.col + dc),
      ),
      targetGaps,
      targetRect,
      cellsOnRingPerimeter,
      placement.piece.name,
    );
  }
  return { placement, chosenTowerIndex };
}

/** Pick the best placement from scored candidates, with gap-filler priority and fallback. */
function selectBestPlacement(
  scored: readonly Scored[],
  allCandidates: readonly Candidate[],
  scoringCtx: ScoringContext,
  extras: {
    player: Player;
    castle: Castle;
    castleMargin: number;
    unenclosedTowers: readonly Tower[];
    noBuildTargets: boolean;
    hasManageableGaps: boolean;
  },
): AiPlacement | null {
  const {
    walls,
    outside,
    state,
    allCastlesEnclosed,
    caresAboutHouses,
    caresAboutBonuses,
    aliveHouseKeys,
  } = scoringCtx;
  const { player, castle, noBuildTargets, hasManageableGaps } = extras;

  const fatBlockCountFor = memoize((candidate: Candidate) =>
    countFatBlocks(walls, candidate, aliveHouseKeys),
  );

  if (scored.length === 0) {
    return selectFromEmptyScored(
      allCandidates,
      scoringCtx,
      noBuildTargets,
      fatBlockCountFor,
    );
  }

  const sortedScored = [...scored].sort((a, b) => b.score - a.score);
  let topCandidates = sortedScored.slice(0, scoringCtx.skill.topCandidates);

  // When the target has manageable gaps (1-8) and at least one candidate fills
  // a gap, restrict the final scoring to gap-filling candidates only.
  // This prevents territory gain elsewhere from out-scoring the gap closure.
  // Threshold matches canPieceFillAnyGap — if the piece CAN fill a gap, it SHOULD.
  let restrictedToGapFillers = false;
  if (hasManageableGaps) {
    const sortedGapFillers = sortedScored.filter(
      (score) => score.candidate.gapsFilled > 0,
    );
    if (sortedGapFillers.length > 0) {
      topCandidates = sortedGapFillers.slice(0, scoringCtx.skill.topCandidates);
      restrictedToGapFillers = true;
    }
  }

  const scoreResult = scoreTopCandidates(topCandidates, scoringCtx);

  const fallbackBuildCtx: FallbackContext = {
    walls: player.walls,
    outside,
    playerInterior: getInterior(player),
    castle,
    castleMargin: extras.castleMargin,
    homeWasBroken: scoringCtx.homeWasBroken,
    unenclosedTowers: extras.unenclosedTowers,
    caresAboutHouses,
    caresAboutBonuses,
    aliveHouseKeys,
  };

  // No candidate evaluated (empty batch or every top candidate hard-rejected
  // by SCORING_RULES — typically rejectIsolatedGapTiles / rejectFatWalls /
  // rejectTinyPockets). The hard-rejects guard against imperfect placements
  // (isolated bridges, fat walls without usefulGain, tiny trapped pockets);
  // they're meant to nudge the AI toward cleaner choices, not to block it
  // from ever building when there's a real target. When the AI has a target
  // with gap-fillers available but every one fails a hard-reject, falling to
  // `pickFallbackPlacement` (which scans the FULL candidate pool — gap-fillers
  // and non-gap-fillers alike) scatters walls across the map and the target
  // never closes, recurring tick after tick. Prefer the highest-pre-score
  // gap-filler from `sortedScored` instead: closing the ring is more valuable
  // than the cosmetics the hard-rejects were optimizing for. Falls back to
  // `pickFallbackPlacement` only when no gap-filler exists at all.
  if (!scoreResult.evaluated) {
    if (noBuildTargets) return null;
    const topGapFiller = sortedScored.find(
      (entry) => entry.candidate.gapsFilled > 0,
    );
    if (topGapFiller) return candidateToPlacement(topGapFiller.candidate);
    return pickFallbackPlacement(sortedScored, state, fallbackBuildCtx)
      .placement;
  }

  const { bestCandidate, bestScore } = scoreResult;

  // All enclosed, no gaps, no towers to build toward — still allow
  // expansion if scoring found a positive placement (new large enclosure).
  // rejectTinyPockets already filtered out small-pocket candidates at
  // skill ≥ 3, so bestScore > 0 means genuinely useful territory gain.
  if (noBuildTargets && bestScore <= 0) return null;

  // Gap-filling was the priority but territory gain was ≤ 0 — still use the
  // best gap-filler by first-pass score (closing the ring IS the goal).
  // Reject fat walls even here — a gap-fill that creates 2×2 blocks without
  // enclosing territory is wasteful.
  if (bestScore <= 0 && restrictedToGapFillers) {
    if (fatBlockCountFor(bestCandidate) === 0) {
      return candidateToPlacement(bestCandidate);
    }
    // Fat wall gap-filler — find a non-fat alternative among gap fillers
    const nonFatGapFillers = topCandidates.filter(
      (score) =>
        score.candidate.gapsFilled > 0 &&
        fatBlockCountFor(score.candidate) === 0,
    );
    if (nonFatGapFillers.length > 0) {
      nonFatGapFillers.sort(compareByNumericScoreDesc);
      return candidateToPlacement(nonFatGapFillers[0]!.candidate);
    }
    // All gap fillers are fat — accept the best one anyway if the ring
    // is still open, because closing the castle outweighs the fat penalty.
    if (!allCastlesEnclosed) {
      return candidateToPlacement(bestCandidate);
    }
  }

  // If no territory gain: discard or build toward unenclosed towers
  if (bestScore <= 0) {
    return pickFallbackPlacement(sortedScored, state, fallbackBuildCtx)
      .placement;
  }

  return {
    piece: bestCandidate.piece,
    row: bestCandidate.row,
    col: bestCandidate.col,
  };
}

/** Fallback when prescoreCandidates yielded zero scored entries (every
 *  candidate was filtered for fat walls under noTargetGaps). Bucket into
 *  open / no-fat-not-open / rest tiers and return the best of the first
 *  non-empty tier. Mutually exclusive with the territory-gain path — this
 *  branch only fires when there's nothing legitimate to score. */
function selectFromEmptyScored(
  allCandidates: readonly Candidate[],
  scoringCtx: ScoringContext,
  noBuildTargets: boolean,
  fatBlockCountFor: (candidate: Candidate) => number,
): AiPlacement | null {
  const {
    walls,
    outside,
    state,
    caresAboutHouses,
    caresAboutBonuses,
    aliveHouseKeys,
  } = scoringCtx;
  // When everything is enclosed with no gaps, don't force-place fat walls
  if (noBuildTargets) {
    return null;
  }
  const isSmallEnclosure = memoize((candidate: Candidate) =>
    createsSmallEnclosure(candidate, walls, outside, state, aliveHouseKeys),
  );

  // Bucket candidates into descending-preference tiers in a single pass.
  // Each tier subsumes the next's qualification (open ⊂ noFatNotOpen ⊂ rest).
  // We only sort the tier we end up returning from.
  const open: Candidate[] = [];
  const noFatNotOpen: Candidate[] = [];
  const rest: Candidate[] = [];
  for (const candidate of allCandidates) {
    const cleanFat = fatBlockCountFor(candidate) === 0;
    const cleanShape = cleanFat && !isSmallEnclosure(candidate);
    if (cleanShape && candidate.wallAdjacent === 0) {
      open.push(candidate);
    } else if (cleanShape) {
      noFatNotOpen.push(candidate);
    } else {
      rest.push(candidate);
    }
  }
  if (open.length > 0) {
    open.sort(
      (a, b) =>
        candidateObstacleHits(a, caresAboutHouses, caresAboutBonuses) -
        candidateObstacleHits(b, caresAboutHouses, caresAboutBonuses),
    );
    return candidateToPlacement(open[0]!);
  }
  if (noFatNotOpen.length > 0) {
    return candidateToPlacement(noFatNotOpen[0]!);
  }
  // Last resort: prefer no small enclosure, then fewer fat blocks
  rest.sort((a, b) => {
    const aEncloses = isSmallEnclosure(a) ? 1 : 0;
    const bEncloses = isSmallEnclosure(b) ? 1 : 0;
    if (aEncloses !== bEncloses) return aEncloses - bEncloses;
    return fatBlockCountFor(a) - fatBlockCountFor(b);
  });
  return candidateToPlacement(rest[0]!);
}

/** Look up skill config by 1-based buildSkill level (1=clumsy, 5=clean). */
function getBuildSkillConfig(buildSkill: 1 | 2 | 3 | 4 | 5): BuildSkillConfig {
  return BUILD_SKILL_TABLE[buildSkill - 1]!;
}

/** Enumerate all valid placements for a piece, scoring adjacency/gap metrics. */
function enumerateCandidates(
  state: BuildViewState,
  playerId: ValidPlayerId,
  piece: PieceShape,
  walls: ReadonlySet<TileKey>,
  outside: Set<TileKey>,
  targetGaps: Set<TileKey>,
  cache: OccupancyCache,
  placementCtx: PlacementContext,
  interiorExcludingGaps: Set<TileKey>,
): Candidate[] {
  const candidates: Candidate[] = [];
  const bonusKeys = new Set<TileKey>();
  for (const bonus of state.bonusSquares)
    bonusKeys.add(packTile(bonus.row, bonus.col));
  let rotated = piece;
  for (let rotation = 0; rotation < 4; rotation++) {
    for (let r = 0; r < GRID_ROWS - rotated.height + 1; r++) {
      for (let c = 0; c < GRID_COLS - rotated.width + 1; c++) {
        if (
          !canPlacePiece(
            state,
            playerId,
            rotated.offsets,
            r,
            c,
            interiorExcludingGaps,
            cache,
            placementCtx,
          )
        )
          continue;

        const {
          gapsFilled,
          wallAdjacent,
          connectedTiles,
          gapAdjacent,
          isolated,
        } = scoreCandidateGapMetrics(r, c, rotated.offsets, walls, targetGaps);

        if (rotated.offsets.length > 1) {
          let anyOutsideOrGap = false;
          for (const [dr, dc] of rotated.offsets) {
            const k = packTile(r + dr, c + dc);
            if (outside.has(k) || targetGaps.has(k)) {
              anyOutsideOrGap = true;
              break;
            }
          }
          if (!anyOutsideOrGap) continue;
        }

        let housesHit = 0;
        let bonusHit = 0;
        for (const [dr, dc] of rotated.offsets) {
          const pr = r + dr,
            pc = c + dc;
          if (hasAliveHouseAt(state, pr, pc)) housesHit++;
          if (bonusKeys.has(packTile(pr, pc))) bonusHit++;
        }
        // Every offset on an alive house means zero walls will be laid
        // (applyPiecePlacement filters house tiles out of wallKeys) and
        // grunts spawn against the placing player. Strictly bad — reject.
        if (housesHit === rotated.offsets.length) continue;

        candidates.push({
          row: r,
          col: c,
          piece: rotated,
          gapsFilled,
          wallAdjacent,
          connectedTiles,
          gapAdjacent,
          isolated,
          housesHit,
          bonusHit,
        });
      }
    }
    rotated = rotateCW(rotated);
  }
  return candidates;
}

/** Score all candidates with gap/wall/fat-wall metrics; filter fat walls when no gaps remain. */
function prescoreCandidates(
  allCandidates: readonly Candidate[],
  walls: ReadonlySet<TileKey>,
  noTargetGaps: boolean,
  aliveHouseKeys: ReadonlySet<TileKey>,
): Scored[] {
  const scored: Scored[] = [];
  for (const candidate of allCandidates) {
    const { hasFatWall, gapClosingFat } = checkFatWall(
      walls,
      candidate,
      aliveHouseKeys,
    );

    if (noTargetGaps && (hasFatWall || gapClosingFat)) continue;

    const fatBlocks = countFatBlocks(walls, candidate, aliveHouseKeys);

    scored.push({
      candidate,
      score:
        candidate.gapsFilled * GAP_FILLED_WEIGHT +
        candidate.gapAdjacent * GAP_ADJACENT_WEIGHT +
        candidate.connectedTiles * CONNECTED_TILES_WEIGHT +
        candidate.wallAdjacent -
        (hasFatWall ? FAT_WALL_TILE_PENALTY : 0),
      gapClosingFat,
      hasFatWall,
      fatBlocks,
    });
  }
  return scored;
}

/** Analyze board enclosures: which towers are open, whether to skip home, etc. */
function analyzeEnclosures(
  state: BuildViewState,
  player: Player,
  castle: Castle,
  homeWasBroken: boolean,
): EnclosureAnalysis {
  const zoneTowers = state.map.towers.filter(
    (tower) => tower.zone === castle.tower.zone,
  );

  // `outside` is still needed for the 4-dir diagonal-leak disambiguation
  // (towerReachesOutsideCardinal) and for hasMeaningfulHomeRingGaps. The
  // 8-dir "is this tower enclosed by my walls" question is answered by
  // player.ownedTowers, which recheckTerritory keeps in sync via the same
  // computeOutside-derived interior.
  const outside = computeOutside(player.walls);
  const ownedTowerSet = new Set(player.ownedTowers.map((tower) => tower.index));
  const homeTowerEnclosed = ownedTowerSet.has(castle.tower.index);
  // 4-dir BFS from a tower: returns true if the BFS can reach the map
  // border without crossing walls.
  const unenclosedTowers = zoneTowers.filter((tower) => {
    if (!ownedTowerSet.has(tower.index)) {
      // 8-dir flood says not enclosed but 4-dir BFS can't reach the map
      // border — the tower has a diagonal-only leak (e.g. two walls form
      // a diagonal step where 8-dir flood passes between them, but no
      // single ring tile is open). The ideal castle rect's
      // findReachableRingGaps will report zero gaps in this case (no ring
      // tile to fill), but the tower is genuinely leaking and territory
      // isn't being counted. Include it in unenclosedTowers anyway so
      // `noBuildTargets` doesn't fire and the AI's normal scoring (via
      // `usefulGainRule`, which rewards placements that shrink `outside`)
      // can find the plug tile — usually a single interior cell that
      // blocks the diagonal step. Previously this branch returned `false`
      // to "treat as enclosed", which left the AI idle for the whole build
      // phase: no target, noBuildTargets=true, fat-wall candidates pruned
      // by prescoreCandidates, scored.length=0, placement=null.
      return true;
    }
    // 8-directional flood says enclosed, but diagonal wall connections can
    // create false positives. Verify with 4-directional BFS from the tower:
    // if we can reach an "outside" tile, the tower isn't truly enclosed.
    if (towerReachesOutsideCardinal(tower, player.walls, outside)) return true;
    // Truly enclosed (BFS confirmed) — territory will count this tower.
    return false;
  });
  const allCastlesEnclosed = unenclosedTowers.length === 0;

  // If home was broken or its tower is dead, deprioritize it if there are other unenclosed towers
  // But only skip if the gap is large (> 5 tiles) — small holes are worth repairing
  const homeTowerDead = !state.towerAlive[castle.tower.index];
  const otherUnenclosed = unenclosedTowers.filter(
    (tower) => tower !== castle.tower,
  );
  let effectiveSkipHome =
    (homeWasBroken || homeTowerDead) && otherUnenclosed.length > 0;
  if (effectiveSkipHome && !homeTowerEnclosed) {
    const homeGaps = findGapTiles(castle, player.walls);
    if (homeGaps.size <= HOME_GAP_REPAIR_THRESHOLD) effectiveSkipHome = false;
  }

  const homeHasRingGaps = hasMeaningfulHomeRingGaps(
    homeTowerEnclosed,
    castle,
    player.walls,
    outside,
    state,
    getInterior(player),
  );

  return {
    outside,
    homeTowerEnclosed,
    zoneTowers,
    unenclosedTowers,
    otherUnenclosed,
    allCastlesEnclosed,
    effectiveSkipHome,
    homeHasRingGaps,
  };
}

function scoreCandidateGapMetrics(
  row: number,
  col: number,
  offsets: ReadonlyArray<readonly [number, number]>,
  walls: ReadonlySet<TileKey>,
  targetGaps: Set<TileKey>,
): {
  gapsFilled: number;
  wallAdjacent: number;
  connectedTiles: number;
  gapAdjacent: number;
  isolated: number;
} {
  let gapsFilled = 0;
  let wallAdjacent = 0;
  let connectedTiles = 0;
  let gapAdjacent = 0;
  let isolated = 0;

  for (const [dr, dc] of offsets) {
    const pr = row + dr;
    const pc = col + dc;
    if (!inBounds(pr, pc)) continue;
    const key = packTile(pr, pc);
    if (targetGaps.has(key)) {
      gapsFilled++;
      continue;
    }
    let hasWallAdjacent = false;
    let hasGapAdjacent = false;
    for (const [ar, ac] of DIRS_4) {
      const nr = pr + ar;
      const nc = pc + ac;
      if (!inBounds(nr, nc)) continue;
      const neighborKey = packTile(nr, nc);
      if (walls.has(neighborKey)) {
        wallAdjacent++;
        hasWallAdjacent = true;
      }
      if (targetGaps.has(neighborKey)) hasGapAdjacent = true;
    }
    if (hasWallAdjacent) connectedTiles++;
    if (hasGapAdjacent) gapAdjacent++;
    if (!hasWallAdjacent && !hasGapAdjacent) isolated++;
  }

  for (const [dr, dc] of offsets) {
    const pr = row + dr;
    const pc = col + dc;
    if (!inBounds(pr, pc)) continue;
    if (!targetGaps.has(packTile(pr, pc))) continue;
    let hasWallAdjacent = false;
    for (const [ar, ac] of DIRS_4) {
      const nr = pr + ar;
      const nc = pc + ac;
      if (!inBounds(nr, nc)) continue;
      if (walls.has(packTile(nr, nc))) {
        wallAdjacent++;
        hasWallAdjacent = true;
      }
    }
    if (hasWallAdjacent) connectedTiles++;
  }

  return { gapsFilled, wallAdjacent, connectedTiles, gapAdjacent, isolated };
}
